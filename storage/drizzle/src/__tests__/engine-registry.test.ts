/**
 * Tests for the global storage engine registry.
 *
 * All assertions run against the real `globalThis`-backed registry singleton
 * — no mocks. Tests that register a non-default engine clean their entry out
 * of the shared map afterwards via the registry's documented `Symbol.for`
 * storage contract, so the cross-file singleton stays pristine.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import {
  findStorageEngine,
  getStorageEngine,
  registerStorageEngine,
  resolveStorageEngine,
  resolveStorageEngineForUrl,
} from '../engine/registry';
import { sqliteStorageEngine } from '../engine/sqlite/engine';
import type { StorageEngine } from '../engine/types';
import { brandDatabase, getRawSqlExecutor } from '../raw-sql';
import type { StorageDialect } from '../types';
import { buildPostgresEngineDouble } from './postgres-engine-double';

/** The registry's documented `globalThis` storage key. */
const ENGINE_REGISTRY: unique symbol = Symbol.for('makaio.storage.engineRegistry');

/** View of `globalThis` exposing the registry map for test cleanup. */
interface EngineRegistryCarrier {
  [ENGINE_REGISTRY]?: Map<StorageDialect, StorageEngine>;
}

afterEach(() => {
  // Remove any non-default engine a test registered; the seeded sqlite
  // default engine stays (re-seeded set-if-absent on next access anyway).
  (globalThis as EngineRegistryCarrier)[ENGINE_REGISTRY]?.delete('postgres');
});

describe('engine registry seeding', () => {
  it('pre-seeds the built-in sqlite engine on first access', () => {
    expect(findStorageEngine('sqlite')).toBe(sqliteStorageEngine);
    expect(getStorageEngine('sqlite')).toBe(sqliteStorageEngine);
  });

  it('stores the registry on globalThis under the Symbol.for key', () => {
    // Symbol.for is load-bearing: duplicated module instances must resolve
    // the same registry through the global symbol registry.
    getStorageEngine('sqlite');
    const registry = (globalThis as EngineRegistryCarrier)[ENGINE_REGISTRY];
    expect(registry?.get('sqlite')).toBe(sqliteStorageEngine);
  });
});

describe('registerStorageEngine', () => {
  it('treats same-reference re-registration as a no-op', () => {
    expect(() => registerStorageEngine(sqliteStorageEngine)).not.toThrow();

    const engine = buildPostgresEngineDouble();
    registerStorageEngine(engine);
    expect(() => registerStorageEngine(engine)).not.toThrow();
    expect(getStorageEngine('postgres')).toBe(engine);
  });

  it('throws when a different engine object targets an already-registered dialect', () => {
    registerStorageEngine(buildPostgresEngineDouble());
    expect(() => registerStorageEngine(buildPostgresEngineDouble())).toThrow(/already registered.*'postgres'/);
  });

  it('rejects replacing the seeded sqlite default engine', () => {
    const rogueSqliteEngine: StorageEngine = { ...sqliteStorageEngine };
    expect(() => registerStorageEngine(rogueSqliteEngine)).toThrow(/already registered.*'sqlite'/);
    expect(getStorageEngine('sqlite')).toBe(sqliteStorageEngine);
  });
});

describe('getStorageEngine without a registered engine', () => {
  it('throws the actionable install hint for postgres', () => {
    expect(() => getStorageEngine('postgres')).toThrow(/@makaio\/storage-pg/);
    expect(() => getStorageEngine('postgres')).toThrow(/dialect 'postgres'/);
    expect(() => getStorageEngine('postgres')).toThrow(/registerStorageEngine/);
  });

  it('findStorageEngine returns undefined instead of throwing', () => {
    expect(findStorageEngine('postgres')).toBeUndefined();
  });
});

describe('resolveStorageEngine', () => {
  it('resolves unbranded handles to the sqlite default engine', () => {
    const rawDb = drizzle({ connection: { url: ':memory:' } });
    try {
      expect(resolveStorageEngine(rawDb)).toBe(sqliteStorageEngine);
    } finally {
      rawDb.$client.close();
    }
  });

  it('resolves a postgres-branded handle to the registered postgres engine', () => {
    const engine = buildPostgresEngineDouble();
    registerStorageEngine(engine);

    const rawDb = drizzle({ connection: { url: ':memory:' } });
    try {
      const db = brandDatabase(rawDb, 'postgres', { ...getRawSqlExecutor(rawDb), dialect: 'postgres' as const });
      expect(resolveStorageEngine(db)).toBe(engine);
    } finally {
      rawDb.$client.close();
    }
  });
});

describe('resolveStorageEngineForUrl', () => {
  it('reports missing-engine with the install package for unclaimed postgres URLs', () => {
    for (const url of [
      'postgres://user:pw@localhost:5432/makaio',
      'postgresql://user:pw@localhost:5432/makaio',
      'POSTGRES://user:pw@localhost:5432/makaio',
    ]) {
      expect(resolveStorageEngineForUrl(url)).toEqual({
        kind: 'missing-engine',
        dialect: 'postgres',
        packageName: '@makaio/storage-pg',
      });
    }
  });

  it('resolves a registered engine via its matchesUrl claim', () => {
    const engine = buildPostgresEngineDouble();
    registerStorageEngine(engine);

    expect(resolveStorageEngineForUrl('postgres://user:pw@localhost:5432/makaio')).toEqual({
      kind: 'engine',
      engine,
    });
  });

  it('prefers a registered engine over the hint even when the engine declares no matchesUrl', () => {
    // The missing-engine kind must stay honest: a hint match may not report
    // the engine as missing while one is registered for the hinted dialect.
    const { matchesUrl: _unused, ...engineWithoutUrlClaim } = buildPostgresEngineDouble();
    registerStorageEngine(engineWithoutUrlClaim);

    expect(resolveStorageEngineForUrl('postgres://user:pw@localhost:5432/makaio')).toEqual({
      kind: 'engine',
      engine: engineWithoutUrlClaim,
    });
  });

  it('resolves sqlite-shaped and remote libsql URLs to the default', () => {
    for (const url of ['file:./makaio.db', ':memory:', 'libsql://example.turso.io', 'http://localhost:8080']) {
      expect(resolveStorageEngineForUrl(url)).toEqual({ kind: 'default' });
    }
  });
});
