/**
 * Tests for the Postgres storage engine definition.
 *
 * The migration statement texts, ledger names, and the advisory-lock key
 * derivation are cross-version contracts: the byte pins here mirror the
 * historical values from the migration runner so the engine seam can never
 * drift from what provisioned databases already contain.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  registerStorageEngine,
  STORAGE_ENGINE_URL_HINTS,
  type StorageDialect,
  type StorageEngine,
} from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { postgresStorageEngine } from '../engine.js';
import { isPostgresDuplicateObjectError, isPostgresUniqueViolationError } from '../errors.js';
import { buildPostgresLedgerDdl, migrationAdvisoryLockKey, POSTGRES_MIGRATION_BEGIN } from '../migrations.js';
import {
  postgresTransactionLockExpressions,
  postgresTransactionLockKey,
  postgresTransactionLocks,
} from '../transaction-locks.js';
import { storageEngine } from '../index.js';

/** The registry's documented `globalThis` storage key (used for test cleanup). */
const ENGINE_REGISTRY: unique symbol = Symbol.for('makaio.storage.engineRegistry');

/** View of `globalThis` exposing the registry map for test cleanup. */
interface EngineRegistryCarrier {
  [ENGINE_REGISTRY]?: Map<StorageDialect, StorageEngine>;
}

afterEach(() => {
  // Remove the postgres entry a test registered; the seeded sqlite default
  // engine stays (re-seeded set-if-absent on next access anyway).
  (globalThis as EngineRegistryCarrier)[ENGINE_REGISTRY]?.delete('postgres');
});

describe('engine identity', () => {
  it('serves the postgres dialect', () => {
    expect(postgresStorageEngine.dialect).toBe('postgres');
  });

  it('exposes the same object under the well-known auto-resolve export name', () => {
    expect(storageEngine).toBe(postgresStorageEngine);
  });
});

describe('matchesUrl', () => {
  it('agrees with the core URL hint table on every URL shape', () => {
    // The engine's URL claim mirrors the hint table in @makaio/storage-drizzle
    // by contract — a disagreement would route the same URL differently
    // depending on whether the engine is registered.
    for (const url of ['postgres://x', 'postgresql://x', 'POSTGRES://x', 'file:x', ':memory:', 'libsql://x']) {
      const hinted = STORAGE_ENGINE_URL_HINTS.some((hint) => hint.dialect === 'postgres' && hint.matchesUrl(url));
      expect(postgresStorageEngine.matchesUrl?.(url), url).toBe(hinted);
    }
  });
});

describe('createClient', () => {
  it('requires an explicit URL — the engine never applies a default', async () => {
    await expect(postgresStorageEngine.createClient({})).rejects.toThrow(/connection URL is required/);
  });

  it('creates a postgres-branded client through registry dispatch without connecting', async () => {
    // Pool construction is lazy, so registry-dispatched client creation is
    // exercised for real without a running server.
    registerStorageEngine(postgresStorageEngine);

    const client = await createDatabaseClient({ url: 'postgres://user:pw@localhost:5432/makaio' });
    try {
      expect(client.dialect).toBe('postgres');
    } finally {
      await client.close();
    }
  });
});

describe('capabilities', () => {
  it('declares bytea binary columns and the MAX-counter race', () => {
    expect(postgresStorageEngine.capabilities.binaryColumnType).toBe('bytea');
    expect(postgresStorageEngine.capabilities.maxCounterAssignmentRaces).toBe(true);
  });
});

