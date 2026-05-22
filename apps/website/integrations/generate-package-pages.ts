import fs from 'node:fs';
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import { convertGitHubCallouts, normalizeReadmeRelativeLinks, stripLeadingBlockquotes } from './readme-utils';

export interface PackageEntry {
  readme: string;
}

interface ParsedReadme {
  title: string;
  description: string;
  metadata: Record<string, string>;
  body: string;
}

const FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PACKAGE_ROUTE_MANIFEST_PATH = path.resolve(import.meta.dirname, '..', '.package-route-manifest.json');
// Astro may invoke integration hooks from the repo root or the website package;
// generated content is anchored to this integration package either way.
const PACKAGE_DOCS_OUT_DIR = path.resolve(import.meta.dirname, '..', 'src', 'content', 'docs', 'packages');
const YAML_RESERVED_VALUE = /[":{}[\],&*?|>!%#@`]/;
const YAML_RESERVED_PREFIX = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_MULTILINE = /[\n\r]/;
const YAML_EDGE_WHITESPACE = /^\s|\s$/;

const packages: PackageEntry[] = [
  { readme: 'core/bus-core/README.md' },
  { readme: 'core/contracts/README.md' },
  { readme: 'packages/kernel/README.md' },
  { readme: 'packages/hooks/README.md' },
  { readme: 'packages/utils/README.md' },
  { readme: 'core/makaio-core/README.md' },
  { readme: 'packages/providers/README.md' },
  { readme: 'packages/expression/README.md' },
  { readme: 'storage/preferences/README.md' },
  { readme: 'packages/bus-server/README.md' },
  { readme: 'packages/service-base/README.md' },
  { readme: 'services/log-import/README.md' },
  { readme: 'packages/test-utils/README.md' },

  { readme: 'ui/theme/README.md' },
  { readme: 'ui/components/README.md' },
  { readme: 'ui/kernel/README.md' },
  { readme: 'ui/hooks/README.md' },
  { readme: 'ui/views/README.md' },

  { readme: 'storage/core/README.md' },
  { readme: 'storage/drizzle/README.md' },
  { readme: 'storage/handlers/README.md' },
  { readme: 'storage/migrations/README.md' },

  { readme: 'core/tools-core/README.md' },
  { readme: 'extensions/filesystem/README.md' },
  { readme: 'extensions/shell/README.md' },
  { readme: 'extensions/subagent/README.md' },

  { readme: 'adapters/core/README.md' },
  { readme: 'adapters/shared/stream-session/README.md' },
  { readme: 'adapters/shared/claude-shared/README.md' },
  { readme: 'adapters/implementations/anthropic-sdk/README.md' },
  { readme: 'adapters/implementations/claude-agent-sdk/README.md' },
  { readme: 'adapters/implementations/claude-code-cli/README.md' },
  { readme: 'adapters/implementations/codex-app-server/README.md' },
  { readme: 'adapters/implementations/gemini-sdk/README.md' },
  { readme: 'adapters/implementations/github-copilot-sdk/README.md' },
  { readme: 'adapters/implementations/openai-node/README.md' },

  { readme: 'transports/ws/README.md' },
];

/**
 * Derives the docs slug path (relative to /packages/) from a README path.
 * Strips top-level repo directories whose packages are rendered inside the
 * website's `/packages/` section to avoid double-nesting (e.g. `/packages/packages/…`).
 * @param readme - README path relative to the framework root.
 * @returns Slug path (e.g. `bus-core`, `ui/components`, `adapters/implementations/anthropic-sdk`).
 */
export function readmeToSlugPath(readme: string): string {
  const stripped = readme.replace(/\/README\.md$/u, '');
  for (const prefix of ['packages/', 'core/', 'storage/']) {
    if (stripped.startsWith(prefix)) return stripped.slice(prefix.length);
  }
  return stripped;
}

/**
 * Extracts Starlight page metadata and body content from a package README.
 * @param content - Raw README Markdown content.
 * @returns Parsed page metadata and body content.
 */
export function parseReadme(content: string): ParsedReadme {
  let body = content;
  let title = '';
  const metadata: Record<string, string> = {};

  if (body.startsWith('---\n')) {
    const endIdx = body.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const frontmatter = body.slice(4, endIdx);
      for (const line of frontmatter.split('\n')) {
        const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
        if (!match) continue;
        const key = match[1]!;
        if (key === 'title' || key === 'description') continue;
        metadata[key] = match[2]!;
      }
      body = body.slice(endIdx + 5);
    }
  }

  // Extract and remove H1 heading as title
  const h1Match = body.match(/^#\s+(.+)\n/);
  if (h1Match) {
    title = h1Match[1]!;
    body = body.slice(h1Match[0].length);
  }

  // Extract description from first non-empty paragraph
  const trimmed = stripLeadingBlockquotes(body.trimStart());
  const paraEnd = trimmed.indexOf('\n\n');
  const firstPara = (paraEnd !== -1 ? trimmed.slice(0, paraEnd) : trimmed.split('\n')[0]!)
    .replace(/\n/g, ' ')
    .replace(/[`*_[\]]/g, '')
    .trim();
  const description = firstPara.slice(0, 160);

  return { title, description, metadata, body: body.trimStart() };
}

/**
 * Escapes a value for use in generated YAML frontmatter.
 * @param value - Plain text value to serialize into frontmatter.
 * @returns YAML-safe scalar value.
 */
function yamlEscape(value: string): string {
  if (
    value === '' ||
    YAML_MULTILINE.test(value) ||
    YAML_EDGE_WHITESPACE.test(value) ||
    YAML_RESERVED_PREFIX.test(value) ||
    YAML_RESERVED_VALUE.test(value)
  ) {
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return `"${escapedValue}"`;
  }
  return value;
}

/**
 * Rewrites README-relative Markdown links after relocating content to `/packages`.
 * Image links use raw asset URLs via the shared README normalizer.
 * @param body - Markdown body from the README.
 * @param readmePath - README path relative to the framework root.
 * @returns Markdown body with non-local relative links pointing at source.
 */
export function normalizeReadmeLinks(body: string, readmePath: string): string {
  const readmeDir = path.posix.dirname(readmePath.replaceAll(path.sep, '/'));
  return normalizeReadmeRelativeLinks(body, readmeDir);
}

/**
 * Resolves the canonical package description, preferring `package.json#description`
 * (the npm-standard one-liner) over the README first paragraph. Returns the README
 * fallback unchanged when no package.json or no description is present, so non-npm
 * doc entries (e.g. `sdks/conformance/`) still work.
 * @param readme - README path relative to the framework root.
 * @param frameworkRoot - Absolute path to the framework root.
 * @param fallback - README-derived description used when package.json has none.
 * @returns Canonical package description.
 */
export function resolvePackageDescription(readme: string, frameworkRoot: string, fallback: string): string {
  const packageJsonPath = path.join(frameworkRoot, path.dirname(readme), 'package.json');
  if (!fs.existsSync(packageJsonPath)) return fallback;
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { description?: unknown };
  return typeof packageJson.description === 'string' && packageJson.description.length > 0
    ? packageJson.description
    : fallback;
}

/**
 * Shortens a description to its first sentence, capped at ~80 chars, for use as
 * a sidebar tooltip / two-line item subtitle. With package.json descriptions
 * sourced first, this should rarely truncate — it remains as a safety net for
 * the README fallback path.
 * @param description - Full description.
 * @returns Trimmed sidebar description.
 */
export function sidebarDescription(description: string): string {
  const sentenceEnd = description.search(/[.!?](?:\s|$)/u);
  const firstSentence = sentenceEnd === -1 ? description : description.slice(0, sentenceEnd);
  const trimmed = firstSentence.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trimEnd()}…`;
}

/**
 * Builds Starlight frontmatter for a generated package page.
 * @param parsed - Parsed README metadata.
 * @param sidebarLabel - Sidebar label for the entry (typically the package leaf name).
 * @returns YAML frontmatter text.
 */
export function frontmatterFor(parsed: ParsedReadme, sidebarLabel: string): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(parsed.metadata)) {
    lines.push(`${key}: ${yamlEscape(value)}`);
  }
  lines.push(`title: ${yamlEscape(parsed.title)}`);
  lines.push(`description: ${yamlEscape(parsed.description)}`);
  lines.push('sidebar:');
  lines.push(`  label: ${yamlEscape(sidebarLabel)}`);
  lines.push('  attrs:');
  lines.push(`    data-description: ${yamlEscape(sidebarDescription(parsed.description))}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n`;
}

/**
 * Writes generated package documentation pages from package READMEs.
 * @param outDir - Destination directory for generated package Markdown pages.
 * @param packageEntries - Package README entries to generate.
 */
export function generatePackagePageFiles(outDir: string, packageEntries: readonly PackageEntry[] = packages): void {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const missingReadmes: string[] = [];

  for (const pkg of packageEntries) {
    const readmePath = path.join(FRAMEWORK_ROOT, pkg.readme);
    if (!fs.existsSync(readmePath)) {
      missingReadmes.push(pkg.readme);
      continue;
    }

    const raw = fs.readFileSync(readmePath, 'utf-8');
    const parsed = parseReadme(raw);
    const description = resolvePackageDescription(pkg.readme, FRAMEWORK_ROOT, parsed.description);
    const body = normalizeReadmeLinks(convertGitHubCallouts(parsed.body), pkg.readme);

    const slugPath = readmeToSlugPath(pkg.readme);
    const sidebarLabel = path.posix.basename(slugPath);
    const page = `${frontmatterFor({ ...parsed, description }, sidebarLabel)}${body}`;
    const outPath = path.join(outDir, `${slugPath}.md`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, page);
  }

  if (missingReadmes.length > 0) {
    throw new Error(`Missing README files for generated package pages:\n${missingReadmes.join('\n')}`);
  }
}

/**
 * Creates package-name to package-route mappings for generated package pages.
 * @param packageEntries - Package README entries to include in the manifest.
 * @returns Map of package names to generated package routes.
 */
export function createPackageRouteManifest(packageEntries: readonly PackageEntry[] = packages): Record<string, string> {
  const manifest: Record<string, string> = {};

  for (const pkg of packageEntries) {
    const packageJsonPath = path.join(FRAMEWORK_ROOT, path.dirname(pkg.readme), 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: unknown };
    if (typeof packageJson.name !== 'string') continue;
    manifest[packageJson.name] = `/packages/${readmeToSlugPath(pkg.readme)}/`;
  }

  return manifest;
}

/**
 * Writes package-name to package-route mappings for generated package pages.
 * @param manifestPath - Destination JSON manifest path.
 * @param packageEntries - Package README entries to include in the manifest.
 */
function writePackageRouteManifest(manifestPath: string, packageEntries: readonly PackageEntry[] = packages): void {
  fs.writeFileSync(manifestPath, JSON.stringify(createPackageRouteManifest(packageEntries), null, 2));
}

/**
 * Creates an Astro integration that generates package documentation pages from package READMEs.
 * @returns Astro integration for generated package pages.
 */
export function generatePackagePages(): AstroIntegration {
  return {
    name: 'generate-package-pages',
    hooks: {
      'astro:config:setup': () => {
        generatePackagePageFiles(PACKAGE_DOCS_OUT_DIR);
        writePackageRouteManifest(PACKAGE_ROUTE_MANIFEST_PATH);
      },
    },
  };
}
