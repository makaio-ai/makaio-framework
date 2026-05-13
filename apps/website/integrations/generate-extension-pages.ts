import fs from 'node:fs';
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import { convertGitHubCallouts, normalizeReadmeRelativeLinks, stripLeadingBlockquotes } from './readme-utils';

interface ExtensionDescriptor {
  name: string;
  displayName: string;
  version: string;
  makaio?: { framework?: string };
  entrypoints?: { browser?: boolean | string; server?: boolean | string; cli?: boolean | string };
  cli?: { name: string; description: string; subcommands?: { name: string; description: string }[] };
  contributions?: Record<string, unknown>;
  config?: { defaults?: Record<string, unknown> };
}

interface DiscoveredExtension {
  /** Descriptor name — used as the URL slug. */
  slug: string;
  descriptor: ExtensionDescriptor;
  packageName: string;
  description: string;
  readme: string;
}

const FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const EXTENSIONS_DIR = path.join(FRAMEWORK_ROOT, 'extensions');
// Astro may invoke integration hooks from the repo root or the website package;
// generated content is anchored to this integration package either way.
const EXTENSION_DOCS_OUT_DIR = path.resolve(import.meta.dirname, '..', 'src', 'content', 'docs', 'extensions');

const YAML_RESERVED_VALUE = /[":{}[\],&*?|>!%#@`]/;
const YAML_RESERVED_PREFIX = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_MULTILINE = /[\n\r]/;
const YAML_EDGE_WHITESPACE = /^\s|\s$/;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scans `extensions/` for published extensions (package.json#private !== true)
 * and collects their descriptor, package metadata, and README body.
 * @returns An array of discovered public extensions sorted by slug.
 */
export function discoverPublicExtensions(): DiscoveredExtension[] {
  const extensions: DiscoveredExtension[] = [];

  for (const entry of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'shared') continue;

    const extDir = path.join(EXTENSIONS_DIR, entry.name);
    const descriptorPath = path.join(extDir, 'descriptor.json');
    const packageJsonPath = path.join(extDir, 'package.json');
    if (!fs.existsSync(descriptorPath) || !fs.existsSync(packageJsonPath)) continue;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      name?: string;
      private?: boolean;
      description?: string;
    };
    if (packageJson.private === true) continue;

    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')) as ExtensionDescriptor;
    const readmePath = path.join(extDir, 'README.md');
    const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : '';

    extensions.push({
      slug: descriptor.name,
      descriptor,
      packageName: packageJson.name ?? descriptor.name,
      description:
        (typeof packageJson.description === 'string' && packageJson.description.length > 0
          ? packageJson.description
          : '') || extractFirstParagraph(readme),
      readme,
    });
  }

  return extensions.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

/**
 * Extracts the first non-empty paragraph from a markdown string, stripping
 * the H1 heading and any markdown formatting characters.
 * @param markdown - Raw markdown content to extract the paragraph from.
 * @returns The first sentence or up to 160 characters of plain text.
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
 * Wraps a YAML scalar value in double quotes when it contains reserved
 * characters, multiline content, or edge whitespace.
 * @param value - The raw string to escape for use as a YAML scalar.
 * @returns A YAML-safe string, quoted if necessary.
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
 * Truncates a description to the first sentence and at most 80 characters
 * for use as a sidebar label.
 * @param description - Full extension description string.
 * @returns A short, sidebar-safe description of at most 80 characters.
 */
function sidebarDescription(description: string): string {
  const sentenceEnd = description.search(/[.!?](?:\s|$)/u);
  const firstSentence = sentenceEnd === -1 ? description : description.slice(0, sentenceEnd);
  const trimmed = firstSentence.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trimEnd()}…`;
}

/**
 * Rewrites README-relative links to point at the GitHub source tree.
 * Image links use raw asset URLs via the shared README normalizer.
 * @param body - Markdown body from the extension README.
 * @param extensionSlug - Extension directory name under `extensions/`.
 * @returns The markdown body with relative links rewritten to absolute GitHub URLs.
 */
function normalizeReadmeLinks(body: string, extensionSlug: string): string {
  return normalizeReadmeRelativeLinks(body, `extensions/${extensionSlug}`);
}

/**
 * Renders entrypoint badges as a compact line.
 * @param entrypoints - The entrypoints map from the extension descriptor.
 * @returns A markdown string listing active surface badges, or an empty string.
 */
function renderEntrypoints(entrypoints: ExtensionDescriptor['entrypoints']): string {
  if (!entrypoints) return '';
  const badges: string[] = [];
  if (entrypoints.server) badges.push('Server');
  if (entrypoints.browser) badges.push('Browser');
  if (entrypoints.cli) badges.push('CLI');
  return badges.length > 0 ? `**Surfaces:** ${badges.join(' · ')}\n\n` : '';
}

/**
 * Renders the CLI subcommands table if present.
 * @param cli - The CLI descriptor from the extension, if any.
 * @returns A markdown table of CLI subcommands, or an empty string.
 */
function renderCliSection(cli: ExtensionDescriptor['cli']): string {
  if (!cli?.subcommands?.length) return '';
  const rows = cli.subcommands.map((cmd) => `| \`${cli.name} ${cmd.name}\` | ${cmd.description} |`).join('\n');
  return `## CLI Commands\n\n| Command | Description |\n|---------|-------------|\n${rows}\n\n`;
}

