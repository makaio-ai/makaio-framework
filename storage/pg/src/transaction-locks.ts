/**
 * Postgres implementation of stable transaction-key locks.
 * @packageDocumentation
 */
import { sql, type SQL } from 'drizzle-orm';
import type { StorageEngineTransactionLocks, TransactionLock } from '@makaio/storage-drizzle';

const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const UINT_64_MASK = 0xffffffffffffffffn;
const SIGNED_64_BOUNDARY = 0x8000000000000000n;
const UINT_64_RANGE = 0x10000000000000000n;
const encoder = new TextEncoder();

/**
 * Write one UTF-8 string in an unambiguous length-prefixed representation.
 * @param value - String to frame.
 * @returns Big-endian length followed by the UTF-8 bytes.
 */
function frame(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const framed = new Uint8Array(4 + bytes.length);
  new DataView(framed.buffer).setUint32(0, bytes.length, false);
  framed.set(bytes, 4);
  return framed;
}

/**
 * Derive a signed Postgres advisory key from a stable namespace and identity.
 *
 * Both values are UTF-8 length-framed before FNV-1a is applied, so distinct
 * `(namespace, identity)` pairs cannot collide through concatenation ambiguity.
 * @param lock - Stable lock identity supplied by a storage caller.
 * @returns Signed 64-bit key accepted by `pg_advisory_xact_lock`.
 */
export function postgresTransactionLockKey(lock: TransactionLock): bigint {
  let hash = FNV_64_OFFSET_BASIS;
  for (const value of [lock.namespace, lock.identity]) {
    for (const byte of frame(value)) {
      hash ^= BigInt(byte);
      hash = (hash * FNV_64_PRIME) & UINT_64_MASK;
    }
  }
  return hash >= SIGNED_64_BOUNDARY ? hash - UINT_64_RANGE : hash;
}

/**
 * Build ordered advisory-lock expressions for a stable-key set.
 *
 * Postgres advisory locks are keyed by signed 64-bit integers. Deduplicating
 * and sorting those actual integers, rather than their input strings, gives
 * every transaction that needs the same set one database-level lock order.
 * @param locks - Stable keys the transaction will mutate.
 * @returns One transaction-scoped advisory-lock expression per distinct key.
 */
export function postgresTransactionLockExpressions(locks: readonly TransactionLock[]): readonly SQL[] {
  const keys = [...new Set(locks.map(postgresTransactionLockKey))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return keys.map((key) => sql`pg_advisory_xact_lock(CAST(${key.toString()} AS bigint))`);
}

/** Postgres strategy for the generic transaction-lock acquisition seam. */
export const postgresTransactionLocks: StorageEngineTransactionLocks = {
  lockExpressions: postgresTransactionLockExpressions,
};
