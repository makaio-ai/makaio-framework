import fs from 'node:fs';
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import {
  type AdapterEntity,
  type ClientEntity,
  type EntityGraph,
  type ProviderEntity,
  buildEntityGraph,
} from './entity-graph';
import { convertGitHubCallouts, normalizeReadmeRelativeLinks, stripLeadingBlockquotes } from './readme-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
// Astro may invoke integration hooks from the repo root or the website package;
// generated content is anchored to this integration package either way.
const WEBSITE_DOCS_DIR = path.resolve(import.meta.dirname, '..', 'src', 'content', 'docs');

const YAML_RESERVED_VALUE = /[":{}[\],&*?|>!%#@`]/;
const YAML_RESERVED_PREFIX = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_MULTILINE = /[\n\r]/;
const YAML_EDGE_WHITESPACE = /^\s|\s$/;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Escapes a value for safe use in YAML frontmatter.
 * @param value - Plain text to serialize.
 * @returns YAML-safe scalar.
 */
function yamlEscape(value: string): string {
  if (
    value === '' ||
    YAML_MULTILINE.test(value) ||
    YAML_EDGE_WHITESPACE.test(value) ||
    YAML_RESERVED_PREFIX.test(value) ||
    YAML_RESERVED_VALUE.test(value)
  ) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Truncates a description to its first sentence, capped at ~80 chars.
 * @param description - Full description text.
 * @returns Shortened sidebar-friendly string.
 */
function sidebarDescription(description: string): string {
  const sentenceEnd = description.search(/[.!?](?:\s|$)/u);
  const firstSentence = sentenceEnd === -1 ? description : description.slice(0, sentenceEnd);
  const trimmed = firstSentence.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trimEnd()}…`;
}

/**
 * Extracts the first non-empty paragraph from markdown, stripping heading and formatting.
 * @param markdown - Raw markdown content.
 * @returns Plain-text first paragraph.
 */
function extractFirstParagraph(markdown: string): string {
  let body = markdown;
  const h1 = body.match(/^#\s+.+\n/);
  if (h1) body = body.slice(h1[0].length);
  const trimmed = stripLeadingBlockquotes(body.trimStart());
  const paraEnd = trimmed.indexOf('\n\n');
  const raw = (paraEnd !== -1 ? trimmed.slice(0, paraEnd) : (trimmed.split('\n')[0] ?? ''))
    .replace(/\n/g, ' ')
    .replace(/[`*_[\]]/g, '')
    .trim();
  const sentenceEnd = raw.search(/[.!?](?:\s|$)/u);
  return sentenceEnd !== -1 ? raw.slice(0, sentenceEnd + 1).trim() : raw.slice(0, 160);
}

/**
 * Strips the H1 heading and duplicate first paragraph from a README body.
 * @param readme - Raw README markdown.
 * @param description - Resolved package description (used for dedup).
 * @returns Cleaned README body.
 */
