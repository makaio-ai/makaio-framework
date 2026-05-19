import { describe, it, expect } from 'bun:test';
import { lastWriteWinsResolver, createConflictResolver, type ConflictResolver } from '../conflict-resolvers.js';
import type { StoredPreference } from '../types.js';

type ResolveFn = ConflictResolver['resolve'];

/**
 * Helper to create a StoredPreference with test data.
 * @param value - User value to serialize
 * @param updatedAt - Timestamp in milliseconds
 * @returns StoredPreference instance
 */
const createPref = (value: unknown, updatedAt: number): StoredPreference => ({
  value: JSON.stringify(value),
  updatedAt,
});

describe('lastWriteWinsResolver', () => {
  it('returns null when both are null', () => {
    expect(lastWriteWinsResolver.resolve(null, null)).toBeNull();
  });

  it('returns database when local is null', () => {
    const db = createPref({ test: true }, 1000);
    expect(lastWriteWinsResolver.resolve(null, db)).toBe(db);
  });

  it('returns local when database is null', () => {
    const local = createPref({ test: true }, 1000);
    expect(lastWriteWinsResolver.resolve(local, null)).toBe(local);
  });

  it('returns local when local is newer', () => {
    const local = createPref({ name: 'local' }, 2000);
    const db = createPref({ name: 'database' }, 1000);
    expect(lastWriteWinsResolver.resolve(local, db)).toBe(local);
  });

  it('returns database when database is newer', () => {
    const local = createPref({ name: 'local' }, 1000);
    const db = createPref({ name: 'database' }, 2000);
    expect(lastWriteWinsResolver.resolve(local, db)).toBe(db);
  });

  it('returns database when timestamps are equal', () => {
    const local = createPref({ name: 'local' }, 1000);
    const db = createPref({ name: 'database' }, 1000);
    // Consistent tie-breaking: prefer database
    expect(lastWriteWinsResolver.resolve(local, db)).toBe(db);
  });

  it('handles complex values correctly', () => {
    const localValue = { nested: { deep: { value: 42 } }, array: [1, 2, 3] };
    const dbValue = { different: 'structure' };
    const local = createPref(localValue, 2000);
    const db = createPref(dbValue, 1000);
    expect(lastWriteWinsResolver.resolve(local, db)).toBe(local);
  });
});

describe('createConflictResolver', () => {
  it('creates resolver with custom function', () => {
    const resolveFn: ResolveFn = (local, db) => local ?? db;
    const custom = createConflictResolver(resolveFn);
    const local = createPref('local', 100);
    const db = createPref('db', 200);
    // Custom function always prefers local
    expect(custom.resolve(local, db)).toBe(local);
  });

  it('custom function receives correct arguments', () => {
    const local = createPref('local-value', 100);
    const db = createPref('db-value', 200);

    const resolveFn: ResolveFn = (receivedLocal, receivedDb) => {
      expect(receivedLocal).toBe(local);
      expect(receivedDb).toBe(db);
      return receivedDb;
    };
    const custom = createConflictResolver(resolveFn);

    custom.resolve(local, db);
  });

  it('custom function return value is used', () => {
    const local = createPref('local', 100);
    const db = createPref('db', 200);
    const winner = createPref('custom-winner', 300);

    const custom = createConflictResolver(() => winner);
    expect(custom.resolve(local, db)).toBe(winner);
  });

  it('custom function can return null', () => {
    const local = createPref('local', 100);
    const db = createPref('db', 200);

    const custom = createConflictResolver(() => null);
    expect(custom.resolve(local, db)).toBeNull();
  });

  it('custom function handles null inputs', () => {
    const resolveFn: ResolveFn = (local, db) => {
      if (!local && !db) return null;
      return db ?? local;
    };
    const custom = createConflictResolver(resolveFn);

    expect(custom.resolve(null, null)).toBeNull();

    const db = createPref('db-only', 100);
    expect(custom.resolve(null, db)).toBe(db);

    const local = createPref('local-only', 100);
    expect(custom.resolve(local, null)).toBe(local);
  });

  it('supports always-local strategy', () => {
    const resolveFn: ResolveFn = (local) => local;
    const alwaysLocal = createConflictResolver(resolveFn);
    const local = createPref('local', 100);
    const db = createPref('db', 200);

    expect(alwaysLocal.resolve(local, db)).toBe(local);
    expect(alwaysLocal.resolve(null, db)).toBeNull();
  });

  it('supports always-database strategy', () => {
    const resolveFn: ResolveFn = (_local, db) => db;
    const alwaysDatabase = createConflictResolver(resolveFn);
    const local = createPref('local', 100);
    const db = createPref('db', 200);

    expect(alwaysDatabase.resolve(local, db)).toBe(db);
    expect(alwaysDatabase.resolve(local, null)).toBeNull();
  });

  it('supports merge strategy based on value inspection', () => {
    // Example: prefer non-empty strings
    const resolveFn: ResolveFn = (local, db) => {
      if (!local && !db) return null;
      if (!local) return db;
      if (!db) return local;

      const localVal = JSON.parse(local.value) as unknown;
      const dbVal = JSON.parse(db.value) as unknown;

      // If local is non-empty string and db is empty, prefer local
      if (typeof localVal === 'string' && localVal.length > 0 && typeof dbVal === 'string' && dbVal.length === 0) {
        return local;
      }

      // Otherwise use last-write-wins
      return local.updatedAt > db.updatedAt ? local : db;
    };
    const preferNonEmpty = createConflictResolver(resolveFn);

    const local = createPref('non-empty', 100);
    const db = createPref('', 200);
    expect(preferNonEmpty.resolve(local, db)).toBe(local);

    const local2 = createPref('value1', 100);
    const db2 = createPref('value2', 200);
    expect(preferNonEmpty.resolve(local2, db2)).toBe(db2);
  });
});
