/**
 * Pure recovery-guard classification shared by both ownership backends.
 * @packageDocumentation
 */
import type {
  AdapterSessionClaimRecord,
  AdapterSessionCurrencySnapshot,
  AgentStatus,
  SessionOwnershipClaimRequest,
  SessionOwnershipClaimResult,
  SessionOwnershipRecoveryOwnerGeneration,
} from '@makaio/contracts';

/** Agent columns the recovery guard compares under the ownership lock. */
export interface RecoveryGuardAgentSnapshot {
  /** Current lifecycle status. */
  readonly status: AgentStatus;
  readonly adapterId: string;
  readonly runtimeOwner: { readonly machineId: string; readonly instanceId: string } | undefined;
  readonly recoveryAttemptId: string | undefined;
  /** Current currency revision. */
  readonly revision: number;
  /** Current currency fence. */
  readonly currencyFence: number;
  /** Current provider-session currency. */
  readonly currency: AdapterSessionCurrencySnapshot;
}

/** A refusal produced exclusively by the recovery guard. */
export type RecoveryGuardRefusal = Extract<
  SessionOwnershipClaimResult,
  { outcome: 'currency-changed' | 'recovery-conflict' }
>;

/**
 * Project a claim record onto the exact generation identity carried by a guard.
 * @param claim - Current claim row, or no holder.
 * @returns Exact owner generation, or `null` when the key is free.
 */
export function recoveryOwnerGeneration(
  claim: AdapterSessionClaimRecord | null,
): SessionOwnershipRecoveryOwnerGeneration | null {
  if (claim === null) return null;
  return {
    claimId: claim.claimId,
    claimToken: claim.claimToken,
    fence: claim.fence,
    ownerInstanceId: claim.ownerInstanceId,
    status: claim.status,
  };
}

/**
 * Compare two exact owner-generation snapshots.
 * @param current - Generation currently stored.
 * @param expected - Generation observed by the recovery planner.
 * @returns Whether both snapshots name the same generation and lifecycle state.
 */
export function sameRecoveryOwnerGeneration(
  current: SessionOwnershipRecoveryOwnerGeneration | null,
  expected: SessionOwnershipRecoveryOwnerGeneration | null,
): boolean {
  return (
    current?.claimId === expected?.claimId &&
    current?.claimToken === expected?.claimToken &&
    current?.fence === expected?.fence &&
    current?.ownerInstanceId === expected?.ownerInstanceId &&
    current?.status === expected?.status
  );
}

/**
 * Compare a planned recovery with the rows locked by its claim transaction.
 *
 * Currency is classified first because it invalidates the recovery plan itself;
 * status and owner-generation mismatches instead mean another recovery or
 * teardown won the lifecycle arbitration.
 * @param payload - Claim request carrying an optional recovery guard.
 * @param agent - Current locked agent snapshot.
 * @param holder - Generation currently holding the requested key, or `null`.
 * @returns Modeled refusal, or `undefined` when the guarded claim may proceed.
 */
export function classifyRecoveryGuard(
  payload: SessionOwnershipClaimRequest,
  agent: RecoveryGuardAgentSnapshot,
  holder: AdapterSessionClaimRecord | null,
): RecoveryGuardRefusal | undefined {
  const guard = payload.recoveryGuard;
  if (guard === undefined) return undefined;

  if (
    agent.revision !== guard.expectedRevision ||
    agent.currencyFence !== guard.expectedCurrencyFence ||
    agent.currency.adapterSessionId !== guard.expectedCurrency.adapterSessionId ||
    agent.currency.currentAdapterSessionId !== guard.expectedCurrency.currentAdapterSessionId ||
    agent.currency.currentAdapterSessionIdState !== guard.expectedCurrency.currentAdapterSessionIdState
  ) {
    return {
      outcome: 'currency-changed',
      revision: agent.revision,
      currencyFence: agent.currencyFence,
      currency: agent.currency,
    };
  }
  const expected = guard.expectedPreimage;
  if (
    agent.status !== expected.status ||
    agent.adapterId !== expected.adapterId ||
    agent.runtimeOwner?.machineId !== expected.binding?.ownerMachineId ||
    agent.runtimeOwner?.instanceId !== expected.binding?.ownerInstanceId ||
    agent.recoveryAttemptId !== expected.recoveryAttemptId
  )
    return { outcome: 'recovery-conflict', status: agent.status, ownerGeneration: recoveryOwnerGeneration(holder) };

  const currentOwner = recoveryOwnerGeneration(holder);
  const expectedOwner = guard.ownerGeneration;
  if (agent.status !== guard.expectedStatus || !sameRecoveryOwnerGeneration(currentOwner, expectedOwner)) {
    return { outcome: 'recovery-conflict', status: agent.status, ownerGeneration: currentOwner };
  }
  return undefined;
}
