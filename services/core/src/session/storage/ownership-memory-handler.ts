/**
 * In-memory handlers for the `storage:sessionOwnership` namespace.
 *
 * The volatile twin of `ownership-drizzle-handler.ts`: same operations, same
 * invariant — exactly one runtime owns a provider-native session within its
 * machine/adapter namespace, agent currency may only be written by the current
 * claim generation, and the session row's currency snapshot mirrors the
 * designated lead's.
 *
 * **Where atomicity comes from.** The SQL backend gets it from a transaction;
 * here it comes from never `await`-ing between a state read and its paired
 * write. Every handler body below — and everything it calls in
 * `ownership-memory-claim.ts` and `ownership-memory-settle.ts` — is synchronous
 * end to end, so no other bus request can interleave between a decision and the
 * write it authorizes. An `await` introduced inside them would silently drop
 * that guarantee.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import type { AdapterSessionClaimRecord } from '@makaio/contracts';
import { SessionOwnershipSettleMovementRequestSchema, SessionOwnershipStorageSubjects } from '@makaio/contracts';
import { type SessionStorageMemoryState, createSessionStorageMemoryState } from './memory-store.js';
import { runClaim } from './ownership-memory-claim.js';
import {
  agentCurrencySnapshot,
  ensureMemoryRuntimeInstance,
  findClaimByToken,
  runtimeInstanceKey,
} from './ownership-memory-rows.js';
import {
  applySettle,
  adoptSettledLegacyGeneration,
  resolveMovementTarget,
  runMovementClaimsPhase,
  type IdentifiedMovementRequest,
} from './ownership-memory-settle.js';

// ─── Per-subject registration ────────────────────────────────────────────────

/**
 * Register the handler for `storage:sessionOwnership.read`.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerReadHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.read, (ctx) => {
    const { agentId } = ctx.payload;
    const agent = state.agents.get(agentId);
    if (agent === undefined) {
      ctx.setResult({ ownership: null });
      return;
    }
    const agentClaims = Array.from(state.claims.values())
      .filter((claim) => claim.agentId === agentId)
      .sort((a, b) => a.fence - b.fence || a.claimId.localeCompare(b.claimId));

    ctx.setResult({
      ownership: {
        agentId,
        sessionId: agent.sessionId,
        currency: agentCurrencySnapshot(agent),
        revision: agent.revision ?? 0,
        currencyFence: agent.currencyFence ?? 0,
        claims: agentClaims.map((claim) => structuredClone(claim)),
      },
    });
  });
}

/**
 * Register the handler for `storage:sessionOwnership.settleCurrency`.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerSettleCurrencyHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.settleCurrency, (ctx) => {
    const agent = state.agents.get(ctx.payload.agentId);
    if (agent === undefined) {
      ctx.setResult({ outcome: 'not-found' });
      return;
    }
    ctx.setResult(applySettle(state, agent, ctx.payload));
  });
}

/**
 * Register the attempt-fenced terminal recovery transition.
 * @param bus - Bus that receives terminal recovery requests.
 * @param state - Shared in-memory ownership state.
 * @returns Cleanup function that unregisters the terminal recovery handler.
 */
function registerFinalizeRecoveryHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.finalizeRecovery, (ctx) => {
    const { agentId, attemptId, binding, action } = ctx.payload;
    const agent = state.agents.get(agentId);
    if (
      agent === undefined ||
      agent.status !== 'starting' ||
      agent.recoveryAttemptId !== attemptId ||
      agent.adapterId !== binding.adapterId ||
      agent.runtimeOwner?.machineId !== binding.ownerMachineId ||
      agent.runtimeOwner?.instanceId !== binding.ownerInstanceId
    ) {
      ctx.setResult({ applied: false });
      return;
    }
    if (action.kind === 'rollback') {
      agent.status = action.preimage.status;
      agent.adapterId = action.preimage.adapterId;
      agent.runtimeOwner =
        action.preimage.binding === undefined
          ? undefined
          : {
              machineId: action.preimage.binding.ownerMachineId,
              instanceId: action.preimage.binding.ownerInstanceId,
            };
      agent.recoveryAttemptId = action.preimage.recoveryAttemptId;
    } else {
      agent.status = action.kind === 'succeeded' ? 'idle' : 'dead';
      agent.recoveryAttemptId = undefined;
    }
    agent.lastActivityAt = Date.now();
    ctx.setResult({ applied: true });
  });
}

