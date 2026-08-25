/**
 * Row shapes and row-level helpers for the in-memory ownership handlers.
 *
 * The mechanical halves of the volatile backend — how a stored record reads as a
 * contract record, and how a fence is allocated — kept apart from the operations
 * for the same reason `ownership-drizzle-rows.ts` is: the decisions that carry
 * the ownership invariant belong with the operations, and nothing here decides
 * anything.
 * @packageDocumentation
 */
import type {
  AdapterSessionClaimRecord,
  AdapterSessionCurrencySnapshot,
  AdapterSessionCurrencyState,
  MakaioSessionAgent,
  OwnershipTopology,
  RuntimeInstanceRecord,
} from '@makaio/contracts';
import type { SessionStorageMemoryState } from './memory-store.js';

/**
 * Find the claim row whose ownership key matches `(machineId, adapterId, providerSessionId)`.
 * @param claims - In-memory claims store
 * @param machineId - Machine component of the ownership key
 * @param adapterId - Adapter component of the ownership key
 * @param providerSessionId - Provider session component of the ownership key
 * @returns The matching claim, or `undefined` when the key is unowned
 */
export function findClaimByKey(
  claims: Map<string, AdapterSessionClaimRecord>,
  machineId: string,
  adapterId: string,
  providerSessionId: string,
): AdapterSessionClaimRecord | undefined {
  for (const claim of claims.values()) {
    if (
      claim.machineId === machineId &&
      claim.adapterId === adapterId &&
      claim.providerSessionId === providerSessionId
    ) {
      return claim;
    }
  }
  return undefined;
}

/**
 * Find the claim row that carries the given `claimToken`.
 * @param claims - In-memory claims store
 * @param claimToken - Opaque generation identifier to search for
 * @returns The matching claim, or `undefined` when no claim carries the token
 */
export function findClaimByToken(
  claims: Map<string, AdapterSessionClaimRecord>,
  claimToken: string,
): AdapterSessionClaimRecord | undefined {
  for (const claim of claims.values()) {
    if (claim.claimToken === claimToken) return claim;
  }
  return undefined;
}

/**
 * The highest fence any claim the agent currently holds carries, or `0`.
 * @param claims - In-memory claims store
 * @param agentId - Agent whose live claims are inspected
 * @returns Highest live claim fence, or `0` when the agent holds none
 */
export function maxLiveClaimFence(claims: Map<string, AdapterSessionClaimRecord>, agentId: string): number {
  let highest = 0;
  for (const claim of claims.values()) {
    if (claim.agentId === agentId && claim.fence > highest) highest = claim.fence;
  }
  return highest;
}

/**
 * Allocate a fence strictly above everything the claiming agent already carries.
 *
 * A fence is totally ordered **per agent**, not per ownership key: the floor is
 * the agent's own currency fence and every claim it still holds — so a second key
 * taken mid-movement can never share a fence with the first — plus, on a
 * takeover, the superseded row's fence.
 *
 * The SQL twin is `fenceAllocation` in `ownership-drizzle-rows.ts`, which has to
 * spell that floor as scalar subqueries so its write stays the transaction's
 * first statement. Here the whole claim path is synchronous, so nothing can move
 * the floor between reading it and storing the row.
 * @param state - Shared in-memory state
 * @param agentId - Agent the claim is being allocated for
 * @param floor - The part of the floor known outside the agent's own state: the
 *   superseded row's fence on a takeover, `0` on a fresh acquisition
 * @returns The fence to store on the claim row
 */
export function allocateFence(state: SessionStorageMemoryState, agentId: string, floor: number): number {
  const currencyFence = state.agents.get(agentId)?.currencyFence ?? 0;
  return 1 + Math.max(floor, currencyFence, maxLiveClaimFence(state.claims, agentId));
}

/**
 * Produce the collision-free key for one process acting for one machine.
 * @param instanceId - Runtime process identity.
 * @param machineId - Machine the process acted for.
 * @returns Composite map key.
 */
export function runtimeInstanceKey(instanceId: string, machineId: string): string {
  return `${instanceId.length}:${instanceId}${machineId}`;
}

/**
 * Lazily allocate the durable identity of a runtime acting for a machine.
 *
 * The in-memory handler is synchronous, so two allocations cannot observe the
 * same maximum. It nevertheless performs the same storage-owned max-plus-one
 * allocation as the SQL backend and never revives a retired row.
 * @param state - Shared in-memory state.
 * @param instanceId - Runtime process identity.
 * @param machineId - Machine the process acts for.
 * @param now - First-use timestamp for a newly allocated row.
 * @returns The existing or newly allocated runtime instance.
 */
export function ensureMemoryRuntimeInstance(
  state: SessionStorageMemoryState,
  instanceId: string,
  machineId: string,
  now: number,
): RuntimeInstanceRecord {
  const key = runtimeInstanceKey(instanceId, machineId);
  const existing = state.runtimeInstances.get(key);
  if (existing !== undefined) return existing;

  let incarnation = 1;
  for (const candidate of state.runtimeInstances.values()) {
    if (candidate.machineId === machineId && candidate.incarnation >= incarnation) {
      incarnation = candidate.incarnation + 1;
    }
  }
  const allocated: RuntimeInstanceRecord = {
    instanceId,
    machineId,
    incarnation,
    startedAt: now,
    retiredAt: null,
  };
  state.runtimeInstances.set(key, structuredClone(allocated));
  return allocated;
}

/** Inputs common to both in-memory generation allocators. */
export interface MemoryTakeoverRequest {
  /** Machine component of the ownership key. */
  readonly machineId: string;
  /** Agent taking the generation. */
  readonly agentId: string;
  /** Runtime process taking the generation. */
  readonly ownerInstanceId: string;
  /** Topology under which supersession may be inferred. */
  readonly topology: OwnershipTopology;
  /** Explicitly superseded token, when the caller supplied one. */
  readonly supersededClaimToken?: string;
}

