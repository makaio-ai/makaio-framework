import {
  SessionOwnershipStorageSubjects,
  type SessionOwnershipClaimRequest,
  type SessionOwnershipReserveStartServiceRequest,
  type SessionOwnershipReserveStartServiceResult,
} from '@makaio/contracts';
import { mintClaimToken } from './claim-token.js';
import { KEYLESS_DESIGNATION_KEY } from './lead-designation.js';
import { resolveOwnershipMachineId, type OwnershipAuthorityContext } from './context.js';

/**
 * Reserve a start: one `storage:sessionOwnership.claim` call, and nothing else.
 *
 * There is no probing, no second attempt and no service-side assessment of who
 * holds a contested key. A key whose incumbent's agent row is `disposed` is
 * taken over by a predicate inside that same call; anything else that holds it
 * is `occupied` and the caller degrades. Deciding otherwise here would mean
 * authorizing a takeover from evidence read outside the transaction that acts
 * on it — the exact read-then-write this aggregate exists to remove.
 *
 * **At most once per start attempt.** Tokens are minted per call, so re-issuing
 * a reservation for the same agent and key while the previous generation is
 * still `held` answers `occupied` naming the agent's *own* previous claim. A
 * retry goes through the failed attempt's release first.
 *
 * **Machine identity is required only by a keyed reservation.** The ownership
 * key is `(machine, adapter instance, provider session)`, so reserving one
 * without knowing which machine this is would reserve in a namespace nothing
 * can be checked against — that stays a hard refusal. A **keyless** reservation
 * takes no key at all: its whole effect is the lead designation and the
 * membership check that goes with it, neither of which reads the machine. Both
 * backends prove that by construction, and the designation handlers already
 * write through the same inert triple. Refusing it too would mean a host
 * composed without a machine identity could not start a fresh lead agent at
 * all, which is not an ownership decision — it is a start being refused for
 * lacking something it never uses.
 * @param context - Composed authority context.
 * @param request - The reservation the caller wants.
 * @returns The reservation, or the reason it was refused.
 */
export async function runReserveStart(
  context: OwnershipAuthorityContext,
  request: SessionOwnershipReserveStartServiceRequest,
): Promise<SessionOwnershipReserveStartServiceResult> {
  const resolvedMachineId = resolveOwnershipMachineId(context, request.machineId);
  const keyless = request.resumeProviderSessionId === null;
  if (resolvedMachineId === undefined && !keyless) return { outcome: 'machine-identity-unavailable' };
  // The sentinel is never stored on a keyless reservation — no claim row is
  // written — and naming it explicitly keeps anything from coming to depend on
  // a machine identity that was never resolved.
  const machineId = resolvedMachineId ?? KEYLESS_DESIGNATION_KEY.machineId;

  const claimRequest: SessionOwnershipClaimRequest = {
    machineId,
    adapterId: request.adapterId,
    adapterName: request.adapterName,
    providerSessionId: request.resumeProviderSessionId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    claimToken: mintClaimToken(),
    ...(request.role === 'lead' && {
      // The request refinement makes `expectedLeadAgentId` present for a lead,
      // so the `?? null` is unreachable for a validated payload — but bus
      // payload validation is off in production builds and the exported
      // manifest cannot carry the refinement, so the total mapping is written
      // out rather than asserted. `null` is the honest reading of an absent
      // expectation: "the caller believes there is no lead yet".
      designateLead: { expectedLeadAgentId: request.expectedLeadAgentId ?? null },
    }),
  };

  const result = await context.bus.request(SessionOwnershipStorageSubjects.claim, claimRequest);
  switch (result.outcome) {
    case 'claimed':
    case 'idempotent':
      return {
        outcome: 'reserved',
        reservation: {
          agentId: request.agentId,
          sessionId: request.sessionId,
          machineId,
          adapterId: request.adapterId,
          claim: result.claim,
          leadDesignated: result.leadDesignated,
          previousLeadAgentId: result.previousLeadAgentId,
        },
      };
    case 'already-claimed':
      return { outcome: 'occupied', holder: result.holder };
    case 'lead-conflict':
      return { outcome: 'lead-conflict', currentLeadAgentId: result.currentLeadAgentId };
    case 'agent-disposed':
      return { outcome: 'agent-disposed' };
    case 'not-found':
      return { outcome: 'not-found', missing: result.missing };
  }
}
