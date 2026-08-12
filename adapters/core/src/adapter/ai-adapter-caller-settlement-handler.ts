import type { ExtractSubjectPayload, ExtractSubjectResponse, RequestContext } from '@makaio/core';
import { AdapterSubjects } from '@makaio/contracts';

type AcknowledgeCallerSettlementPayload = ExtractSubjectPayload<typeof AdapterSubjects.acknowledgeCallerSettlement>;
type AcknowledgeCallerSettlementResponse = ExtractSubjectResponse<typeof AdapterSubjects.acknowledgeCallerSettlement>;

/** Registry surface needed by the caller-settlement acknowledgement RPC. */
interface CallerSettlementRegistry {
  /** Acknowledge the exact recovery settlement accepted by this runtime. */
  acknowledgeCallerSettlement(
    agentId: string,
    settlementAckToken: string,
    recovery: boolean,
  ): Promise<AcknowledgeCallerSettlementResponse>;
}

/**
 * Create the caller-settlement acknowledgement implementation after routing selected this runtime.
 * @param registry - Registry of agents hosted by this runtime incarnation.
 * @returns Request handler that acknowledges an exact caller settlement.
 */
export function createAcknowledgeCallerSettlementHandler(
  registry: CallerSettlementRegistry,
): (ctx: RequestContext<AcknowledgeCallerSettlementPayload, AcknowledgeCallerSettlementResponse>) => Promise<void> {
  return async (ctx) => {
    ctx.setResult(
      await registry.acknowledgeCallerSettlement(
        ctx.payload.agentId,
        ctx.payload.settlementAckToken,
        ctx.payload.recovery === true,
      ),
    );
  };
}
