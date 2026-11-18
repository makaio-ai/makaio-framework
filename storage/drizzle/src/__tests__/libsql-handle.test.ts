/**
 * Contract of the libsql handle bindings that a real libsql handle cannot show.
 *
 * Drizzle's libsql session currently ignores the transaction configuration it
 * is given, so a real handle behaves the same with or without it. The binding
 * must still hand it through untouched: dropping it would silently turn a
 * future drizzle release that honors it into a no-op.
 */
import { describe, expect, it } from 'vitest';
import { HandleGate } from '../engine/sqlite/handle-gate';
import {
  bindLibsqlHandle,
  serializeLibsqlNestedTransactions,
  type LibsqlClientSurface,
  type LibsqlTransactionConfig,
} from '../engine/sqlite/libsql-handle';

/** Transaction context shape of the double: it only needs to open nested ones. */
interface Context {
  transaction<T>(callback: (nested: Context) => Promise<T>): Promise<T>;
}

/**
 * Build a transaction context that opens nested contexts of the same shape.
 * @returns A context for the double.
 */
function createContext(): Context {
  return { transaction: async (callback) => callback(createContext()) };
}

describe('bindLibsqlHandle', () => {
  it('hands the transaction configuration of db.transaction() through to drizzle', async () => {
    const received: Array<LibsqlTransactionConfig | undefined> = [];
    const unsupported = async (): Promise<never> => {
      throw new Error('not used by this test');
    };
    const client: LibsqlClientSurface = {
      execute: unsupported,
      batch: unsupported,
      migrate: unsupported,
      executeMultiple: unsupported,
      transaction: unsupported,
    };
    const db = {
      $client: client,
      transaction: async <T>(callback: (tx: Context) => Promise<T>, config?: LibsqlTransactionConfig): Promise<T> => {
        received.push(config);
        return callback(createContext());
      },
    };
    bindLibsqlHandle(db, new HandleGate(), []);

    await db.transaction(async () => 'with config', { behavior: 'exclusive' });
    await db.transaction(async () => 'without config');

    expect(received).toEqual([{ behavior: 'exclusive' }, undefined]);
  });
});

describe('serializeLibsqlNestedTransactions', () => {
  it('runs the nested transactions of a handle without a gate one at a time', async () => {
    // Remote libsql handles get no gate (the server isolates them) but their
    // savepoints stack exactly like local ones.
    const events: string[] = [];
    const db = {
      transaction: async <T>(callback: (tx: Context) => Promise<T>): Promise<T> => callback(createContext()),
    };
    serializeLibsqlNestedTransactions(db);

    await db.transaction(async (tx) => {
      const first = tx.transaction(async () => {
        events.push('first:start');
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        events.push('first:end');
      });
      const second = tx.transaction(async () => {
        events.push('second:start');
      });
      await Promise.all([first, second]);
    });

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});
