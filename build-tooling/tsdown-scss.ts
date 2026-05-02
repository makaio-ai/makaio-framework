import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, type URL } from 'node:url';
import type { FileImporter } from 'sass';

/**
 * Create a Sass importer for workspace-local SCSS packages that expose partials.
 *
 * `@tsdown/css` resolves Sass package imports before Sass sees `loadPaths`, so
 * workspace partials such as `@makaio/ui-theme/tokens/colors` need an explicit
 * importer that maps the package specifier to `tokens/_colors.scss`.
 * @param workspaceRoot - Absolute framework workspace root.
 * @returns Sass file importer for framework SCSS package imports.
 */
export function createMakaioScssImporter(workspaceRoot: string): FileImporter<'async'> {
  const uiThemeRoot = path.resolve(workspaceRoot, 'ui/theme');

  return {
    findFileUrl(url): URL | null {
      if (url === '@makaio/ui-theme') {
        return findSassModule(path.join(uiThemeRoot, 'index'));
      }

      const prefix = '@makaio/ui-theme/';
      if (!url.startsWith(prefix)) {
        return null;
      }

      const modulePath = path.resolve(uiThemeRoot, url.slice(prefix.length));
      if (modulePath !== uiThemeRoot && !modulePath.startsWith(`${uiThemeRoot}${path.sep}`)) {
        return null;
      }

      return findSassModule(modulePath);
    },
  };
}

/**
 * Resolve a Sass module path using Sass partial and index conventions.
 * @param modulePath - Absolute path without a guaranteed extension.
 * @returns File URL for the first matching Sass module, or null.
 */
function findSassModule(modulePath: string): URL | null {
  const directory = path.dirname(modulePath);
  const basename = path.basename(modulePath);
  const candidates = [
    modulePath,
    `${modulePath}.scss`,
    path.join(directory, `_${basename}.scss`),
    path.join(modulePath, 'index.scss'),
    path.join(modulePath, '_index.scss'),
  ];

  const match = candidates.find((candidate) => isFile(candidate));
  return match ? pathToFileURL(match) : null;
}

/**
 * Check whether a Sass candidate exists as a regular file.
 * @param candidate - Absolute candidate path.
 * @returns True when the candidate is a file.
 */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