/**
 * Decide whether a durable fact permits replacing an incumbent generation.
 *
 * Shared by `claim` and `settleMovement`, so T1/T3/T4 cannot drift between the
 * two allocation doors. Legacy rows deliberately satisfy none of the owner
 * predicates; movement handles its same-agent legacy adoption before asking to
 * allocate a replacement.
 * @param state - Shared in-memory state.
 * @param request - Runtime identity and topology of the requester.
 * @param incumbent - Generation currently holding the key.
 * @returns Whether explicit supersession, T1, T3, or T4 authorizes takeover.
 */
export function memoryMayTakeOver(
  state: SessionStorageMemoryState,
  request: MemoryTakeoverRequest,
  incumbent: AdapterSessionClaimRecord,
): boolean {
  if (incumbent.ownerInstanceId === null) return false;
  if (request.supersededClaimToken === incumbent.claimToken) return true;
  if (
    incumbent.status === 'held' &&
    incumbent.agentId === request.agentId &&
    incumbent.ownerInstanceId === request.ownerInstanceId
  ) {
    return true;
  }
  const incumbentOwner = state.runtimeInstances.get(runtimeInstanceKey(incumbent.ownerInstanceId, incumbent.machineId));
  if (incumbentOwner?.retiredAt !== null && incumbentOwner?.retiredAt !== undefined) return true;
  if (request.topology === 'machine-exclusive') {
    const requester = state.runtimeInstances.get(runtimeInstanceKey(request.ownerInstanceId, request.machineId));
    if (requester !== undefined && incumbentOwner !== undefined && requester.incarnation > incumbentOwner.incarnation) {
      return true;
    }
  }
  return false;
}

/** The currency pair a promoted lead publishes onto its session row. */
export interface LeadCurrencyMirror {
  /** Resume target to store, or `undefined` when the state names none. */
  readonly currentAdapterSessionId: string | undefined;
  /** Currency state to store, expressed in the session row's own terms. */
  readonly currentAdapterSessionIdState: AdapterSessionCurrencyState;
}

/**
 * Resolve the currency pair a session's lead publishes onto its session row.
 *
 * Both writers of that snapshot go through here — the claim that promotes a new
 * lead, and the settle that moves the standing lead's currency on — because both
 * can otherwise leave the session advertising a resume target no agent holds.
 *
 * The pair is *resolved*, not copied: `inherited` does not name a provider
 * session, it points at the row's own `adapterSessionId`, and the two rows have
 * different origins — the session keeps the one it was imported from, while a
 * lead that joined it carries its own. Copying `inherited` across would leave
 * the session resolving to its *own* origin while the lead resolves elsewhere.
 *
 * Only the pair's meaning is translated, never invented: the result is exactly
 * what `resolveResumableAdapterSessionId` yields for the lead, re-expressed in
 * the only terms the session row has for it — `inherited` when that is the
 * session's own origin, `confirmed` when it is some other provider session, and
 * `moved` when the lead has nothing resumable at all. `confirmed` and `moved`
 * already name their target independently of the row's origin and are mirrored
 * unchanged.
 * @param agent - Lead agent whose currency the session snapshot mirrors
 * @param sessionOrigin - The session row's own immutable origin identity
 * @returns The currency pair to store on the session row
 */
export function resolveLeadCurrencyMirror(agent: MakaioSessionAgent, sessionOrigin: string | null): LeadCurrencyMirror {
  const state = agent.currentAdapterSessionIdState ?? 'inherited';
  if (state !== 'inherited') {
    return { currentAdapterSessionId: agent.currentAdapterSessionId, currentAdapterSessionIdState: state };
  }
  const leadOrigin = agent.adapterSessionId ?? null;
  if (leadOrigin === sessionOrigin) {
    return { currentAdapterSessionId: undefined, currentAdapterSessionIdState: 'inherited' };
  }
  if (leadOrigin === null) {
    return { currentAdapterSessionId: undefined, currentAdapterSessionIdState: 'moved' };
  }
  return { currentAdapterSessionId: leadOrigin, currentAdapterSessionIdState: 'confirmed' };
}

/**
 * Assert that a currency pair satisfies the `confirmed ↔ id !== null` invariant.
 *
 * The request schema already enforces this before the handler sees the payload,
 * but the in-memory backend must also refuse to store a violating pair,
 * mirroring the SQL backends' CHECK constraints.
 * @param id - Candidate `currentAdapterSessionId`
 * @param currState - Candidate `currentAdapterSessionIdState`
 */
export function assertCurrencyPairing(id: string | null, currState: string): void {
  if ((currState === 'confirmed') !== (id !== null)) {
    throw new Error(
      `Currency pairing invariant violated: confirmed ↔ id !== null (state="${currState}", id=${id === null ? 'null' : 'present'})`,
    );
  }
}

/**
 * Build the currency snapshot for an agent row, mapping absent fields to `null`.
 *
 * The contract models "never known" as `null`, so an absent field must not stay
 * `undefined` — that would make an unwritten currency indistinguishable from a
 * missing property.
 * @param agent - Agent whose currency is being read
 * @returns Currency snapshot with `null` for absent fields
 */
export function agentCurrencySnapshot(agent: MakaioSessionAgent): AdapterSessionCurrencySnapshot {
  return {
    adapterSessionId: agent.adapterSessionId ?? null,
    currentAdapterSessionId: agent.currentAdapterSessionId ?? null,
    currentAdapterSessionIdState: agent.currentAdapterSessionIdState ?? 'inherited',
  };
}
