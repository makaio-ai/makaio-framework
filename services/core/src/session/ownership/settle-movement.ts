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
 * The token is used only when the agent does not already hold the target key:
 * an agent that does is settled under the generation it has, and this token
 * names no row at all. That is what keeps a repeat idempotent instead of
 * minting a second generation for a key the agent already owns.
 * @param movement - The observation, as a real union.
 * @param claimToken - Generation the successor is minted under.
 * @returns The durable movement, carrying the generation token.
 */
function toDurableMovement(movement: SessionOwnershipServiceMovement, claimToken: string): OwnershipMovement {
  return movement.confirmed
    ? { kind: 'confirmed', providerSessionId: movement.providerSessionId, claimToken }
    : { kind: 'demote', claimToken };
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
 *
 * **The successor's token is the caller's when it names one**, and is minted
 * once per call otherwise — never once per attempt. A caller that has a
 * rollback to perform must be able to name the generation its own settlement
 * created *without* seeing the response, because the response is exactly what a
 * dropped packet takes away. Reusing one token across the bounded retry is safe
 * in both directions: `currency-changed` rolls its transaction back, so no row
 * carries the token and the token uniqueness constraint cannot fire; and a
 * repeat that follows a committed settlement finds the agent already holding
 * the target key, discards the token unused and reports `idempotent`.
 * @param context - Composed authority context.
 * @param request - The movement, and the principal that observed it.
 * @returns The durable outcome, or `machine-identity-unavailable`.
 */
export async function runSettleMovement(
  context: OwnershipAuthorityContext,
  request: SessionOwnershipSettleMovementServiceRequest,
): Promise<SessionOwnershipSettleMovementServiceResult> {
  if (request.ownerInstanceId !== context.instanceId) {
    throw new Error(`settleMovement routed to owner ${context.instanceId} for target ${request.ownerInstanceId}`);
  }
  const machineId = resolveOwnershipMachineId(context, request.machineId);
  if (machineId === undefined) return { outcome: 'machine-identity-unavailable' };
  const claimToken = request.claimToken ?? mintClaimToken();

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
      movement: toDurableMovement(request.movement, claimToken),
      ownerInstance: { instanceId: request.ownerInstanceId },
      topology: context.topology,
    });

    if (result.outcome !== 'currency-changed' || attempt >= CURRENCY_CHANGED_RETRY_BUDGET) return result;
  }
}
