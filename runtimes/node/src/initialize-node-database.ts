import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  findStorageEngine,
  registerStorageEngine,
  resolveStorageEngineForUrl,
  STORAGE_ENGINE_URL_HINTS,
  type StorageDialect,
  type StorageEngine,
} from '@makaio/storage-drizzle';
import { createDatabaseClient, type DatabaseClient } from '@makaio/storage-drizzle/client';
import { runMigrations } from './db-migrations.js';
import { resolveBundledMigrationsDir } from './resolve-bundled-migrations-dir.js';

/**
 * Database backend configuration shared by boot and direct
 * {@link initializeNodeDatabase} callers.
 */
export interface DatabaseBootOptions {
  /**
   * Connection URL.
   *
   * A URL claimed by a registered storage engine — or recognized by the
   * engine hint table (`postgres://` / `postgresql://` via
   * `@makaio/storage-pg`) — selects that engine's backend and outranks every
   * file-path source (`dbPath`, `MAKAIO_DATABASE_PATH`).
   */
  readonly url?: string;
  /**
   * Maximum pooled Postgres connections. Defaults to 4.
   *
   * Ignored for SQLite targets.
   */
  readonly poolMax?: number;
  /**
   * Filesystem directory used as the module-resolution base when auto-loading
   * hinted engine packages such as `@makaio/storage-pg`.
   *
   * Defaults to `process.cwd()`, which matches normal host entrypoints. Hosts
   * launched from another working directory can pass their install root here
   * instead of manually preloading `database.engines`.
   */
  readonly enginePackageImportBasePath?: string;
  /**
   * Storage engines to register explicitly.
   *
   * Registration happens first inside {@link initializeNodeDatabase} — before
   * the database target is resolved — so listed engines are always visible to
   * URL target resolution and client creation. Same-reference re-registration
   * is a no-op, making repeated boots with the same engine objects safe.
   */
  readonly engines?: ReadonlyArray<StorageEngine>;
}

/**
 * Options for {@link initializeNodeDatabase}.
 */
export interface InitializeNodeDatabaseOptions {
  /**
   * Override database file path.
   *
   * Outranked by `database.url` and the `MAKAIO_DATABASE_URL` environment
   * variable. When neither URL source is set, falls back to the
   * `MAKAIO_DATABASE_PATH` environment variable, then
   * `<makaioHome>/makaio.db`.
   */
  dbPath?: string;
  /**
   * Override framework central migrations directory.
   *
   * Bundled hosts copy migrations next to their entrypoint and pass that
   * runtime asset path explicitly because package-local source paths are not
   * available in the final image.
   */
  migrationsDir?: string;
  /**
   * Makaio home directory used to derive the default database path.
   * Superseded by every higher-precedence source: `database.url`,
   * `MAKAIO_DATABASE_URL`, `dbPath`, and `MAKAIO_DATABASE_PATH`.
   */
  makaioHome: string;
  /**
   * Database backend configuration. `database.url` (or env
   * `MAKAIO_DATABASE_URL`) selects a URL-backed target and outranks `dbPath`
   * and `MAKAIO_DATABASE_PATH`.
   */
  readonly database?: DatabaseBootOptions;
}

/**
 * Result returned by {@link initializeNodeDatabase}.
 */
export interface InitializeNodeDatabaseResult {
  databaseClient: DatabaseClient;
  /**
   * Absolute path of the SQLite database file.
   *
   * Absent for URL-backed (Postgres) targets.
   */
  dbPath?: string;
}

/**
 * Determine whether a chmod failure is expected for this runtime.
 * @param error - Error thrown by fs.promises.chmod
 * @returns True when the failure can be safely ignored.
 */
function shouldIgnoreChmodError(error: unknown): boolean {
  if (process.platform === 'win32') {
    // Windows does not reliably apply POSIX file mode semantics.
    return true;
  }

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // Some filesystems/platforms do not support chmod semantics.
  return code === 'ENOSYS' || code === 'EINVAL';
}

// ---------------------------------------------------------------------------
// Internal target discrimination
// ---------------------------------------------------------------------------

type DatabaseTarget =
  | { kind: 'file'; dbPath: string; url: string }
  | { kind: 'url'; url: string; dialect: StorageDialect };

/**
 * Normalize an optional configuration string: empty and whitespace-only
 * values are treated as absent.
 *
 * Environment templating commonly produces set-but-empty variables (for
 * example `MAKAIO_DATABASE_URL=` in a compose or CI template); those must
 * fall through to the next source in the precedence chain instead of being
 * interpreted as a real value.
 * @param value - Raw option or environment variable value.
 * @returns The value, or `undefined` when it is unset, empty, or whitespace-only.
 */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Redact credentials from a connection URL so it can be embedded in an error
 * message without leaking secrets into boot logs.
 *
 * Only components that cannot carry credentials are emitted. With a parsed
 * authority, scheme + host + path identify the misconfigured URL while the
 * userinfo segment and the query string are dropped (libpq-style URIs, and
 * node-postgres via pg-connection-string, accept `password` as a query
 * parameter). Without an authority — e.g. a mangled `postgres:/user:pw@host`
 * missing one slash — the WHATWG parser shifts the whole remainder into the
 * pathname, so such URLs redact to a scheme-only fragment.
 * @param url - Raw connection URL candidate.
 * @returns The URL without its userinfo segment and query string, or a
 *   scheme-only fragment when the value has no parseable authority.
 */
