/**
 * Global storage engine registry.
 *
 * One engine per dialect, stored on `globalThis` under a `Symbol.for` key so
 * the registry survives duplicated module instances (a bundled dist copy and
 * a workspace copy of this package resolve the same map through the global
 * symbol registry — the same hazard model as the `DATABASE_DIALECT` brand).
 *
 * The built-in SQLite engine is seeded set-if-absent on first registry
 * access, making it the always-available default engine. Additional engines
 * register explicitly — via `registerStorageEngine` or host boot options;
 * Node runtime hosts additionally auto-register hinted engines for
 * recognized database URLs.
 * @packageDocumentation
 */
import { getDatabaseDialect, type MakaioDatabase, type StorageDialect } from '../types';
import { describeMissingStorageEngine, findStorageEngineHintForDialect, findStorageEngineUrlHint } from './hints';
import { sqliteStorageEngine } from './sqlite/engine';
import type { StorageEngine } from './types';

/**
 * Registry key on `globalThis`. Declared via `Symbol.for` so duplicated
 * module instances resolve the same map through the global symbol registry.
 */
const ENGINE_REGISTRY: unique symbol = Symbol.for('makaio.storage.engineRegistry');

/**
 * Internal view of `globalThis` that may carry the engine registry map.
 */
interface EngineRegistryCarrier {
  [ENGINE_REGISTRY]?: Map<StorageDialect, StorageEngine>;
}

/**
 * Resolve the registry map, creating it and seeding the built-in SQLite
 * engine (set-if-absent) on first access.
 * @returns The global dialect→engine map.
 */
function getRegistry(): Map<StorageDialect, StorageEngine> {
  const carrier = globalThis as EngineRegistryCarrier;
  let registry = carrier[ENGINE_REGISTRY];
  if (registry === undefined) {
    registry = new Map<StorageDialect, StorageEngine>();
    Object.defineProperty(carrier, ENGINE_REGISTRY, {
      value: registry,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  if (!registry.has(sqliteStorageEngine.dialect)) {
    registry.set(sqliteStorageEngine.dialect, sqliteStorageEngine);
  }
  return registry;
}

/**
 * Register a storage engine for its dialect.
 *
 * Re-registering the same engine object is a no-op, so idempotent
 * registration helpers and duplicated boot paths are safe. Registering a
 * *different* engine object for an already-registered dialect throws: one
 * dialect has exactly one engine per process, and silently replacing it would
 * change behavior for every open handle.
 * @param engine - Engine to register under its `dialect`.
 * @throws Error when a different engine is already registered for the dialect.
 */
export function registerStorageEngine(engine: StorageEngine): void {
  const registry = getRegistry();
  const existing = registry.get(engine.dialect);
  if (existing === engine) {
    return;
  }
  if (existing !== undefined) {
    throw new Error(
      `registerStorageEngine: a different engine is already registered for dialect '${engine.dialect}'. ` +
        'One dialect has exactly one engine per process; check for duplicated package installations.',
    );
  }
  registry.set(engine.dialect, engine);
}

/**
 * Resolve the engine registered for a dialect, throwing an actionable error
 * when it is absent.
 *
 * For dialects with a known engine package (see the URL hint table) the error
 * names the package to install; otherwise it points at
 * {@link registerStorageEngine}.
 * @param dialect - Storage dialect to resolve.
 * @returns The registered engine.
 * @throws Error when no engine is registered for the dialect.
 */
export function getStorageEngine(dialect: StorageDialect): StorageEngine {
  const engine = getRegistry().get(dialect);
  if (engine !== undefined) {
    return engine;
  }
  const hint = findStorageEngineHintForDialect(dialect);
  if (hint !== undefined) {
    throw new Error(describeMissingStorageEngine(dialect, hint.packageName));
  }
  throw new Error(
    `getStorageEngine: no storage engine is registered for dialect '${dialect}'. ` +
      'Register one with registerStorageEngine() before resolving it.',
  );
}

/**
 * Resolve the engine registered for a dialect, or `undefined` when absent.
 * @param dialect - Storage dialect to look up.
 * @returns The registered engine, or `undefined`.
 */
export function findStorageEngine(dialect: StorageDialect): StorageEngine | undefined {
  return getRegistry().get(dialect);
}

/**
 * Resolve the engine serving a database handle, via the handle's dialect
 * brand (unbranded handles resolve to the SQLite default engine).
 * @param db - Database handle to resolve the engine for.
 * @returns The engine serving the handle's dialect.
 * @throws Error when no engine is registered for the handle's dialect.
 */
export function resolveStorageEngine(db: MakaioDatabase<Record<string, unknown>>): StorageEngine {
  return getStorageEngine(getDatabaseDialect(db));
}

/**
 * Result of resolving a database URL against the engine registry.
 *
 * - `'engine'` — a registered engine serves the URL.
 * - `'missing-engine'` — the URL is recognized (hint table) but the engine
 *   package is not registered; `packageName` names the package to install or
 *   auto-import.
 * - `'default'` — no engine claims the URL; it belongs to the default
 *   (SQLite) engine.
 */
export type StorageEngineUrlResolution =
  | { kind: 'engine'; engine: StorageEngine }
  | { kind: 'missing-engine'; dialect: StorageDialect; packageName: string }
  | { kind: 'default' };

/**
 * Resolve a database URL to the engine that serves it.
 *
 * Checks registered engines' `matchesUrl` claims in registration order, then
 * the URL hint table, and falls back to `'default'`. A hint match is reported
 * as `'missing-engine'` only when the hinted dialect truly has no registered
 * engine — when one is registered (without claiming the URL itself), the
 * registered engine wins so the result kind stays honest.
 * @param url - Database URL to resolve.
 * @returns The resolution: a serving engine, a missing-engine hint, or the default.
 */
export function resolveStorageEngineForUrl(url: string): StorageEngineUrlResolution {
  const registry = getRegistry();
  for (const engine of registry.values()) {
    if (engine.matchesUrl !== undefined && engine.matchesUrl(url)) {
      return { kind: 'engine', engine };
    }
  }
  const hint = findStorageEngineUrlHint(url);
  if (hint !== undefined) {
    const registered = registry.get(hint.dialect);
    if (registered !== undefined) {
      return { kind: 'engine', engine: registered };
    }
    return { kind: 'missing-engine', dialect: hint.dialect, packageName: hint.packageName };
  }
  return { kind: 'default' };
}