/**
 * Strips the H1 heading from a README body since the page title comes from
 * frontmatter. Also strips the first paragraph if it matches the package
 * description (avoids duplication with the frontmatter description).
 * @param readme - Raw README markdown content.
 * @param description - Package description used to detect duplicate opening paragraph.
 * @returns The README body with the H1 and any redundant opening paragraph removed.
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
 * Generates a full Starlight-compatible markdown page for a single extension.
 * @param ext - The discovered extension to render a documentation page for.
 * @returns A complete markdown string including YAML frontmatter and body content.
 */
export function renderExtensionPage(ext: DiscoveredExtension): string {
  const lines = ['---'];
  lines.push(`title: ${yamlEscape(ext.descriptor.displayName)}`);
  lines.push(`description: ${yamlEscape(ext.description)}`);
  lines.push('sidebar:');
  lines.push(`  label: ${yamlEscape(ext.descriptor.displayName)}`);
  lines.push('  attrs:');
  lines.push(`    data-description: ${yamlEscape(sidebarDescription(ext.description))}`);
  lines.push('---\n');

  const parts: string[] = [lines.join('\n')];

  parts.push(`> ${ext.description}\n\n`);
  parts.push(`**Package:** \`${ext.packageName}\`\n\n`);
  parts.push(renderEntrypoints(ext.descriptor.entrypoints));
  parts.push(renderCliSection(ext.descriptor.cli));

  if (ext.readme) {
    const body = convertGitHubCallouts(stripReadmeHeader(ext.readme, ext.description));
    if (body) {
      parts.push(normalizeReadmeLinks(body, ext.slug));
    }
  }

  return parts.join('');
}

/**
 * Generates the extensions index page with a summary table.
 * @param extensions - All discovered public extensions to list.
 * @returns A complete markdown string for the extensions index page.
 */
export function renderExtensionIndexPage(extensions: readonly DiscoveredExtension[]): string {
  const lines = ['---'];
  lines.push('title: Extensions');
  lines.push('description: Extensions that ship with the Makaio Framework.');
  lines.push('sidebar:');
  lines.push('  hidden: true');
  lines.push('---\n');
  lines.push('Extensions add capabilities to the Makaio runtime — CLI commands, background');
  lines.push('services, UI, storage handlers, and more. Install them with');
  lines.push('`makaio extension install` or include them in your project dependencies.\n');
  lines.push('| Extension | Description |');
  lines.push('|-----------|-------------|');
  for (const ext of extensions) {
    lines.push(`| [${ext.descriptor.displayName}](./${ext.slug}/) | ${sidebarDescription(ext.description)} |`);
  }
  lines.push('');
  lines.push('Looking to build your own? See the [Creating Extensions](/guides/creating-extensions/) guide.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File generation
// ---------------------------------------------------------------------------

/**
 * Generates extension documentation pages from discovered public extensions.
 * @param outDir - Destination directory for generated extension pages.
 * @returns The list of discovered extensions that were written to disk.
 */
export function generateExtensionPageFiles(outDir: string): DiscoveredExtension[] {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const extensions = discoverPublicExtensions();

  fs.writeFileSync(path.join(outDir, 'index.md'), renderExtensionIndexPage(extensions));

  for (const ext of extensions) {
    fs.writeFileSync(path.join(outDir, `${ext.slug}.md`), renderExtensionPage(ext));
  }

  return extensions;
}

// ---------------------------------------------------------------------------
// Astro integration
// ---------------------------------------------------------------------------

/**
 * Creates an Astro integration that generates extension catalog pages from
 * extension descriptors and READMEs.
 * @returns An Astro integration that writes extension pages during config setup.
 */
export function generateExtensionPages(): AstroIntegration {
  return {
    name: 'generate-extension-pages',
    hooks: {
      'astro:config:setup': () => {
        generateExtensionPageFiles(EXTENSION_DOCS_OUT_DIR);
      },
    },
  };
}
