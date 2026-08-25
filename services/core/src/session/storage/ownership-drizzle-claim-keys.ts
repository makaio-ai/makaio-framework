/**
 * Stable transaction keys for mutable session-ownership claim rows.
 * @packageDocumentation
 */
import { and, eq } from 'drizzle-orm';
import type { TransactionLock } from '@makaio/storage-drizzle';
import type { ClaimAcquisition, OwnershipTables, OwnershipTransaction } from './ownership-drizzle-rows.js';

/** Versioned namespace for ownership-key lock identities. */
export const SESSION_OWNERSHIP_CLAIM_LOCK_NAMESPACE = 'makaio:session-ownership:claim:v1';

/** Claim-key fields that identify one provider-session ownership row. */
export interface OwnershipClaimKey {
  /** Runtime machine owning the provider session store. */
  readonly machineId: string;
  /** Adapter runtime owning the provider session. */
  readonly adapterId: string;
  /** Provider-native session identifier. */
  readonly providerSessionId: string;
}

/**
 * Build the stable transaction lock for one ownership key.
 *
 * JSON arrays preserve field boundaries while keeping the identity independent
 * of the storage row that currently represents this key.
 * @param key - Provider-session ownership key.
 * @returns Stable transaction lock used before claim-row mutation.
 */
export function ownershipClaimTransactionLock(key: OwnershipClaimKey): TransactionLock {
  return {
    namespace: SESSION_OWNERSHIP_CLAIM_LOCK_NAMESPACE,
    identity: JSON.stringify([key.machineId, key.adapterId, key.providerSessionId]),
  };
}

/**
 * Read the stable keys for every held predecessor of an acting agent.
 *
 * The acting agent row is already locked when this runs, so no ownership
 * operation can add or remove one of its held predecessors before the caller
 * acquires the resulting stable-key set.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Acting agent whose held predecessors may be retired.
 * @returns Stable keys for the agent's current held predecessors.
 */
export async function readHeldOwnershipClaimTransactionLocks(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  agentId: string,
): Promise<TransactionLock[]> {
  const { adapterSessionClaims } = tables;
  const claims = await tx
    .select({
      machineId: adapterSessionClaims.machineId,
      adapterId: adapterSessionClaims.adapterId,
      providerSessionId: adapterSessionClaims.providerSessionId,
    })
    .from(adapterSessionClaims)
    .where(and(eq(adapterSessionClaims.agentId, agentId), eq(adapterSessionClaims.status, 'held')));
  return claims.map(ownershipClaimTransactionLock);
}

/**
 * Build the target key for an acquisition or takeover.
 * @param acquisition - Claim acquisition carrying the target provider key.
 * @returns Stable transaction lock for that target key.
 */
export function acquisitionOwnershipClaimTransactionLock(acquisition: ClaimAcquisition): TransactionLock {
  return ownershipClaimTransactionLock(acquisition);
}
