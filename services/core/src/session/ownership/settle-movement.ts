import {
  SessionOwnershipStorageSubjects,
  type OwnershipMovement,
  type SessionOwnershipServiceMovement,
  type SessionOwnershipSettleMovementServiceRequest,
  type SessionOwnershipSettleMovementServiceResult,
} from '@makaio/contracts';
import { mintClaimToken } from './claim-token.js';
import { resolveOwnershipMachineId, type OwnershipAuthorityContext } from './context.js';

/** How many times a `currency-changed` refusal is re-attempted. */
const CURRENCY_CHANGED_RETRY_BUDGET = 1;

/**
 * Turn an observed movement into the durable movement the seam understands.
 *
 * The token is minted here, per attempt, and is used only when the agent does
 * not already hold the target key: an agent that does is settled under the
 * generation it has, and this token names no row at all. That is what keeps a
 * repeat idempotent instead of minting a second generation for a key the agent
 * already owns.
 * @param movement - The observation, as a real union.
 * @returns The durable movement, carrying a fresh generation token.
 */
function toDurableMovement(movement: SessionOwnershipServiceMovement): OwnershipMovement {
  return movement.confirmed
    ? { kind: 'confirmed', providerSessionId: movement.providerSessionId, claimToken: mintClaimToken() }
    : { kind: 'demote', claimToken: mintClaimToken() };
}

/**
 * Record a provider-session movement against the agent that made it.
 *
 * The whole act is one storage transaction underneath, so a crash mid-flight
 * leaves either the complete movement or none of it. What happens here is only
 * the compare-and-swap bookkeeping the transaction needs: read the revision the
 * caller's target will be computed against, and re-read it exactly once when a
 * concurrent write inside the same generation moved the row underneath.
 *
 * **The retry budget is exactly one.** `currency-changed` means a lost race
 * within one generation, which a fresh read resolves; a second loss means
 * contention this operation cannot arbitrate — and looping would let one
 * agent's announcements starve the queue behind them. The caller is told and
 * the seam re-announces.
 * @param context - Composed authority context.
 * @param request - The movement, and the principal that observed it.
 * @returns The durable outcome, or `machine-identity-unavailable`.
 */
export async function runSettleMovement(
  context: OwnershipAuthorityContext,
  request: SessionOwnershipSettleMovementServiceRequest,
): Promise<SessionOwnershipSettleMovementServiceResult> {
  const machineId = resolveOwnershipMachineId(context, request.machineId);
  if (machineId === undefined) return { outcome: 'machine-identity-unavailable' };

  for (let attempt = 0; ; attempt += 1) {
    const { ownership } = await context.bus.request(SessionOwnershipStorageSubjects.read, {
      agentId: request.agentId,
    });
    // No ownership row means no agent row: the movement names an agent that is
    // not there, which the durable operation would report the same way.
    if (ownership === null) return { outcome: 'not-found' };

    const result = await context.bus.request(SessionOwnershipStorageSubjects.settleMovement, {
      machineId,
      adapterId: request.adapterId,
      adapterName: request.adapterName,
      sessionId: request.sessionId,
      agentId: request.agentId,
      expectedRevision: ownership.revision,
      movement: toDurableMovement(request.movement),
    });

    if (result.outcome !== 'currency-changed' || attempt >= CURRENCY_CHANGED_RETRY_BUDGET) return result;
  }
}