function stripReadmeHeader(readme: string, description: string): string {
  let body = readme;
  const h1 = body.match(/^#\s+.+\n/);
  if (h1) body = body.slice(h1[0].length);
  body = body.trimStart();

  const paraEnd = body.indexOf('\n\n');
  const firstPara = (paraEnd !== -1 ? body.slice(0, paraEnd) : (body.split('\n')[0] ?? ''))
    .replace(/\n/g, ' ')
    .replace(/[`*_[\]]/g, '')
    .trim();

  if (firstPara && description.startsWith(firstPara.slice(0, 40))) {
    body = paraEnd !== -1 ? body.slice(paraEnd + 2) : '';
  }

  return body.trimStart();
}

/**
 * Rewrites README-relative links to GitHub source tree URLs.
 * Image links use raw asset URLs via the shared README normalizer.
 * @param body - Markdown body.
 * @param readmeDirFromRoot - Directory path relative to framework root.
 * @returns Body with rewritten links.
 */
function normalizeReadmeLinks(body: string, readmeDirFromRoot: string): string {
  return normalizeReadmeRelativeLinks(body, readmeDirFromRoot);
}

/**
 * Reads a README.md from the given directory, returning empty string if absent.
 * @param dirPath - Absolute path to the package directory.
 * @returns README content or empty string.
 */
function readReadme(dirPath: string): string {
  const readmePath = path.join(dirPath, 'README.md');
  return fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : '';
}

/**
 * Resolves description from package.json, falling back to README first paragraph.
 * @param dirPath - Absolute path to the package directory.
 * @param readme - Raw README content (used as fallback).
 * @returns Canonical description string.
 */
function resolveDescription(dirPath: string, readme: string): string {
  const pkgPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { description?: unknown };
    if (typeof pkg.description === 'string' && pkg.description.length > 0) return pkg.description;
  }
  return readme ? extractFirstParagraph(readme) : '';
}

/**
 * Builds Starlight YAML frontmatter from page metadata.
 * @param fields - Title, description, and optional sidebar overrides.
 * @returns Frontmatter block with trailing newline.
 */
function frontmatter(fields: {
  title: string;
  description: string;
  sidebarLabel?: string;
  sidebarHidden?: boolean;
}): string {
  const lines = ['---'];
  lines.push(`title: ${yamlEscape(fields.title)}`);
  lines.push(`description: ${yamlEscape(fields.description)}`);
  lines.push('sidebar:');
  if (fields.sidebarHidden) lines.push('  hidden: true');
  lines.push(`  label: ${yamlEscape(fields.sidebarLabel ?? fields.title)}`);
  lines.push('  attrs:');
  lines.push(`    data-description: ${yamlEscape(sidebarDescription(fields.description))}`);
  lines.push('---\n');
  return lines.join('\n');
}

/**
 * Removes and re-creates a directory for a clean generation pass.
 * @param outDir - Target directory path.
 */
function writeClean(outDir: string): void {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Relationship rendering (shared by all entity pages)
// ---------------------------------------------------------------------------

/**
 * Renders a "Compatible Clients" markdown table section.
 * @param clients - Client entities to list.
 * @returns Markdown section or empty string.
 */
function renderRelatedClients(clients: readonly ClientEntity[]): string {
  if (clients.length === 0) return '';
  const rows = clients.map((c) => `| [${c.name}](/clients/${c.slug}/) | ${c.description} |`).join('\n');
  return `## Compatible Clients\n\n| Client | Description |\n|--------|-------------|\n${rows}\n\n`;
}

/**
 * Renders a "Compatible Adapters" markdown table section.
 * @param adapters - Adapter entities to list.
 * @returns Markdown section or empty string.
 */
function renderRelatedAdapters(adapters: readonly AdapterEntity[]): string {
  if (adapters.length === 0) return '';
  const rows = adapters
    .map((a) => {
      const protocols = a.protocols.map((p) => `\`${p}\``).join(', ');
      return `| [${a.displayName}](/adapters/${a.slug}/) | ${protocols} | ${a.description} |`;
    })
    .join('\n');
  return `## Compatible Adapters\n\n| Adapter | Protocols | Description |\n|---------|-----------|-------------|\n${rows}\n\n`;
}

/**
 * Renders a "Compatible Providers" markdown table section.
 * @param providers - Provider entities to list.
 * @returns Markdown section or empty string.
 */
function renderRelatedProviders(providers: readonly ProviderEntity[]): string {
  if (providers.length === 0) return '';
  const rows = providers
    .map((p) => {
      const protocols = p.protocols.map((pr) => `\`${pr}\``).join(', ');
      return `| [${p.name}](/providers/${p.slug}/#${p.id}/) | ${protocols} | ${p.description} |`;
    })
    .join('\n');
  return `## Compatible Providers\n\n| Provider | Protocols | Description |\n|----------|-----------|-------------|\n${rows}\n\n`;
}

// ---------------------------------------------------------------------------
// Client pages
// ---------------------------------------------------------------------------

/**
 * Generates a full Starlight-compatible markdown page for a single client.
 * @param client - Client entity to render.
 * @param graph - Entity graph for relationship lookups.
 * @returns Complete markdown page content.
 */
function renderClientPage(client: ClientEntity, graph: EntityGraph): string {
  const dirPath = path.join(FRAMEWORK_ROOT, 'clients', client.slug);
  const readme = readReadme(dirPath);
  const description = resolveDescription(dirPath, readme);

  const parts: string[] = [];
  parts.push(frontmatter({ title: client.name, description }));
  parts.push(`> ${description}\n\n`);
  if (client.binary?.name) parts.push(`**Binary:** \`${client.binary.name}\`\n\n`);

  parts.push(renderRelatedAdapters(graph.clientToAdapters.get(client.id) ?? []));
  parts.push(renderRelatedProviders(graph.clientToProviders.get(client.id) ?? []));

  if (readme) {
    const body = convertGitHubCallouts(stripReadmeHeader(readme, description));
    if (body) parts.push(normalizeReadmeLinks(body, `clients/${client.slug}`));
  }

  return parts.join('');
}

/**
 * Generates the clients index page with a summary table.
 * @param clients - All discovered clients.
 * @returns Complete markdown index page.
 */
function renderClientIndexPage(clients: readonly ClientEntity[]): string {
  const lines = [
    frontmatter({
      title: 'Clients',
      description: 'AI coding clients supported by the Makaio Framework.',
      sidebarHidden: true,
    }),
  ];
  lines.push('Clients are the AI coding assistants that users interact with directly.');
  lines.push('The Makaio Framework integrates with each client through adapters, giving');
  lines.push('you a unified runtime regardless of which client you prefer.\n');
  lines.push('| Client | Binary | Description |');
  lines.push('|--------|--------|-------------|');
  for (const c of clients) {
    lines.push(`| [${c.name}](./${c.slug}/) | \`${c.binary?.name ?? '—'}\` | ${sidebarDescription(c.description)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Writes generated client documentation pages.
 * @param outDir - Destination directory for client pages.
 * @param graph - Entity graph for relationship data.
 */
export function generateClientPageFiles(outDir: string, graph: EntityGraph): void {
  writeClean(outDir);
  fs.writeFileSync(path.join(outDir, 'index.md'), renderClientIndexPage(graph.clients));
  for (const client of graph.clients) {
    fs.writeFileSync(path.join(outDir, `${client.slug}.md`), renderClientPage(client, graph));
  }
}

// ---------------------------------------------------------------------------
// Adapter pages
// ---------------------------------------------------------------------------

/**
 * Generates a full Starlight-compatible markdown page for a single adapter.
 * @param adapter - Adapter entity to render.
 * @param graph - Entity graph for relationship lookups.
 * @returns Complete markdown page content.
 */
function renderAdapterPage(adapter: AdapterEntity, graph: EntityGraph): string {
  const dirPath = path.join(FRAMEWORK_ROOT, 'adapters', 'implementations', adapter.slug);
  const readme = readReadme(dirPath);
  const description = resolveDescription(dirPath, readme);
  const protocols = adapter.protocols.map((p) => `\`${p}\``).join(', ');

  const parts: string[] = [];
  parts.push(frontmatter({ title: adapter.displayName, description }));
  parts.push(`> ${description}\n\n`);
  parts.push(`**Protocols:** ${protocols}\n\n`);

  const clients = graph.adapterToClients.get(adapter.name) ?? [];
  if (clients.length > 0) {
    const clientLinks = clients.map((c) => `[${c.name}](/clients/${c.slug}/)`).join(', ');
    parts.push(`**Requires Client:** ${clientLinks}\n\n`);
  }

  parts.push(renderRelatedClients(clients));
  parts.push(renderRelatedProviders(graph.adapterToProviders.get(adapter.name) ?? []));

  if (readme) {
    const body = convertGitHubCallouts(stripReadmeHeader(readme, description));
    if (body) parts.push(normalizeReadmeLinks(body, `adapters/implementations/${adapter.slug}`));
  }

  return parts.join('');
}

/**
 * Generates the adapters index page with a summary table.
 * @param adapters - All discovered adapters.
 * @returns Complete markdown index page.
 */
function renderAdapterIndexPage(adapters: readonly AdapterEntity[]): string {
  const lines = [
    frontmatter({
      title: 'Adapters',
      description: 'AI adapter implementations shipped with the Makaio Framework.',
      sidebarHidden: true,
    }),
  ];
  lines.push('Adapters bridge AI coding clients to model providers through a uniform');
  lines.push('bus-based contract. Each adapter speaks a specific wire protocol and');
  lines.push('optionally binds to a particular client.\n');
  lines.push('| Adapter | Protocols | Client | Description |');
  lines.push('|---------|-----------|--------|-------------|');
  for (const a of adapters) {
    const protocols = a.protocols.map((p) => `\`${p}\``).join(', ');
    const clientNames = a.clients.length > 0 ? a.clients.map((c) => c.id).join(', ') : '—';
    lines.push(
      `| [${a.displayName}](./${a.slug}/) | ${protocols} | ${clientNames} | ${sidebarDescription(a.description)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Writes generated adapter documentation pages.
 * @param outDir - Destination directory for adapter pages.
 * @param graph - Entity graph for relationship data.
 */
export function generateAdapterPageFiles(outDir: string, graph: EntityGraph): void {
  writeClean(outDir);
  fs.writeFileSync(path.join(outDir, 'index.md'), renderAdapterIndexPage(graph.adapters));
  for (const adapter of graph.adapters) {
    fs.writeFileSync(path.join(outDir, `${adapter.slug}.md`), renderAdapterPage(adapter, graph));
  }
}

// ---------------------------------------------------------------------------
// Provider pages
// ---------------------------------------------------------------------------

/**
 * Providers are grouped by directory slug (one directory can declare multiple
 * provider contributions — e.g. `anthropic` declares both `anthropic` and
 * `anthropic-oauth`). We render one page per slug with sections per provider.
 */
interface ProviderGroup {
  slug: string;
  displayName: string;
  description: string;
  providers: ProviderEntity[];
}

/**
 * Groups providers by their filesystem slug (directory name).
 * @param providers - All discovered providers.
 * @returns Sorted array of provider groups.
 */
function groupProvidersBySlug(providers: readonly ProviderEntity[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const p of providers) {
    let group = groups.get(p.slug);
    if (!group) {
      group = { slug: p.slug, displayName: p.name, description: p.description, providers: [] };
      groups.set(p.slug, group);
    }
    group.providers.push(p);
  }
  return [...groups.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Generates a full Starlight-compatible markdown page for a provider group.
 * @param group - Provider group (one page per directory slug).
 * @param graph - Entity graph for relationship lookups.
 * @returns Complete markdown page content.
 */
function renderProviderPage(group: ProviderGroup, graph: EntityGraph): string {
  const dirPath = path.join(FRAMEWORK_ROOT, 'providers', group.slug);
  const readme = readReadme(dirPath);
  const description = resolveDescription(dirPath, readme);

  const parts: string[] = [];
  parts.push(frontmatter({ title: group.displayName, description }));
  parts.push(`> ${description}\n\n`);

  for (const provider of group.providers) {
    if (group.providers.length > 1) {
      const heading = provider.name === group.displayName ? '' : `\n\n### ${provider.name}`;
      parts.push(`<a id="${provider.id}"></a>${heading}\n\n`);
    }

    const protocols = provider.protocols.map((p) => `\`${p}\``).join(', ');
    parts.push(`**Protocols:** ${protocols}\n\n`);
    if (provider.requiredClient) {
      parts.push(`**Requires Client:** \`${provider.requiredClient}\`\n\n`);
    }

    const adapters = graph.providerToAdapters.get(provider.id) ?? [];
    const clients = graph.providerToClients.get(provider.id) ?? [];

    if (adapters.length > 0) {
      parts.push(renderRelatedAdapters(adapters));
    }
    if (clients.length > 0) {
      parts.push(renderRelatedClients(clients));
    }
  }

  if (readme) {
    const body = convertGitHubCallouts(stripReadmeHeader(readme, description));
    if (body) parts.push(normalizeReadmeLinks(body, `providers/${group.slug}`));
  }

  return parts.join('');
}

/**
 * Generates the providers index page with a summary table.
 * @param groups - All provider groups.
 * @returns Complete markdown index page.
 */
function renderProviderIndexPage(groups: readonly ProviderGroup[]): string {
  const lines = [
    frontmatter({
      title: 'Providers',
      description: 'Model providers supported by the Makaio Framework.',
      sidebarHidden: true,
    }),
  ];
  lines.push('Providers supply AI model access — either directly via API keys or through');
  lines.push('client-managed credentials (OAuth, native subscriptions). The framework');
  lines.push('resolves the right adapter for each provider automatically.\n');
  lines.push('| Provider | Protocols | Description |');
  lines.push('|----------|-----------|-------------|');
  for (const g of groups) {
    const protocols = [...new Set(g.providers.flatMap((p) => p.protocols))].map((p) => `\`${p}\``).join(', ');
    lines.push(`| [${g.displayName}](./${g.slug}/) | ${protocols} | ${sidebarDescription(g.description)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Writes generated provider documentation pages.
 * @param outDir - Destination directory for provider pages.
 * @param graph - Entity graph for relationship data.
 */
export function generateProviderPageFiles(outDir: string, graph: EntityGraph): void {
  const groups = groupProvidersBySlug(graph.providers);
  writeClean(outDir);
  fs.writeFileSync(path.join(outDir, 'index.md'), renderProviderIndexPage(groups));
  for (const group of groups) {
    fs.writeFileSync(path.join(outDir, `${group.slug}.md`), renderProviderPage(group, graph));
  }
}

// ---------------------------------------------------------------------------
// Astro integration
// ---------------------------------------------------------------------------

/**
 * Creates an Astro integration that generates catalog pages for clients,
 * adapters, and providers from framework descriptors with computed
 * relationship cross-links.
 * @returns Astro integration for catalog page generation.
 */
export function generateCatalogPages(): AstroIntegration {
  return {
    name: 'generate-catalog-pages',
    hooks: {
      'astro:config:setup': () => {
        const graph = buildEntityGraph();
        generateClientPageFiles(path.join(WEBSITE_DOCS_DIR, 'clients'), graph);
        generateAdapterPageFiles(path.join(WEBSITE_DOCS_DIR, 'adapters'), graph);
        generateProviderPageFiles(path.join(WEBSITE_DOCS_DIR, 'providers'), graph);
      },
    },
  };
}
