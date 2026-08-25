import type { ExtractSubjectPayload, ExtractSubjectResponse, RequestContext } from '@makaio/core';
import { AdapterSubjects } from '@makaio/contracts';
import { toAgentSummary } from './agent-registry.js';

type GetAgentPayload = ExtractSubjectPayload<typeof AdapterSubjects.getAgent>;
type GetAgentResponse = ExtractSubjectResponse<typeof AdapterSubjects.getAgent>;

/** Registry surface needed by the get-agent RPC. */
interface GetAgentRegistry {
  /** Look up one locally hosted agent. */
  get(agentId: string): Parameters<typeof toAgentSummary>[0] | undefined;
}

/**
 * Create the owner-addressed get-agent RPC implementation.
 * @param registry - Registry of agents hosted by this runtime incarnation.
 * @returns Request handler reporting local agent liveness.
 */
export function createGetAgentHandler(
  registry: GetAgentRegistry,
): (ctx: RequestContext<GetAgentPayload, GetAgentResponse>) => void {
  return (ctx) => {
    const entry = registry.get(ctx.payload.agentId);
    ctx.setResult({ agent: entry === undefined ? null : toAgentSummary(entry) });
  };
}