function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.host !== '') {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
  } catch {
    // Fall through to the scheme-only fragment.
  }
  const schemeEnd = url.indexOf(':');
  return schemeEnd === -1 ? '<unparseable database URL>' : `${url.slice(0, schemeEnd + 1)}…`;
}

/**
 * Module surface the URL auto-resolve expects from a storage engine package:
 * a well-known `storageEngine` export carrying the engine definition.
 */
interface StorageEngineModule {
  readonly storageEngine?: StorageEngine;
}

/**
 * Import and register the hinted engine package for a recognized database URL.
 *
 * Auto-resolve fallback of the explicit-first registration contract: when a
 * URL is recognized by the engine hint table but no engine is registered for
 * the hinted dialect, the hinted package is resolved from the host install
 * root and its well-known `storageEngine` export is registered set-if-absent.
 *
 * Resolution is intentionally rooted at the host application, not this
 * framework module: hinted engine packages are optional host dependencies, so
 * strict package managers must see the host as the issuer. Bundled hosts still
 * keep the engine out of the framework bundle because resolution happens at
 * runtime before the resulting file URL is dynamically imported.
 * @param hint - Hinted dialect and the package expected to provide its engine.
 * @param enginePackageImportBasePath - Host install root used to resolve the
 *   hinted package.
 * @param source - Human-readable name of the configuration source that
 *   supplied the database URL, for error messages.
 * @throws Error when the package cannot be loaded (with the import failure as
 *   `cause`) or does not export a matching `storageEngine`.
 */
async function autoRegisterHintedEngine(
  hint: { readonly dialect: StorageDialect; readonly packageName: string },
  enginePackageImportBasePath: string,
  source: string,
): Promise<void> {
  let engineModule: StorageEngineModule;
  try {
    const requireFromHost = createRequire(path.resolve(enginePackageImportBasePath, 'package.json'));
    const engineEntryPath = requireFromHost.resolve(hint.packageName);
    engineModule = (await import(/* @vite-ignore */ pathToFileURL(engineEntryPath).href)) as StorageEngineModule;
  } catch (error) {
    throw new Error(
      `initializeNodeDatabase: the database URL from ${source} targets the '${hint.dialect}' storage engine, ` +
        `but '${hint.packageName}' could not be loaded. Install ${hint.packageName} in the host application, ` +
        `or pass its already-loaded storageEngine via the 'database.engines' boot option.`,
      { cause: error },
    );
  }
  const engine = engineModule.storageEngine;
  if (engine === undefined || engine.dialect !== hint.dialect) {
    throw new Error(
      `initializeNodeDatabase: '${hint.packageName}' does not provide a storage engine for dialect ` +
        `'${hint.dialect}'. Auto-resolved engine packages must export 'storageEngine: StorageEngine' ` +
        `with a matching dialect.`,
    );
  }
  if (findStorageEngine(hint.dialect) === undefined) {
    registerStorageEngine(engine);
  }
}

/**
 * Resolve the database target from the provided options and environment.
 *
 * Precedence (empty and whitespace-only values count as unset):
 * 1. `options.database?.url`
 * 2. `process.env.MAKAIO_DATABASE_URL`
 * 3. `options.dbPath`
 * 4. `process.env.MAKAIO_DATABASE_PATH`
 * 5. `path.join(options.makaioHome, 'makaio.db')`
 *
 * When a URL candidate (steps 1–2) is present, it is resolved against the
 * storage engine registry: a registered engine that claims the URL yields a
 * `kind: 'url'` target carrying the engine's dialect; a URL recognized by the
 * engine hint table without a registered engine triggers the
 * {@link autoRegisterHintedEngine} fallback first. When no engine claims the
 * candidate, an error is thrown naming the source that supplied it
 * (credentials redacted). Steps 3–5 are only evaluated when no URL candidate
 * exists and always produce a `kind: 'file'` target whose path is resolved to
 * an absolute path against the working directory.
 * @param options - Initialization options.
 * @returns Resolved database target.
 * @throws Error when a URL candidate is present but no engine serves it.
 */
