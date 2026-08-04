import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtractSubjectResponse } from '@makaio/core';
import { AdapterSubjects } from '@makaio/contracts';

/** What `adapter.rehydrateAgent` answers, as its own discriminated union. */
export type RehydrateAgentResult = ExtractSubjectResponse<typeof AdapterSubjects.rehydrateAgent>;

/** Everything one rehydrate dispatch needs, and nothing a plan would carry. */
export interface RehydrateDispatchRequest {
  /** Agent whose connector is being rebuilt. */
  readonly agentId: string;
  /** Live adapter instance the rehydrate is addressed to. */
  readonly adapterId: string;
  /** Working directory the replacement connector runs in. */
  readonly cwd?: string;
  /** Model the replacement connector runs. */
  readonly model?: string;
  /**
   * Provider session to resume, or `null` for a rehydrate that starts a fresh
   * provider conversation. Only a named target puts the replacement connector
   * into native-resume mode — the RPC carries no other identity marker.
   */
  readonly resumeProviderSessionId: string | null;
  /**
   * Whether the caller owns the agent row for this rehydrate.
   *
   * Set by a caller that moved the row to `starting` before dispatching and
   * performs the `starting → idle` transition itself after settlement.
   */
  readonly callerOwnsAgentRow?: true;
}

/**
 * Dispatch one rehydrate — the raw primitive, and the only producer of
 * `AdapterSubjects.rehydrateAgent` outside the adapter that handles it.
 *
 * Deliberately **not** exported from any barrel. Every service-owned rehydrate
 * goes through `runReservedRehydrate`, which reserves the provider session
 * before it dispatches; a second producer would be an unreserved path into a
 * live provider conversation, which is exactly what the ownership aggregate
 * exists to prevent. Keeping the primitive unreachable from outside this
 * directory makes that a compile error rather than a convention — an ESLint
 * pair narrows the surface *inside* it, and is a review aid, not a proof,
 * because an aliased call evades it.
 * @param bus - Bus the dispatch is issued on.
 * @param request - Agent, live adapter instance, resume target and row ownership.
 * @returns What the adapter answered: the confirmed provider session, or a modeled refusal.
 */
export async function dispatchAgentRehydrate(
  bus: IMakaioBus,
  request: RehydrateDispatchRequest,
): Promise<RehydrateAgentResult> {
  return bus.request(AdapterSubjects.rehydrateAgent, {
    adapterId: request.adapterId,
    agentId: request.agentId,
    ...(request.cwd !== undefined && { cwd: request.cwd }),
    ...(request.model !== undefined && { model: request.model }),
    ...(request.resumeProviderSessionId !== null && {
      resumeAdapterSessionId: request.resumeProviderSessionId,
    }),
    ...(request.callerOwnsAgentRow === true && { callerOwnsAgentRow: true as const }),
  });
}
