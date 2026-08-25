import { builtinModules, registerHooks, type ModuleHooks } from 'node:module';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Resolve-time guard that makes the host-configured package map the whole
// truth about which ordinary packages a materialized program can import.
//
// Linking only the configured packages into the program's own `node_modules`
// is not sufficient on its own: Node resolves a bare specifier by walking
// *up* from the importing module, so any `node_modules` directory above the
// temporary program root — ambient host state the provider never chose —
// satisfies an unlisted import. This guard closes that walk by classifying the
// specifier before resolution reaches the filesystem at all.
//
// It bounds which ordinary packages resolve. It is not an isolation boundary:
// `node:` builtins, absolute and `file:` specifiers, and direct filesystem
// access all remain available to executed code, as the provider documents.
//
// `module.registerHooks` is the synchronous, in-thread hook API, available from
// Node 22.15 — which is this package's declared floor, so the guard is present
// on every runtime the package supports rather than being a best-effort extra.

/** Node builtins, resolvable with or without the `node:` prefix. */
const BUILTIN_MODULES = new Set(builtinModules);

/** Matches any URL-scheme prefix, so `node:`, `file:`, and `data:` all pass through. */
const URL_SCHEME_PREFIX = /^[a-z][a-z\d+.-]*:/i;

/** Node error codes that mean a specifier could not be resolved. */
const UNRESOLVED_IMPORT_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'ERR_UNSUPPORTED_DIR_IMPORT',
]);

/** Resolver-originated failures retained without mutating the thrown object. */
const unresolvedImportErrors = new WeakSet<object>();

/**
 * Failure raised for an ordinary import the host did not configure.
 *
 * Carries Node's own "module not found" code so the worker entry classifies it
 * through the same path as a genuinely unresolvable specifier — an unlisted
 * package and a misspelled one are the same fact to the program's author, and
 * the guard should not invent a second way to say it.
 *
 * The message deliberately uses the `Cannot find package '<name>'` phrasing
 * rather than `Cannot find module '<specifier>'`: the TypeScript loader parses
 * the latter and retries resolution with the quoted text as a URL, which would
 * turn one clean rejection into a second, unrelated resolution failure.
 */
class UnsupportedImportError extends Error {
  /** Node error code the worker entry maps onto `unsupported_import`. */
  public readonly code = 'ERR_MODULE_NOT_FOUND';

  /**
   * @param packageName - Top-level package name that was not configured.
   * @param parentUrl - Module that imported it, named as Node names it.
   */
  public constructor(packageName: string, parentUrl: string) {
    super(`Cannot find package '${packageName}' imported from ${parentUrl}`);
    this.name = 'UnsupportedImportError';
  }
}

/**
 * Read a Node error code without trusting getters on the thrown value.
 * @param error - Failure raised by the next resolver in the hook chain.
 * @returns String error code when it can be read safely.
 */
function readErrorCode(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error) || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Report whether an import failure is known to have originated in resolution.
 * @param error - Failure caught by the worker's import boundary.
 * @returns Whether the allowlist or a downstream resolver produced the failure.
 */
export function isUnsupportedImportError(error: unknown): boolean {
  return (
    error instanceof UnsupportedImportError ||
    ((typeof error === 'object' || typeof error === 'function') && error !== null && unresolvedImportErrors.has(error))
  );
}

/**
 * Read the top-level package name a specifier would resolve through.
 *
 * Only ordinary bare specifiers have one. Relative and absolute specifiers name
 * a location rather than a package, anything carrying a URL scheme is already
 * fully resolved, a builtin resolves without touching the filesystem, and an
 * empty specifier names nothing — none of them can reach an ancestor
 * `node_modules`, so none of them is the guard's business, and each is left to
 * produce whatever diagnostic Node produces for it.
 * @param specifier - Specifier exactly as written by the importing module.
 * @returns The package name to check, or `undefined` when nothing is bare.
 */
function readPackageName(specifier: string): string | undefined {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (URL_SCHEME_PREFIX.test(specifier)) return undefined;
  const segments = specifier.split('/');
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? '');
  return name === '' || BUILTIN_MODULES.has(name) ? undefined : name;
}

/**
 * Reject ordinary imports the host did not configure, for one program root.
 *
 * The guard applies to exactly the modules that live under `programRootUrls`,
 * which is what keeps it from touching the worker's own module graph, the
 * TypeScript loader's, or the pool's. Three consequences follow from that
 * scoping and all three are deliberate:
 *
 * - Every spelling of the root has to be supplied, because the loader reports
 *   an importing module by its *real* path. A guard given only the created
 *   spelling of a root reached through a symlink — which on macOS is every
 *   program root, since the temporary base is itself reached through one —
 *   matches nothing and silently allows everything. That is why the
 *   materializer establishes those spellings rather than leaving each caller to
 *   guess one.
 * - A configured package is linked in as a symlink and therefore resolves to a
 *   path outside the program root, so *its* own dependencies are resolved
 *   without the guard. The host configured that package; vouching for it means
 *   vouching for what it depends on.
 * - Concurrent invocations each register their own guard keyed on their own
 *   root, so they neither see nor cancel one another.
 *
 * Registered as a synchronous hook, which composes with the TypeScript loader
 * in either registration order. Registering *before* it is preferred: the guard
 * then sits closest to Node's own resolution and sees only clean specifiers,
 * rather than also seeing the loader's internal wrapper specifiers.
 * @param programRootUrls - `file:` URL prefixes of the program root, each ending in a slash.
 * @param allowedPackages - Ordinary package names the host configured.
 * @returns Handle whose `deregister()` removes the guard again.
 */
export function registerImportAllowlist(
  programRootUrls: readonly string[],
  allowedPackages: readonly string[],
): ModuleHooks {
  const allowed = new Set(allowedPackages);
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      // The importing module decides whether the guard applies, so the entry
      // module's own resolution — whose parent is the generated manifest — is
      // covered along with everything it pulls in. The trailing slash each
      // prefix carries is what stops a sibling root with a longer name from
      // matching.
      const parentUrl = context.parentURL;
      if (parentUrl !== undefined && programRootUrls.some((rootUrl) => parentUrl.startsWith(rootUrl))) {
        const packageName = readPackageName(specifier);
        if (packageName !== undefined && !allowed.has(packageName)) {
          throw new UnsupportedImportError(packageName, parentUrl);
        }
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          UNRESOLVED_IMPORT_CODES.has(readErrorCode(error) ?? '') &&
          (typeof error === 'object' || typeof error === 'function') &&
          error !== null
        ) {
          unresolvedImportErrors.add(error);
        }
        throw error;
      }
    },
  });
}