async function resolveDatabaseTarget(options: InitializeNodeDatabaseOptions): Promise<DatabaseTarget> {
  const optionUrl = nonEmpty(options.database?.url);
  const urlCandidate = optionUrl ?? nonEmpty(process.env.MAKAIO_DATABASE_URL);
  if (urlCandidate !== undefined) {
    const source =
      optionUrl !== undefined ? "the 'database.url' boot option" : 'the MAKAIO_DATABASE_URL environment variable';
    let resolution = resolveStorageEngineForUrl(urlCandidate);
    if (resolution.kind === 'missing-engine') {
      await autoRegisterHintedEngine(
        resolution,
        options.database?.enginePackageImportBasePath ?? process.cwd(),
        source,
      );
      resolution = resolveStorageEngineForUrl(urlCandidate);
    }
    if (resolution.kind !== 'engine') {
      const hintedPackages = STORAGE_ENGINE_URL_HINTS.map((hint) => hint.packageName).join(', ');
      throw new Error(
        `initializeNodeDatabase: unsupported database URL '${redactDatabaseUrl(urlCandidate)}' from ${source}. ` +
          `URL targets require a storage engine that claims the URL ` +
          `(e.g. postgres:// / postgresql:// via ${hintedPackages}); SQLite targets are configured via ` +
          `the dbPath option or MAKAIO_DATABASE_PATH.`,
      );
    }
    return { kind: 'url', url: urlCandidate, dialect: resolution.engine.dialect };
  }
  // Resolved against the working directory so the returned dbPath honors the
  // documented absolute-path contract even when the option or environment
  // variable supplies a relative value.
  const dbPath = path.resolve(
    nonEmpty(options.dbPath) ??
      nonEmpty(process.env.MAKAIO_DATABASE_PATH) ??
      path.join(options.makaioHome, 'makaio.db'),
  );
  return { kind: 'file', dbPath, url: pathToFileURL(dbPath).href };
}

/**
 * Initialize the runtime database (SQLite file or Postgres URL) for Node
 * runtime persistence.
 *
 * Resolution order for the connection target (empty and whitespace-only
 * values count as unset):
 * 1. `options.database?.url`
 * 2. `process.env.MAKAIO_DATABASE_URL`
 * 3. `options.dbPath`
 * 4. `process.env.MAKAIO_DATABASE_PATH`
 * 5. `path.join(options.makaioHome, 'makaio.db')`
 *
 * Engine registration precedes target resolution by construction: engines
 * passed via `database.engines` are registered first, and URL candidates that
 * are recognized but unregistered auto-resolve their hinted engine package
 * ({@link autoRegisterHintedEngine}) before the target is classified.
 *
 * URL targets (engine-served, e.g. `postgres://` / `postgresql://`) perform
 * no filesystem work (no mkdir, no chmod, no `file:` conversion). The
 * bundled-layout migrations resolver is applied only for URL targets because
 * SQLite (file) targets resolve their default inside the migrations reader —
 * bundled hosts replace that reader entirely — so the resolver probe applies
 * only where it is safe.
 * @param options - Configuration; see {@link InitializeNodeDatabaseOptions}.
 * @returns Initialized database client and resolved database path (absent for
 *   URL-backed targets).
 */
export async function initializeNodeDatabase(
  options: InitializeNodeDatabaseOptions,
): Promise<InitializeNodeDatabaseResult> {
  // Explicit engine registration always precedes target resolution and client
  // creation, on every entry surface that flows through this function.
  for (const engine of options.database?.engines ?? []) {
    registerStorageEngine(engine);
  }

  const target = await resolveDatabaseTarget(options);

  if (target.kind === 'url') {
    const databaseClient = await createDatabaseClient({
      url: target.url,
      postgres: { poolMax: options.database?.poolMax },
    });
    try {
      // SQLite targets resolve their default inside the migrations reader —
      // bundled hosts replace that reader entirely — so the bundled-layout
      // probe applies only to URL targets here.
      const migrationsDir = options.migrationsDir ?? resolveBundledMigrationsDir(target.dialect);
      await runMigrations(databaseClient.db, { migrationsDir });
      return { databaseClient };
    } catch (error) {
      await databaseClient.close();
      throw error;
    }
  }

  // SQLite file target: ensure the parent directory exists, open the client,
  // migrate, then harden file permissions.
  const { dbPath } = target;

  // Ensure parent directory exists (for both default and custom paths)
  const dbDir = path.dirname(dbPath);
  await fs.promises.mkdir(dbDir, { recursive: true });

  const databaseClient = await createDatabaseClient({ url: target.url });
  try {
    await runMigrations(databaseClient.db, { migrationsDir: options.migrationsDir });
    // Best-effort hardening: some platforms/filesystems may not support POSIX modes.
    try {
      await fs.promises.chmod(dbPath, 0o600);
    } catch (error) {
      if (!shouldIgnoreChmodError(error)) {
        throw error;
      }
      console.warn(
        '[initializeNodeDatabase] Failed to set SQLite file permissions (continuing; this may be unsupported on Windows):',
        error,
      );
    }
    return { databaseClient, dbPath };
  } catch (error) {
    await databaseClient.close();
    throw error;
  }
}
