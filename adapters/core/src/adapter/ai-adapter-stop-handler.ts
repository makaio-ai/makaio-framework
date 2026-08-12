import type { RequestContext } from '@makaio/core';
import type { ExtractSubjectPayload, ExtractSubjectResponse } from '@makaio/core';
import { AdapterSubjects } from '@makaio/contracts';
import type { AgentDisposalReport, AgentTeardownOptions } from './agent-registry.js';

type StopAgentPayload = ExtractSubjectPayload<typeof AdapterSubjects.stopAgent>;
type StopAgentResponse = ExtractSubjectResponse<typeof AdapterSubjects.stopAgent>;

/** Dependencies for the exact-owner stop handler. */
export interface StopAgentHandlerDeps {
  /** Dispose one locally hosted agent. */
  readonly disposeAgent: (agentId: string, options: AgentTeardownOptions) => Promise<AgentDisposalReport>;
}

/**
 * Create the stop RPC implementation after routing selected this runtime.
 * @param deps - Local agent disposal dependency.
 * @returns Request handler reporting the observed teardown class.
 */
export function createStopAgentHandler(
  deps: StopAgentHandlerDeps,
): (ctx: RequestContext<StopAgentPayload, StopAgentResponse>) => Promise<void> {
  return async (ctx) => {
    const report = await deps.disposeAgent(ctx.payload.agentId, {
      deadline: ctx.deadline,
      ...(ctx.payload.teardown === 'connector-only' && { responsibility: 'connector-only' as const }),
    });

    ctx.setResult({
      success: report.found,
      evidence: report.evidence,
      ...(report.detail !== undefined && { detail: report.detail }),
    });
  };
}