describe('transaction lock strategy', () => {
  it('pins length-framed FNV-1a keys as signed 64-bit values', () => {
    expect(
      postgresTransactionLockKey({
        namespace: 'makaio:session-ownership:claim:v1',
        identity: '["machine","adapter","provider"]',
      }),
    ).toBe(4708309522623643060n);
    // Length framing makes these otherwise ambiguous concatenations distinct.
    expect(postgresTransactionLockKey({ namespace: 'a', identity: 'bc' })).toBe(-5503210646444362960n);
    expect(postgresTransactionLockKey({ namespace: 'ab', identity: 'c' })).toBe(5952912767215893880n);
  });

  it('deduplicates and orders the actual advisory bigint keys', () => {
    const first = { namespace: 'first', identity: 'one' };
    const second = { namespace: 'second', identity: 'two' };
    const expected = [postgresTransactionLockKey(first), postgresTransactionLockKey(second)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    const expressions = postgresTransactionLockExpressions([second, first, second]);
    expect(expressions).toHaveLength(2);
    expect(postgresTransactionLocks.lockExpressions).toBe(postgresTransactionLockExpressions);
    expect(postgresStorageEngine.transactionLocks).toBe(postgresTransactionLocks);
    for (const [index, key] of expected.entries()) {
      expect(expressions[index]?.queryChunks.map(String).join('')).toContain(key.toString());
    }
  });
});

describe('migration behavior byte pins (cross-version contracts)', () => {
  it('pins the default ledger table name', () => {
    expect(postgresStorageEngine.migrations.defaultLedgerTable).toBe('__makaio_migrations');
  });

  it('pins the journal dialect to drizzle-kit vocabulary', () => {
    expect(postgresStorageEngine.migrations.journalDialect).toBe('postgresql');
  });

  it('pins the chain directory name — and keeps it distinct from the default chain dir', () => {
    expect(postgresStorageEngine.migrations.chainDirName).toBe('drizzle-postgres');
    // Embedded-host chain discovery embeds directories literally named
    // 'drizzle'; the Postgres chain must never satisfy that match.
    expect(postgresStorageEngine.migrations.chainDirName).not.toBe('drizzle');
  });

  it('resolves the committed chain shipped with this package', () => {
    const chainDir = postgresStorageEngine.migrations.resolveSourceChainDir?.();

    expect(chainDir).toBeDefined();
    expect(path.isAbsolute(chainDir!)).toBe(true);
    expect(chainDir!.endsWith(`${path.sep}drizzle-postgres`)).toBe(true);
    // The resolved directory must be a valid drizzle chain in this package.
    expect(existsSync(path.join(chainDir!, 'meta', '_journal.json'))).toBe(true);
  });

  it('pins the ledger DDL: identity primary key and UNIQUE hash', () => {
    expect(buildPostgresLedgerDdl('__makaio_migrations')).toBe(
      'CREATE TABLE IF NOT EXISTS "__makaio_migrations" (\n' +
        '      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n' +
        '      hash text NOT NULL UNIQUE,\n' +
        '      created_at numeric\n' +
        '    )',
    );
    expect(postgresStorageEngine.migrations.buildLedgerDdl).toBe(buildPostgresLedgerDdl);
  });

  it('quotes ledger table identifiers by doubling embedded quotes', () => {
    expect(buildPostgresLedgerDdl('weird"name')).toContain('"weird""name"');
  });

  it('pins the BEGIN statement: READ COMMITTED for the in-lock recheck', () => {
    expect(POSTGRES_MIGRATION_BEGIN).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(postgresStorageEngine.migrations.beginTransactionStatement).toBe(POSTGRES_MIGRATION_BEGIN);
  });

  it('pins the advisory lock key derivation as a cross-version contract', () => {
    // First 8 bytes (big-endian, signed) of SHA-256("makaio:migrations:<table>").
    expect(migrationAdvisoryLockKey('__makaio_migrations')).toBe(-9176243337112485871n);
    expect(migrationAdvisoryLockKey('__drizzle_migrations')).toBe(-8697586541560377660n);
  });

  it('declares the cross-process advisory lock protocol', () => {
    expect(postgresStorageEngine.migrations.acquireTransactionLock).toBeDefined();
  });

  it('pins the extension ledger naming scheme', () => {
    expect(postgresStorageEngine.migrations.extensionLedgerName('abc')).toBe('__makaio_migrations_abc');
  });
});

// ---------------------------------------------------------------------------
// isPostgresDuplicateObjectError
// ---------------------------------------------------------------------------

describe('isPostgresDuplicateObjectError', () => {
  it('matches SQLSTATE 42P07 (duplicate_table)', () => {
    const error = Object.assign(new Error('duplicate table'), { code: '42P07' });

    expect(isPostgresDuplicateObjectError(error)).toBe(true);
  });

  it('matches SQLSTATE 42710 (duplicate_object)', () => {
    const error = Object.assign(new Error('duplicate object'), { code: '42710' });

    expect(isPostgresDuplicateObjectError(error)).toBe(true);
  });

  it('matches the code anywhere in the cause chain', () => {
    const inner = Object.assign(new Error('original pg error'), { code: '42P07' });
    const outer = new Error('wrapped', { cause: inner });

    expect(isPostgresDuplicateObjectError(outer)).toBe(true);
  });

  it('returns false for an unrelated Postgres error code', () => {
    const error = Object.assign(new Error('syntax error'), { code: '42601' });

    expect(isPostgresDuplicateObjectError(error)).toBe(false);
  });

  it('returns false when no code property is present', () => {
    const error = new Error('already exists');

    // The classifier checks SQLSTATE codes, not message text.
    expect(isPostgresDuplicateObjectError(error)).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isPostgresDuplicateObjectError('already exists')).toBe(false);
    expect(isPostgresDuplicateObjectError(null)).toBe(false);
    expect(isPostgresDuplicateObjectError(undefined)).toBe(false);
  });

  it('is wired as the engine error classifier', () => {
    expect(postgresStorageEngine.errors.isDuplicateObjectError).toBe(isPostgresDuplicateObjectError);
  });
});

// ---------------------------------------------------------------------------
// isPostgresUniqueViolationError
// ---------------------------------------------------------------------------

describe('isPostgresUniqueViolationError', () => {
  it('matches SQLSTATE 23505 (unique_violation)', () => {
    const error = Object.assign(new Error('duplicate key value'), { code: '23505' });

    expect(isPostgresUniqueViolationError(error)).toBe(true);
  });

  it('matches the code anywhere in the cause chain', () => {
    const inner = Object.assign(new Error('original pg error'), { code: '23505' });
    const outer = new Error('wrapped', { cause: inner });

    expect(isPostgresUniqueViolationError(outer)).toBe(true);
  });

  it('scopes the match to the given constraint name', () => {
    const error = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'turns_session_id_turn_number_unique',
    });

    expect(isPostgresUniqueViolationError(error, 'turns_session_id_turn_number_unique')).toBe(true);
    expect(isPostgresUniqueViolationError(error, 'some_other_constraint')).toBe(false);
  });

  it('returns false for an unrelated Postgres error code', () => {
    const error = Object.assign(new Error('syntax error'), { code: '42601' });

    expect(isPostgresUniqueViolationError(error)).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isPostgresUniqueViolationError(null)).toBe(false);
    expect(isPostgresUniqueViolationError(undefined)).toBe(false);
  });

  it('is wired as the engine error classifier', () => {
    expect(postgresStorageEngine.errors.isUniqueViolationError).toBe(isPostgresUniqueViolationError);
  });
});
