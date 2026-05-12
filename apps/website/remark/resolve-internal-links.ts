import path from 'node:path';
import fs from 'node:fs';
import { visit } from 'unist-util-visit';
import type { Root, Link } from 'mdast';

const RELATIVE_RE = /^\.{1,2}\//;
const MD_EXT_RE = /\.(mdx?|md)$/u;

const DEFAULT_FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DEFAULT_SOURCE_URL_BASE = 'https://github.com/makaio-ai/makaio-framework/blob/main';

export interface ResolveInternalLinksOptions {
  /** Absolute path to the framework root directory. */
  frameworkRoot?: string;
  /** Base URL for source-code links (e.g. `https://github.com/…/blob/main`). */
  sourceUrlBase?: string;
}

/**
 * Prefix rules mapping filesystem paths (relative to framework root) to
 * website route prefixes. Order matters — more specific prefixes first.
 */
const ROUTE_RULES: ReadonlyArray<{ fsPrefix: string; routePrefix: string }> = [
  { fsPrefix: 'docs/architecture', routePrefix: 'architecture' },
  { fsPrefix: 'docs', routePrefix: 'guides' },
  { fsPrefix: 'apps/website/src/content/docs', routePrefix: '' },
  { fsPrefix: 'extensions', routePrefix: 'extensions' },
  { fsPrefix: 'packages', routePrefix: 'packages' },
  { fsPrefix: 'adapters', routePrefix: 'adapters' },
  { fsPrefix: 'clients', routePrefix: 'clients' },
  { fsPrefix: 'providers', routePrefix: 'providers' },
  { fsPrefix: 'sdks', routePrefix: 'sdks' },
];

/**
 * Normalizes a route string to match Starlight's slug normalization.
 * @param route - Raw route path.
 * @returns Lowercase, slugified route with `/index` suffix removed.
 */
export function normalizeRoute(route: string): string {
  return (
    route
      .replace(/\/index$/u, '')
      .split('/')
      .map((seg) => seg.toLowerCase().replace(/[^a-z0-9_-]/gu, ''))
      .join('/') || 'index'
  );
}

/**
 * Maps a filesystem path (relative to framework root) to a website route.
 * @param relativePath - Path relative to the framework root, forward-slash separated.
 * @returns Normalized route string, or `undefined` if the path is outside any known content tree.
 */
export function mapToRoute(relativePath: string): string | undefined {
  for (const rule of ROUTE_RULES) {
    if (relativePath === rule.fsPrefix) {
      return normalizeRoute(rule.routePrefix || 'index');
    }
    if (relativePath.startsWith(`${rule.fsPrefix}/`)) {
      const suffix = relativePath.slice(rule.fsPrefix.length + 1);
      const route = rule.routePrefix ? `${rule.routePrefix}/${suffix}` : suffix;
      return normalizeRoute(route);
    }
  }
  return undefined;
}

/**
 * Scans all known content source directories to build the set of existing
 * page routes. Called once and cached for the lifetime of the build.
 * @param frameworkRoot - Absolute path to the framework root.
 * @returns Set of normalized route IDs for all existing pages.
 */
function discoverKnownRoutes(frameworkRoot: string): Set<string> {
  const routes = new Set<string>();

  const contentDir = path.join(frameworkRoot, 'apps/website/src/content/docs');
  if (fs.existsSync(contentDir)) {
    walk(contentDir, (rel) => {
      if (!MD_EXT_RE.test(rel)) return;
      routes.add(normalizeRoute(rel.replace(MD_EXT_RE, '')));
    });
  }

  const docsDir = path.join(frameworkRoot, 'docs');
  if (fs.existsSync(docsDir)) {
    walk(docsDir, (rel) => {
      if (!MD_EXT_RE.test(rel) || rel.startsWith('subjects/')) return;
      const stem = rel.replace(MD_EXT_RE, '');
      const route = stem.startsWith('architecture/') ? stem : `guides/${stem}`;
      routes.add(normalizeRoute(route));
    });
  }

  return routes;
}

/**
 * Recursively walks a directory tree, calling `visitor` with each file's
 * path relative to `base`.
 * @param base - Root directory to walk.
 * @param visitor - Called once per file with its relative path.
 * @param prefix - Current subdirectory prefix (internal recursion state).
 */
function walk(base: string, visitor: (relative: string) => void, prefix = ''): void {
  for (const entry of fs.readdirSync(path.join(base, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(base, visitor, rel);
    else visitor(rel);
  }
}

/**
 * Remark plugin that resolves relative internal links against the source
 * file's filesystem position and validates them against known website routes.
 *
 * - Links to existing pages are rewritten to absolute URLs.
 * - Links to non-existent pages (private extensions, etc.) are unwrapped
 *   to plain text.
 * - Links to source-code files (outside any content tree) are rewritten
 *   to GitHub URLs.
 * - `.md`/`.mdx` extensions are stripped (subsumes `remarkStripMdLinks`).
 *
 * Falls back to simple `.md` stripping when the source file path is not
 * available on the VFile.
 * @param options - Plugin configuration.
 * @returns Remark transformer.
 */
export function remarkResolveInternalLinks(
  options?: ResolveInternalLinksOptions,
): (tree: Root, file: { path?: string; history: string[] }) => void {
  const frameworkRoot = options?.frameworkRoot ?? DEFAULT_FRAMEWORK_ROOT;
  const sourceUrlBase = options?.sourceUrlBase ?? DEFAULT_SOURCE_URL_BASE;
  let knownRoutes: Set<string> | undefined;

  return (tree, file) => {
    if (!knownRoutes) knownRoutes = discoverKnownRoutes(frameworkRoot);

    const filePath = file.path ?? file.history[file.history.length - 1];

    visit(tree, 'link', (node: Link, index, parent) => {
      if (index === undefined || !parent) return;
      if (!RELATIVE_RE.test(node.url)) return;

      const [rawPath, fragment] = node.url.split('#', 2);
      const stem = rawPath
        .replace(MD_EXT_RE, '')
        .replace(/\/index$/u, '/')
        .replace(/\/$/u, '');

      if (!filePath) {
        node.url = fragment !== undefined ? `${stem}#${fragment}` : stem;
        return;
      }

      const resolved = path.resolve(path.dirname(filePath), stem || '.');
      const rel = path.relative(frameworkRoot, resolved).replaceAll('\\', '/');

      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        node.url = fragment !== undefined ? `${stem}#${fragment}` : stem;
        return;
      }

      const route = mapToRoute(rel);

      if (route !== undefined) {
        if (knownRoutes!.has(route)) {
          node.url = fragment ? `/${route}/#${fragment}` : `/${route}/`;
        } else {
          parent.children.splice(index, 1, ...node.children);
          return index;
        }
      } else {
        node.url = fragment ? `${sourceUrlBase}/${rel}#${fragment}` : `${sourceUrlBase}/${rel}`;
      }
    });
  };
}
