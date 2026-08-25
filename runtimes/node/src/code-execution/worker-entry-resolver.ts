import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Resolves the CodeExecution worker entrypoint for the running package layout.
//
// Unlike a plain path resolver this also returns how the worker thread has to
// be launched: the TypeScript source entry only runs under a TypeScript entry
// loader and only resolves correctly once that loader is pinned to an isolated
// tsconfig, while the built entry is plain ESM and must not pull either in.
// Returning the entry, its Node CLI arguments, and its environment together is
// what keeps the three from drifting apart.
//
// The two layouts are held to the same resolution guarantee. Nothing about the
// package map, the import allowlist, or which imports a submitted program can
// make succeed depends on which entry a host runs.

/** Subdirectory that holds the CodeExecution worker entry in every package layout. */
const WORKER_DIRECTORY = 'code-execution';

/** Worker entry build mode. */
export type CodeExecutionWorkerEntryMode = 'source' | 'dist';

/**
 * Node CLI arguments required to run the TypeScript source worker entry.
 *
 * This registers a process-wide TypeScript loader *beneath* the worker entry's
 * own scoped loader and beneath the import allowlist, so an unlisted bare
 * specifier is refused before this loader is consulted at all. What it does
 * still decide is where an *allowed* name resolves to — and left to its own
 * devices it discovers a tsconfig by walking up from the working directory. See
 * {@link buildSourceWorkerEnv} for why that is not acceptable.
 */
const SOURCE_WORKER_EXEC_ARGV: readonly string[] = ['--import=tsx'];

/** Node CLI arguments required to run the built worker entry. */
const DIST_WORKER_EXEC_ARGV: readonly string[] = [];

/**
 * File name of the alias-free tsconfig the source-mode loader is pinned to.
 *
 * Ships beside the worker entry rather than being generated, because it is a
 * property of this package's source layout and not of any invocation: one file
 * serves every provider, every pool generation, and every execution, and there
 * is correspondingly nothing to clean up.
 *
 * Deliberately *not* named `tsconfig.json`. This directory is ordinary package
 * source, and a file by that name here would be picked up by the toolchain
 * compiling the package itself.
 */
const SOURCE_WORKER_TSCONFIG_FILE = 'worker-tsconfig.json';

/**
 * Environment variable through which the TypeScript loader accepts a tsconfig.
 *
 * Read when the loader's hooks initialize — in the thread that owns them — so
 * setting it on a spawned worker thread's environment is what scopes it to that
 * worker rather than to the host process.
 */
const TYPESCRIPT_LOADER_TSCONFIG_ENV = 'TSX_TSCONFIG_PATH';

/** Environment the built worker entry requires: none, because it loads no loader. */
const DIST_WORKER_ENV: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Build the environment that pins the source-mode loader to an isolated tsconfig.
 *
 * Naming an explicit tsconfig is what keeps the host's package map the whole
 * truth about configured imports in source mode, rather than only about which
 * *names* resolve.
 *
 * The tsconfig this loader would otherwise discover belongs to whatever
 * repository the host happens to run from, and a `paths` alias in it is applied
 * before Node's own `node_modules` lookup. The import allowlist is unaffected —
 * it sits above this loader and refuses an unconfigured name before the alias is
 * ever consulted — but for a name the host *did* configure, the alias wins over
 * the materialized package link. A program importing that name would then be
 * handed the host repository's own source instead of the package root the host
 * configured, silently, and only on hosts whose build configuration happens to
 * mention that name. Pinning the loader to a tsconfig that declares no aliases
 * leaves nothing to expand, so the link decides, exactly as it does in `dist`
 * mode where no such loader exists.
 *
 * Only alias expansion is removed. The pinned tsconfig still selects the
 * transpilation settings the loader applies, so the package's own TypeScript
 * sources — the worker entry and everything it imports — compile exactly as
 * before. The submitted program's own modules are unaffected either way: they
 * are transpiled by the scoped loader the worker entry registers with tsconfig
 * discovery already disabled.
 * @param moduleDir - Package source root containing the worker directory.
 * @returns Environment variables the source worker entry requires.
 */
