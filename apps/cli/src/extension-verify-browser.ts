import { build } from 'esbuild';
import * as path from 'node:path';
import { isSharedBrowserExternal } from '@makaio/build-tooling/browser-shared-externals';
import { isWithinDirectory } from '@makaio/runtime-node/extension-validation';

/**
 * Failure emitted when a browser bundle uses unsupported bare imports.
 */
export interface BrowserUnsupportedImportFailure {
  readonly code: 'browser.unsupported-bare-import';
  readonly bareImports: readonly string[];
}

/**
 * Failure emitted when a browser bundle resolves outside the static root.
 */
export interface BrowserStaticRootEscapeFailure {
  readonly code: 'browser.static-root-escape';
  readonly cause: string;
}

/**
 * Failure emitted when a browser bundle is not parseable/loadable ESM.
 */
export interface BrowserInvalidEsmFailure {
  readonly code: 'browser.invalid-esm';
  readonly cause: string;
}

/**
 * Browser bundle verification failure union.
 */
export type BrowserGraphFailure =
  | BrowserInvalidEsmFailure
  | BrowserStaticRootEscapeFailure
  | BrowserUnsupportedImportFailure;

/**
 * Verify that a browser entrypoint is parseable/loadable ESM under the shared externals contract.
 * @param resolvedPath - Absolute browser entrypoint path.
 * @returns Failure information when the module graph is invalid.
 */
export async function verifyBrowserModuleGraph(resolvedPath: string): Promise<BrowserGraphFailure | undefined> {
  const unsupportedBareImports = new Set<string>();
  const serveRoot = path.dirname(resolvedPath);
  let staticRootEscape: { readonly specifier: string; readonly resolvedPath: string } | undefined;

  try {
    await build({
      absWorkingDir: serveRoot,
      bundle: true,
      entryPoints: [resolvedPath],
      format: 'esm',
      logLevel: 'silent',
      platform: 'browser',
      plugins: [
        {
          name: 'makaio-extension-browser-verify',
          setup(buildContext) {
            buildContext.onResolve({ filter: /.*/ }, (args) => {
              if (!isBareModuleSpecifier(args.path)) {
                if (isPathLikeModuleSpecifier(args.path)) {
                  const resolvedImportPath = path.resolve(args.resolveDir, args.path);
                  if (!isWithinDirectory(resolvedImportPath, serveRoot)) {
                    staticRootEscape = {
                      specifier: args.path,
                      resolvedPath: resolvedImportPath,
                    };
                    return {
                      errors: [
                        {
                          text: `Browser import "${args.path}" resolves outside static root "${serveRoot}"`,
                        },
                      ],
                    };
                  }
                }

                return undefined;
              }

              if (isSharedBrowserExternal(args.path)) {
                return {
                  path: args.path,
                  external: true,
                };
              }

              unsupportedBareImports.add(args.path);
              return {
                errors: [{ text: `Unsupported bare import "${args.path}"` }],
              };
            });
          },
        },
      ],
      write: false,
    });
  } catch (error) {
    if (staticRootEscape) {
      return {
        code: 'browser.static-root-escape',
        cause: `Browser import "${staticRootEscape.specifier}" resolves to ${staticRootEscape.resolvedPath}, which is outside static root ${serveRoot}`,
      };
    }

    if (unsupportedBareImports.size > 0) {
      return {
        code: 'browser.unsupported-bare-import',
        bareImports: [...unsupportedBareImports].sort(),
      };
    }

    return {
      code: 'browser.invalid-esm',
      cause: formatEsbuildFailure(error),
    };
  }

  return undefined;
}

interface EsbuildMessage {
  readonly text: string;
  readonly location?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  };
}

interface EsbuildFailure {
  readonly errors: readonly EsbuildMessage[];
}

/**
 * Format an esbuild failure into a single human-readable line.
 * @param error - Unknown error thrown by esbuild.
 * @returns Compact failure summary.
 */
function formatEsbuildFailure(error: unknown): string {
  if (isEsbuildFailure(error) && error.errors.length > 0) {
    const [firstError] = error.errors;
    if (firstError) {
      return formatEsbuildMessage(firstError);
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Render one esbuild message with location data when available.
 * @param message - Esbuild message.
 * @returns Human-readable message.
 */
function formatEsbuildMessage(message: EsbuildMessage): string {
  if (!message.location) {
    return message.text;
  }

  return `${message.text} (${message.location.file}:${message.location.line}:${message.location.column})`;
}

/**
 * Check whether an unknown value looks like an esbuild failure object.
 * @param error - Unknown thrown value.
 * @returns `true` when the value contains esbuild-style errors.
 */
function isEsbuildFailure(error: unknown): error is EsbuildFailure {
  if (typeof error !== 'object' || error === null || !('errors' in error)) {
    return false;
  }

  const candidate = error as { readonly errors?: unknown };
  return Array.isArray(candidate.errors);
}

/**
 * Determine whether a module specifier is bare rather than path-like or URL-like.
 * @param specifier - Module specifier from source code.
 * @returns `true` when the specifier is a bare package import.
 */
function isBareModuleSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#') && !hasProtocol(specifier)
  );
}

/**
 * Determine whether a module specifier is path-like.
 * @param specifier - Module specifier from source code.
 * @returns `true` when the specifier points at the filesystem.
 */
function isPathLikeModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * Check whether a specifier starts with a URI-like protocol.
 * @param specifier - Module specifier to classify.
 * @returns `true` when the specifier has a protocol prefix such as `node:` or `https:`.
 */
function hasProtocol(specifier: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}
