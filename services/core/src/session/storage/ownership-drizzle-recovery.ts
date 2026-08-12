/**
 * Atomic recovery guards for the Drizzle ownership claim operation.
 * @packageDocumentation
 */
import { eq } from 'drizzle-orm';
import type { SessionOwnershipClaimRequest, SessionOwnershipClaimResult } from '@makaio/contracts';
import { resolveTakeoverAuthorization, type TakeoverAuthorization } from './ownership-drizzle-acquire.js';
import { readClaimByKey } from './ownership-drizzle-reads.js';
import {
  type AgentRow,
  type ClaimRow,
  type KeyedClaimRequest,
  mapClaim,
  mapCurrency,
  type OwnershipTables,
  type OwnershipTransaction,
} from './ownership-drizzle-rows.js';
import {
  classifyRecoveryGuard,
  recoveryOwnerGeneration,
  sameRecoveryOwnerGeneration,
} from './ownership-recovery-guard.js';

/** Callback that performs the already-authorized guarded takeover. */
export type GuardedRecoveryTakeover = (
  incumbent: ClaimRow,
  authorization: TakeoverAuthorization,
) => Promise<SessionOwnershipClaimResult | undefined>;

/**
 * Verify a recovery snapshot after taking the claiming agent's allocation lock.
 * @param tx - Open ownership transaction.
 * @param tables - Dialect-resolved ownership tables.
 * @param payload - Claim request carrying the optional recovery guard.
 * @param agent - Agent row locked for the rest of the transaction.
 * @returns Modeled recovery refusal, or `undefined` when the claim may proceed.
 */
export async function evaluateDrizzleRecoveryGuard(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  agent: AgentRow,
): Promise<SessionOwnershipClaimResult | undefined> {
  if (payload.recoveryGuard === undefined) return undefined;
  const holder =
    payload.providerSessionId === null
      ? undefined
      : await readClaimByKey(tx, tables, {
          machineId: payload.machineId,
          adapterId: payload.adapterId,
          providerSessionId: payload.providerSessionId,
        });
  return classifyRecoveryGuard(
    payload,
    {
      status: agent.status,
      adapterId: agent.adapterId,
      runtimeOwner:
        agent.ownerMachineId === null || agent.ownerInstanceId === null
          ? undefined
          : { machineId: agent.ownerMachineId, instanceId: agent.ownerInstanceId },
      recoveryAttemptId: agent.recoveryAttemptId ?? undefined,
      revision: agent.revision,
      currencyFence: agent.currencyFence,
      currency: mapCurrency(agent),
    },
    holder === undefined ? null : mapClaim(holder),
  );
}

/**
 * Commit the lifecycle half of a successful guarded reservation.
 * @param tx - Open ownership transaction.
 * @param tables - Dialect-resolved ownership tables.
 * @param payload - Claim request carrying the optional recovery guard.
 * @param result - Claim decision whose success gates the status transition.
 * @returns The unchanged claim result.
 */
export async function finishDrizzleRecoveryClaim(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  result: SessionOwnershipClaimResult,
): Promise<SessionOwnershipClaimResult> {
  if (payload.recoveryGuard !== undefined && (result.outcome === 'claimed' || result.outcome === 'idempotent')) {
    if (payload.recoveryAttemptId === undefined || payload.ownerInstance === undefined) {
      throw new Error('guarded recovery claim requires recoveryAttemptId and ownerInstance');
    }
    const [agent] = await tx.select().from(tables.agents).where(eq(tables.agents.agentId, payload.agentId));
    if (agent === undefined) return { outcome: 'not-found', missing: 'agent' };
    const preimage = {
      status: agent.status,
      adapterId: agent.adapterId,
      ...(agent.ownerMachineId === null || agent.ownerInstanceId === null
        ? {}
        : {
            binding: {
              adapterId: agent.adapterId,
              ownerMachineId: agent.ownerMachineId,
              ownerInstanceId: agent.ownerInstanceId,
            },
          }),
      ...(agent.recoveryAttemptId === null ? {} : { recoveryAttemptId: agent.recoveryAttemptId }),
    };
    await tx
      .update(tables.agents)
      .set({
        status: 'starting',
        adapterId: payload.adapterId,
        ownerMachineId: payload.machineId,
        ownerInstanceId: payload.ownerInstance.instanceId,
        recoveryAttemptId: payload.recoveryAttemptId,
        lastActivityAt: Date.now(),
      })
      .where(eq(tables.agents.agentId, payload.agentId));
    return { ...result, recovery: { attemptId: payload.recoveryAttemptId, preimage } };
  }
  return result;
}

/**
 * Report that the ownership generation changed after a recovery was planned.
 * @param payload - Guarded recovery claim.
 * @param holder - Generation currently holding the key, or no holder.
 * @returns Modeled recovery conflict.
 */
export function drizzleRecoveryConflict(
  payload: SessionOwnershipClaimRequest,
  holder: ClaimRow | undefined,
): SessionOwnershipClaimResult {
  const guard = payload.recoveryGuard;
  if (guard === undefined) throw new Error('recovery conflict requires a recovery guard');
  return {
    outcome: 'recovery-conflict',
    status: guard.expectedStatus,
    ownerGeneration: holder === undefined ? null : recoveryOwnerGeneration(mapClaim(holder)),
  };
}

/**
 * Replace the exact owner generation a recovery observed.
 *
 * This path never falls back to a free acquisition: disappearance of the
 * observed generation is itself a conflict, even when the key is free by the
 * time it is classified.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved ownership tables.
 * @param payload - Guarded claim request.
 * @param takeOver - Callback performing the guarded claim-row update.
 * @returns Guarded takeover result.
 */
export async function attemptGuardedRecoveryTakeover(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: KeyedClaimRequest,
  takeOver: GuardedRecoveryTakeover,
): Promise<SessionOwnershipClaimResult> {
  const expectedOwner = payload.recoveryGuard?.ownerGeneration;
  if (expectedOwner === undefined || expectedOwner === null) {
    throw new Error('guarded recovery takeover requires an observed owner generation');
  }
  const existing = await readClaimByKey(tx, tables, payload);
  const currentOwner = existing === undefined ? null : recoveryOwnerGeneration(mapClaim(existing));
  if (existing === undefined || !sameRecoveryOwnerGeneration(currentOwner, expectedOwner)) {
    return drizzleRecoveryConflict(payload, existing);
  }
  const authorization = await resolveTakeoverAuthorization(
    tx,
    tables,
    payload,
    existing,
    payload.supersedes?.claimToken === existing.claimToken,
  );
  if (authorization === undefined) return drizzleRecoveryConflict(payload, existing);

  const result = await takeOver(existing, authorization);
  if (result === undefined || result.outcome === 'already-claimed') {
    return drizzleRecoveryConflict(
      payload,
      result === undefined ? undefined : await readClaimByKey(tx, tables, payload),
    );
  }
  return result;
}