/**
 * Register the handler for `storage:sessionOwnership.settleMovement`.
 *
 * One provider-session movement, one act: acquire (or recognize) the successor
 * generation, settle the agent's currency under it, retire the predecessors it
 * replaces, and mirror the result onto the session row. The SQL twin gets its
 * atomicity from a transaction; here it comes from the whole body being
 * synchronous, plus the explicit undo a refused settle runs.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerSettleMovementHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.settleMovement, (ctx) => {
    const payload = SessionOwnershipSettleMovementRequestSchema.parse(ctx.payload);
    const ownerInstance = payload.ownerInstance;
    if (ownerInstance === undefined) throw new Error('session ownership movement requires ownerInstance');
    const ownerKey = runtimeInstanceKey(ownerInstance.instanceId, payload.machineId);
    const ownerAlreadyExisted = state.runtimeInstances.has(ownerKey);
    ensureMemoryRuntimeInstance(state, ownerInstance.instanceId, payload.machineId, Date.now());
    const identifiedPayload: IdentifiedMovementRequest = {
      ...payload,
      ownerInstance,
    };
    const agent = state.agents.get(payload.agentId);
    if (agent === undefined || agent.sessionId !== payload.sessionId) {
      if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
      ctx.setResult({ outcome: 'not-found' });
      return;
    }
    if (agent.status === 'disposed') {
      if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
      ctx.setResult({ outcome: 'agent-disposed' });
      return;
    }

    const target = resolveMovementTarget(identifiedPayload.movement, agent);
    if (target === null) {
      // A demotion of an agent with nothing resumable resolves no key, so it
      // names no generation and there is nothing to write.
      if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
      ctx.setResult({
        outcome: 'idempotent',
        revision: agent.revision ?? 0,
        currency: agentCurrencySnapshot(agent),
        sessionSnapshotUpdated: false,
        claim: null,
      });
      return;
    }

    const phase = runMovementClaimsPhase(state, identifiedPayload, target.providerSessionId);
    if (!('generation' in phase)) {
      if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
      ctx.setResult(phase);
      return;
    }

    const settled = applySettle(state, agent, {
      agentId: payload.agentId,
      claimToken: phase.generation.claimToken,
      fence: phase.generation.fence,
      expectedRevision: payload.expectedRevision,
      target: target.currency,
    });
    if (settled.outcome !== 'settled') {
      phase.rollback();
      if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
      ctx.setResult(
        settled.outcome === 'idempotent' ? { ...settled, claim: structuredClone(phase.generation) } : settled,
      );
      return;
    }

    const persistedGeneration = adoptSettledLegacyGeneration(state, phase.generation, ownerInstance.instanceId);
    ctx.setResult({
      outcome: 'settled',
      revision: settled.revision,
      currency: settled.currency,
      sessionSnapshotUpdated: settled.sessionSnapshotUpdated,
      releasedProviderSessionIds: phase.releasedProviderSessionIds,
      claim: structuredClone(persistedGeneration),
    });
  });
}

/**
 * Register the handler for `storage:sessionOwnership.releaseAgentClaims`.
 *
 * **One pass over the agent's claims, never a read followed by per-claim
 * releases.** A teardown that lists an agent's claims and retires them one by
 * one cannot see a claim taken between the list and the last release — and an
 * agent legitimately holds two mid-movement. Naming a token scopes the act to
 * one generation, which is the rollback form.
 *
 * **Not `disposed`-guarded**, unlike every operation that *takes* authority, and
 * an agent whose row is gone entirely still yields empty lists rather than an
 * error: giving a claim up is the one act a removed agent must still perform.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerReleaseAgentClaimsHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.releaseAgentClaims, (ctx) => {
    const { agentId, claimToken, disposition } = ctx.payload;

    const scoped = Array.from(state.claims.values()).filter(
      (claim) => claim.agentId === agentId && (claimToken === undefined || claim.claimToken === claimToken),
    );

    if (disposition === 'released') {
      for (const claim of scoped) state.claims.delete(claim.claimId);
      ctx.setResult({
        releasedProviderSessionIds: scoped.map((claim) => claim.providerSessionId),
        markedClaims: [],
        claimTokenNotFound: claimToken !== undefined && scoped.length === 0,
      });
      return;
    }

    const now = Date.now();
    const markedClaims = scoped.map((claim) => {
      const marked: AdapterSessionClaimRecord = { ...claim, status: disposition, updatedAt: now };
      state.claims.set(claim.claimId, structuredClone(marked));
      return marked;
    });
    ctx.setResult({
      releasedProviderSessionIds: [],
      markedClaims,
      claimTokenNotFound: claimToken !== undefined && scoped.length === 0,
    });
  });
}

/**
 * Register the handler for `storage:sessionOwnership.release`.
 *
 * Only a clean release removes the row and frees the ownership key; `releasing`
 * and `abandoned` keep blocking it, because the provider process may still be
 * alive and a second owner attaching to a live conversation is the outcome this
 * aggregate exists to prevent.
 *
 * **Asymmetry with `settleCurrency`, deliberately.** The settle additionally
 * requires the claim to be filed under the agent's *current* session; the
 * release does not. A settle exercises the claim as authority over an agent's
 * currency, so a claim that no longer represents an ownership of that agent's
 * session may not carry it. A release only gives the claim up, and giving
 * something up needs no authority beyond having been the one who took it — token
 * plus agent. Requiring session membership here would strand exactly the claims
 * that most need retiring: an agent reassigned to another session would leave
 * its old generation unreleasable, blocking the ownership key forever.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerReleaseHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.release, (ctx) => {
    const { agentId, claimToken, disposition } = ctx.payload;

    const claim = findClaimByToken(state.claims, claimToken);
    if (claim === undefined) {
      ctx.setResult({ outcome: 'not-found' });
      return;
    }
    if (claim.agentId !== agentId) {
      ctx.setResult({ outcome: 'not-owner', holder: structuredClone(claim) });
      return;
    }
    if (disposition === 'released') {
      // **Token and agent are the whole condition — the status is not consulted,
      // deliberately**, exactly as in the SQL twin. A generation already marked
      // `abandoned` is therefore still cleanly releasable by a delayed
      // `released` of its own, which looks like it bypasses "blocks until a
      // takeover" and does not: `abandoned` is a *presumption* filed by an
      // observer that the owner died with teardown unconfirmed, and it blocks
      // everyone else because no one else can know. A `released` carrying that
      // generation's own token is the one party who can know refuting it, and
      // the row's purpose — keeping a possibly-live provider conversation from
      // being attached to twice — is fulfilled rather than bypassed. Requiring
      // `held` here would strand the key against the very owner coming back to
      // confirm its own teardown.
      state.claims.delete(claim.claimId);
      ctx.setResult({ outcome: 'released' });
      return;
    }

    const marked: AdapterSessionClaimRecord = { ...claim, status: disposition, updatedAt: Date.now() };
    state.claims.set(claim.claimId, structuredClone(marked));
    ctx.setResult({ outcome: 'marked', claim: structuredClone(marked) });
  });
}

/**
 * Register the handler for `storage:sessionOwnership.listClaims`.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerListClaimsHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.listClaims, (ctx) => {
    const { machineId, adapterId, providerSessionId, statuses } = ctx.payload;

    const claims = Array.from(state.claims.values()).filter(
      (claim) =>
        claim.machineId === machineId &&
        (adapterId === undefined || claim.adapterId === adapterId) &&
        (providerSessionId === undefined || claim.providerSessionId === providerSessionId) &&
        (statuses === undefined || statuses.includes(claim.status)),
    );
    claims.sort((a, b) => a.claimedAt - b.claimedAt || a.claimId.localeCompare(b.claimId));

    ctx.setResult({ claims: claims.map((claim) => structuredClone(claim)) });
  });
}

/**
 * Register runtime-instance retirement without releasing any claims.
 * @param bus - The bus instance to register the handler on.
 * @param state - Shared in-memory state.
 * @returns Cleanup function to unsubscribe the handler.
 */
function registerRetireInstanceHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.retireInstance, (ctx) => {
    const now = Date.now();
    let retiredMachines = 0;
    for (const [key, instance] of state.runtimeInstances) {
      if (instance.instanceId !== ctx.payload.instanceId || instance.retiredAt !== null) continue;
      state.runtimeInstances.set(key, { ...instance, retiredAt: now });
      retiredMachines += 1;
    }
    ctx.setResult({ retiredMachines });
  });
}

/**
 * Register the runtime-instance diagnostic read.
 * @param bus - The bus instance to register the handler on.
 * @param state - Shared in-memory state.
 * @returns Cleanup function to unsubscribe the handler.
 */
function registerGetRuntimeInstanceHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.getRuntimeInstance, (ctx) => {
    const instance = state.runtimeInstances.get(runtimeInstanceKey(ctx.payload.instanceId, ctx.payload.machineId));
    ctx.setResult({ instance: instance === undefined ? null : structuredClone(instance) });
  });
}

// ─── Handler registration ─────────────────────────────────────────────────────

/**
 * Register in-memory session ownership storage handlers.
 *
 * Pass a shared `SessionStorageMemoryState` to make these handlers operate on
 * the same session and agent rows as `registerMemorySessionStorage` and
 * `registerMemoryAgentStorage`. Omit it (or pass `undefined`) to get an isolated
 * private store — useful only for unit tests that exercise ownership without
 * needing real sessions or agents.
 * @param bus - The bus instance to register handlers on
 * @param state - Shared in-memory state; defaults to a new isolated instance
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerMemorySessionOwnershipStorage(
  bus: IMakaioBus,
  state: SessionStorageMemoryState = createSessionStorageMemoryState(),
): () => void {
  const unsubs = [
    registerReadHandler(bus, state),
    registerFinalizeRecoveryHandler(bus, state),
    bus.on(SessionOwnershipStorageSubjects.claim, (ctx) => {
      ctx.setResult(runClaim(state, ctx.payload));
    }),
    registerSettleCurrencyHandler(bus, state),
    registerSettleMovementHandler(bus, state),
    registerReleaseHandler(bus, state),
    registerReleaseAgentClaimsHandler(bus, state),
    registerListClaimsHandler(bus, state),
    registerRetireInstanceHandler(bus, state),
    registerGetRuntimeInstanceHandler(bus, state),
  ];

  return () => {
    for (let index = unsubs.length - 1; index >= 0; index -= 1) unsubs[index]?.();
  };
}