function buildSourceWorkerEnv(moduleDir: string): Readonly<Record<string, string>> {
  return Object.freeze({
    [TYPESCRIPT_LOADER_TSCONFIG_ENV]: join(moduleDir, WORKER_DIRECTORY, SOURCE_WORKER_TSCONFIG_FILE),
  });
}

/**
 * Options for resolving the CodeExecution worker entrypoint.
 *
 * `moduleDir` is the package's source or distribution root — the directory
 * that contains the `code-execution/` subdirectory. Naming that root rather
 * than the package root keeps the resolution correct in every supported
 * layout, including nested distribution directories where a package-root
 * shape would produce a duplicated path segment.
 */
export interface CodeExecutionWorkerEntryResolverOptions {
  /** Absolute path to the package's source or distribution root. */
  readonly moduleDir: string;
  /** Whether to resolve the TypeScript source entry or the built entry. */
  readonly mode: CodeExecutionWorkerEntryMode;
}

/** Resolved worker entrypoint and everything a worker thread needs to run it. */
export interface CodeExecutionWorkerEntry {
  /** Absolute path to the worker entrypoint file. */
  readonly filename: string;
  /** Node CLI arguments to pass to spawned worker threads. */
  readonly execArgv: readonly string[];
  /**
   * Environment variables the entry's loader requires, if any.
   *
   * Provider-owned rather than host-owned: these configure the loader named by
   * {@link execArgv}, so they belong to the same decision and must not be
   * overridable by a host's own worker environment.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Resolve the CodeExecution worker entrypoint for an explicit layout.
 *
 * In `source` mode the TypeScript entry is returned together with the
 * TypeScript entry loader argument and the environment that pins that loader to
 * an isolated tsconfig. In `dist` mode the built ESM entry is returned with
 * neither, because the built package must not depend on a TypeScript toolchain
 * being present at runtime.
 * @param options - Package source or distribution root and the entry mode.
 * @returns Worker entry filename, Node CLI arguments, and loader environment.
 */
export function resolveCodeExecutionWorkerEntry(
  options: CodeExecutionWorkerEntryResolverOptions,
): CodeExecutionWorkerEntry {
  if (options.mode === 'source') {
    return {
      filename: join(options.moduleDir, WORKER_DIRECTORY, 'worker-entry.ts'),
      execArgv: SOURCE_WORKER_EXEC_ARGV,
      env: buildSourceWorkerEnv(options.moduleDir),
    };
  }
  return {
    filename: join(options.moduleDir, WORKER_DIRECTORY, 'worker-entry.mjs'),
    execArgv: DIST_WORKER_EXEC_ARGV,
    env: DIST_WORKER_ENV,
  };
}

/**
 * Resolve the worker entrypoint that matches the calling module's own layout.
 *
 * The mode follows the calling module's file extension, and the package root
 * follows its directory: modules that live in the `code-execution/`
 * subdirectory resolve one level up, while a module bundled directly into the
 * package root already sits at that root. This covers the source layout and
 * both distribution layouts without any host-supplied configuration.
 * @param moduleUrl - `import.meta.url` of the calling module.
 * @returns Worker entry filename, Node CLI arguments, and loader environment.
 */
export function resolveDefaultCodeExecutionWorkerEntry(moduleUrl: string): CodeExecutionWorkerEntry {
  const modulePath = fileURLToPath(moduleUrl);
  const containingDir = dirname(modulePath);
  const moduleDir = basename(containingDir) === WORKER_DIRECTORY ? dirname(containingDir) : containingDir;
  return resolveCodeExecutionWorkerEntry({
    moduleDir,
    mode: extname(modulePath) === '.ts' ? 'source' : 'dist',
  });
}
