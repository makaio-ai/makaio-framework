import type { IMakaioBus } from '@makaio/bus-core';
import { ExecutionAttemptSchemas, ExecutionAttemptSubjects } from '@makaio/contracts';
import type { BootstrapStartAuthority } from './bootstrap-start.js';
import { resolveExecutionAttemptPeer } from './execution-bound-access.js';

/**
 * Register attempt-authenticated start authorization and own its pending waits.
 * @param bus - Bus receiving the authenticated requests.
 * @param authority - Durable start authorization, shared with credential ingress.
 * @returns Idempotent cleanup that cancels waits before removing the handler.
 */
export function registerBootstrapStartHandler(bus: IMakaioBus, authority: BootstrapStartAuthority): () => void {
  const shutdown = new AbortController();
  const unregister = bus.on(ExecutionAttemptSubjects.bootstrap.awaitStart, async (ctx) => {
    const peer = resolveExecutionAttemptPeer(ctx);
    if (peer === null) throw new Error('Bootstrap start requires an authenticated workflow-execution-attempt peer');
    const { executionAttemptId } = ExecutionAttemptSchemas['bootstrap.awaitStart'].request.parse(ctx.payload);
    if (executionAttemptId !== peer.executionAttemptId) {
      throw new Error('Bootstrap start executionAttemptId does not match authenticated peer identity');
    }
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, shutdown.signal]) : shutdown.signal;
    ctx.setResult(
      await authority.awaitBootstrapStart(
        { executionAttemptId, executionId: peer.executionId },
        { signal, deadline: ctx.deadline ?? Date.now() + 31_000 },
      ),
    );
  });
  return () => {
    if (shutdown.signal.aborted) return;
    shutdown.abort(new Error('Bootstrap start handler shut down'));
    unregister();
  };
}
