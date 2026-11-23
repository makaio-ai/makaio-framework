import type { StartAgentResponsePayload } from './adapter-start-reservation.js';

/**
 * Build the success response of a completed start.
 * @param deps - Adapter identity echoed in the response
 * @param started - Agent, session and optional turn and settlement identifiers of the start
 * @returns The success response payload
 */
export function buildStartSuccess(
  deps: { adapterId: string; ownerInstanceId: string },
  started: {
    agentId: string;
    sessionId: string;
    adapterSessionId: string | undefined;
    messageId: string | undefined;
    settlementAckToken: string | undefined;
  },
): StartAgentResponsePayload {
  const { agentId, sessionId, adapterSessionId, messageId, settlementAckToken } = started;
  return {
    success: true,
    agentId,
    adapterId: deps.adapterId,
    ownerInstanceId: deps.ownerInstanceId,
    sessionId,
    adapterSessionId,
    ...(messageId !== undefined && { messageId }),
    ...(settlementAckToken !== undefined && { settlementAckToken }),
  };
}
