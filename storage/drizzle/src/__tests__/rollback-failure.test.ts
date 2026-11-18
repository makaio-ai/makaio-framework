/**
 * A failing rollback must never replace the error that made the transaction
 * fail: the driver adapters attach the rollback failure to the original error.
 *
 * Neither real driver can be made to fail a rollback on demand, so the adapters
 * are bound to minimal structural drivers at their public seams
 * (`bindLibsqlHandle`, `bindBunSqliteTransactions`) whose rollback fails. The
 * code under test is the adapters' own error handling.
 */
import type { InStatement, ResultSet, Transaction } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { bindBunSqliteTransactions, type BunSqliteTransactionalDatabase } from '../engine/sqlite/bun-transaction';
import { HandleGate } from '../engine/sqlite/handle-gate';
import { bindLibsqlHandle, type LibsqlClientSurface } from '../engine/sqlite/libsql-handle';
import { attachSecondaryFailure, readSecondaryFailures } from '../engine/sqlite/secondary-failure';

/** Transaction context shape of the libsql double: it only needs to open nested ones. */
interface Context {
  transaction<T>(callback: (nested: Context) => Promise<T>): Promise<T>;
}

/**
 * Build a libsql transaction whose rollback fails.
 * @param rollbackFailure - What the rollback rejects with.
 * @returns The transaction the double's client hands out.
 */
function failingRollbackTransaction(rollbackFailure: Error): Transaction {
  const unsupported = async (): Promise<never> => {
    throw new Error('not used by this test');
  };
  return {
    closed: false,
    execute: unsupported,
    batch: unsupported,
    executeMultiple: unsupported,
    commit: unsupported,
    rollback: async () => {
      throw rollbackFailure;
    },
    close: () => undefined,
  };
}

describe('attachSecondaryFailure', () => {
  it('keeps the primary error as is and collects the failures in order', () => {
    const primary = new TypeError('primary');

    expect(attachSecondaryFailure(primary, 'first')).toBe(primary);
    attachSecondaryFailure(primary, 'second');

    expect(readSecondaryFailures(primary)).toEqual(['first', 'second']);
    expect(Object.keys(primary)).toEqual([]);
    expect(primary).toBeInstanceOf(TypeError);
  });

  it('passes on thrown values that cannot carry the attachment', () => {
    const frozen = Object.freeze(new Error('frozen'));

    expect(attachSecondaryFailure('text', 'ignored')).toBe('text');
    expect(attachSecondaryFailure(frozen, 'ignored')).toBe(frozen);
    expect(readSecondaryFailures('text')).toEqual([]);
    expect(readSecondaryFailures(frozen)).toEqual([]);
  });
});

describe('libsql transaction rollback failure', () => {
  it('rejects with the configuration failure and attaches the rollback failure', async () => {
    const configurationFailure = new Error('configuring the new connection failed');
    const rollbackFailure = new Error('rolling back failed');
    const client: LibsqlClientSurface = {
      execute: async (_statement: InStatement): Promise<ResultSet> => {
        throw configurationFailure;
      },
      batch: async () => [],
      migrate: async () => [],
      executeMultiple: async () => undefined,
      transaction: async () => failingRollbackTransaction(rollbackFailure),
    };
    const db = {
      $client: client,
      transaction: async <T>(callback: (tx: Context) => Promise<T>): Promise<T> => callback(createContext()),
    };
    bindLibsqlHandle(db, new HandleGate(), ['PRAGMA foreign_keys = ON']);

    const outcome = await db.$client.transaction().catch((error: unknown) => error);

    expect(outcome).toBe(configurationFailure);
    expect(readSecondaryFailures(outcome)).toEqual([rollbackFailure]);
  });
});

/**
 * Build a transaction context that opens nested contexts of the same shape.
 * @returns A context for the libsql double.
 */
function createContext(): Context {
  return { transaction: async (callback) => callback(createContext()) };
}

describe('bun:sqlite transaction rollback failure', () => {
  it('rejects with the callback error and attaches the rollback failure', async () => {
    const callbackFailure = new Error('callback failed');
    const rollbackFailure = new Error('ROLLBACK failed');
    const statements: string[] = [];
    const statement = { run: () => undefined, all: () => [], get: () => undefined, values: () => [] };
    const connection = {
      inTransaction: true,
      run(text: string): void {
        statements.push(text);
        if (text === 'ROLLBACK') throw rollbackFailure;
      },
      prepare: () => statement,
    };
    const query = { run: () => undefined, all: () => [], get: () => undefined, values: () => [] };
    const db: BunSqliteTransactionalDatabase = {
      session: { prepareQuery: () => query },
      transaction: async (callback) => callback(createContext()),
    };
    bindBunSqliteTransactions(db, connection, new HandleGate());

    const outcome = await db
      .transaction(async () => {
        throw callbackFailure;
      })
      .catch((error: unknown) => error);

    expect(statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
    expect(outcome).toBe(callbackFailure);
    expect(readSecondaryFailures(outcome)).toEqual([rollbackFailure]);
  });
});
