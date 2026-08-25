import type { IMakaioBus } from '@makaio/bus-core';
import {
  resolveResumableAdapterSessionId,
  SessionOwnershipStorageSubjects,
  type MakaioSessionAgent,
  type SessionOwnershipRecoveryGuard,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { recoveryOwnerGeneration } from '../storage/ownership-recovery-guard.js';
import type { OwnedAdapterInstance } from '../utils/resolution.js';

/** One retry after storage proves that a keyed recovery plan is stale. */
export const MAX_RECOVERY_REPLANS = 1;

/**
 * Resolve the provider key carried by one canonical recovery snapshot.
 * @param snapshot - Snapshot whose currency was read from ownership storage.
 * @returns Resumable provider key, or `null` when the currency is not resumable.
 */
export function recoveryProviderSessionId(snapshot: RecoveryPlanningSnapshot): string | null {
  return resolveResumableAdapterSessionId(snapshot.guard.expectedCurrency);
}

/**
 * Whether a snapshot names a lifecycle state a recovery may atomically claim.
 * @param snapshot - Canonical recovery input.
 * @returns `true` only for states from which recovery may transition to `starting`.
 */
export function recoverySnapshotIsClaimable(snapshot: RecoveryPlanningSnapshot): boolean {
  return snapshot.agent.status === 'idle' || snapshot.agent.status === 'active' || snapshot.agent.status === 'dead';
}

/** Canonical row and currency snapshot from which one recovery is planned. */
export interface RecoveryPlanningSnapshot {
  /** Agent row with its currency replaced by the ownership aggregate's projection. */
  readonly agent: MakaioSessionAgent;
  /** Guard fields that must describe that exact planning input. */
  readonly guard: Omit<SessionOwnershipRecoveryGuard, 'ownerGeneration'>;
}

/**
 * Read one canonical recovery-planning snapshot.
 *
 * Agent storage supplies lifecycle and structural fields; ownership storage is
 * the authoritative currency projection. The returned agent is rebuilt from
 * both so a plan and its guard cannot accidentally describe different currency
 * snapshots. A torn pair is allowed: the later atomic guard detects it.
 * @param bus - Bus carrying agent and ownership reads.
 * @param agentId - Agent being planned.
 * @returns Canonical planning input, or `null` when either durable row is absent.
 */
export async function readRecoveryPlanningSnapshot(
  bus: IMakaioBus,
  agentId: string,
): Promise<RecoveryPlanningSnapshot | null> {
  const rowResult = await bus.requestOptional(AgentStorageSubjects.get, { agentId });
  const row = rowResult.handled ? rowResult.data.agent : null;
  if (row === null) return null;

  const ownershipResult = await bus.requestOptional(SessionOwnershipStorageSubjects.read, { agentId });
  const ownership = ownershipResult.handled ? ownershipResult.data.ownership : null;
  if (ownership === null) return null;

  const { currency } = ownership;
  const agent: MakaioSessionAgent = {
    ...row,
    adapterSessionId: currency.adapterSessionId ?? undefined,
    currentAdapterSessionId: currency.currentAdapterSessionId ?? undefined,
    currentAdapterSessionIdState: currency.currentAdapterSessionIdState,
    revision: ownership.revision,
    currencyFence: ownership.currencyFence,
  };
  return {
    agent,
    guard: {
      expectedStatus: agent.status,
      expectedPreimage: {
        status: agent.status,
        adapterId: agent.adapterId,
        ...(agent.runtimeOwner === undefined
          ? {}
          : {
              binding: {
                adapterId: agent.adapterId,
                ownerMachineId: agent.runtimeOwner.machineId,
                ownerInstanceId: agent.runtimeOwner.instanceId,
              },
            }),
        ...(agent.recoveryAttemptId === undefined ? {} : { recoveryAttemptId: agent.recoveryAttemptId }),
      },
      expectedRevision: ownership.revision,
      expectedCurrencyFence: ownership.currencyFence,
      expectedCurrency: currency,
    },
  };
}

/**
 * Bind a planning snapshot to the exact generation currently holding its key.
 *
 * The holder lookup is intentionally a separate read. Storage compares it
 * again while locked, so a change between this read and the claim is a modeled
 * recovery conflict rather than authority for a stale dispatch.
 * @param bus - Bus carrying ownership diagnostics.
 * @param snapshot - Canonical plan input.
 * @param instance - Adapter/machine pair the recovery will dispatch to.
 * @param providerSessionId - Exact provider key the plan resumes.
 * @returns Atomic storage guard for that plan and key.
 */
export async function buildRecoveryReservationGuard(
  bus: IMakaioBus,
  snapshot: RecoveryPlanningSnapshot,
  instance: OwnedAdapterInstance,
  providerSessionId: string | null,
): Promise<SessionOwnershipRecoveryGuard> {
  if (instance.machineId === undefined || providerSessionId === null) {
    return { ...snapshot.guard, ownerGeneration: null };
  }
  const listed = await bus.request(SessionOwnershipStorageSubjects.listClaims, {
    machineId: instance.machineId,
    adapterId: instance.adapterId,
    providerSessionId,
  });
  return {
    ...snapshot.guard,
    ownerGeneration: recoveryOwnerGeneration(listed.claims[0] ?? null),
  };
}
