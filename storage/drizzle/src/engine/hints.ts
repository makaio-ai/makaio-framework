/**
 * URL-scheme hints for storage engines that ship as separate packages.
 *
 * The hint table is the only place this package keeps URL-scheme knowledge
 * for engines it does not contain. It exists to power actionable errors and
 * host auto-registration: when a database URL is recognized but no matching
 * engine is registered, the hint names the package to install. The hint
 * package name is data — this package never imports it.
 * @packageDocumentation
 */
import type { StorageDialect } from '../types';

/**
 * Static mapping from a recognizable database URL shape to the package that
 * provides the engine for it.
 */
export interface StorageEngineUrlHint {
  /** Dialect the hinted engine serves. */
  readonly dialect: StorageDialect;

  /** Package that exports the engine as `storageEngine`. */
  readonly packageName: string;

  /**
   * Returns `true` when a database URL belongs to the hinted engine.
   * @param url - Database URL to test.
   * @returns Whether the URL is recognized by this hint.
   */
  matchesUrl(url: string): boolean;
}

/**
 * All known URL hints, in match order.
 *
 * Postgres: both `postgres://` and `postgresql://` schemes are accepted,
 * case-insensitively. The engine lives in `@makaio/storage-pg`.
 */
export const STORAGE_ENGINE_URL_HINTS: readonly StorageEngineUrlHint[] = [
  {
    dialect: 'postgres',
    packageName: '@makaio/storage-pg',
    matchesUrl: (url) => /^postgres(ql)?:\/\//i.test(url),
  },
];

/**
 * Find the hint whose URL shape matches the given database URL.
 * @param url - Database URL to test against all hints.
 * @returns The matching hint, or `undefined` when no hint recognizes the URL.
 */
export function findStorageEngineUrlHint(url: string): StorageEngineUrlHint | undefined {
  return STORAGE_ENGINE_URL_HINTS.find((hint) => hint.matchesUrl(url));
}

/**
 * Find the hint for a dialect, if one exists.
 * @param dialect - Storage dialect to look up.
 * @returns The hint for the dialect, or `undefined` when the dialect has no
 *   separately-packaged engine.
 */
export function findStorageEngineHintForDialect(dialect: StorageDialect): StorageEngineUrlHint | undefined {
  return STORAGE_ENGINE_URL_HINTS.find((hint) => hint.dialect === dialect);
}

/**
 * Build the actionable error message for a dialect whose engine is not
 * registered.
 *
 * Single source of truth for both failure surfaces: the client factory's
 * missing-engine rejection and the runtime host's boot error.
 * @param dialect - Dialect the caller tried to resolve.
 * @param packageName - Package that provides the missing engine.
 * @returns Human-readable, actionable error message.
 */
export function describeMissingStorageEngine(dialect: StorageDialect, packageName: string): string {
  return (
    `No storage engine is registered for dialect '${dialect}'. ` +
    `Install ${packageName} and pass its exported storageEngine via the boot 'database.engines' option ` +
    `or register it with registerStorageEngine(). ` +
    `Node runtime hosts auto-register it for recognized database URLs.`
  );
}
