import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';

/**
 * Fields a successful caller-owned adapter dispatch must return.
 * @param payload - Caller-owned dispatch identity echoed by the test adapter.
 * @returns Owner and acknowledgement fields for a successful response.
 */
export function callerOwnedSuccessFields(payload: { readonly agentId?: string; readonly ownerInstanceId?: string }): {
  readonly ownerInstanceId: string;
  readonly settlementAckToken: string;
} {
  return {
    ownerInstanceId: payload.ownerInstanceId ?? 'test-owner-instance',
    settlementAckToken: `test-ack-${payload.agentId ?? crypto.randomUUID()}`,
  };
}

/**
 * Model the adapter's durable-settlement acknowledgement in service tests.
 * @param bus - Test bus carrying the adapter RPC and optional real agent storage.
 * @returns Cleanup for the acknowledgement handler.
 */
export function registerCallerSettlementAckHandler(bus: IMakaioBus): () => void {
  return bus.on(AdapterSubjects.acknowledgeCallerSettlement, async (ctx) => {
    if (ctx.payload.recovery === true) {
      // A guarded recovery's attempt-fenced finalizer owns `starting → idle`.
      // The adapter acknowledges only its connector generation here, matching
      // the production registry's recovery acknowledgement path.
      ctx.setResult({ acknowledged: true });
      return;
    }
    const transition = await bus.requestOptional(AgentStorageSubjects.updateStatus, {
      agentId: ctx.payload.agentId,
      status: 'idle',
      expectedStatus: ['starting', 'dead'],
    });
    if (!transition.handled) {
      ctx.setResult({ acknowledged: true });
      return;
    }
    ctx.setResult(
      transition.data.success && transition.data.transitioned
        ? { acknowledged: true }
        : { acknowledged: false, reason: 'status-refused' },
    );
  });
}
