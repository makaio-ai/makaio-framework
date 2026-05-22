import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from './namespace.js';

export type GateResolution = {
  action: 'approve' | 'reject';
  source: 'user' | 'timeout';
};

type PendingGateResolution = {
  resolve: (value: GateResolution) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

/**
 * Coordinates gate-step response lifecycle for WorkflowExecutor.
 */
export class WorkflowGateCoordinator {
  private readonly pending = new Map<string, PendingGateResolution>();

  /**
   * @param bus - Bus used to accept gate responses.
   */
  public constructor(private readonly bus: IMakaioBus) {}

  /**
   * Register `workflow.gate.respond` handler.
   * @param cleanupFns - Cleanup array owned by executor.
   */
  public registerResponseHandler(cleanupFns: Array<() => void>): void {
    cleanupFns.push(
      this.bus.on(WorkflowSubjects.gate.respond, (ctx) => {
        const key = this.getKey(ctx.payload.executionId, ctx.payload.stepId);
        const pendingResolution = this.pending.get(key);
        if (!pendingResolution) {
          ctx.setResult({ accepted: false });
          return;
        }

        this.pending.delete(key);
        if (pendingResolution.timeout !== undefined) clearTimeout(pendingResolution.timeout);
        pendingResolution.resolve({ action: ctx.payload.action, source: 'user' });
        ctx.setResult({ accepted: true });
      }),
    );
  }

  /**
   * Await gate decision from user or timeout.
   * @param executionId - Execution identifier.
   * @param stepId - Gate step identifier.
   * @param autoAction - Action to apply on timeout.
   * @param timeoutMs - Timeout in milliseconds, or `null` for infinite wait.
   * @returns Resolved gate action and its source.
   */
  public awaitResolution(
    executionId: string,
    stepId: string,
    autoAction: 'approve' | 'reject',
    timeoutMs: number | null,
  ): Promise<GateResolution> {
    return new Promise((resolve) => {
      const key = this.getKey(executionId, stepId);
      const pendingResolution: PendingGateResolution = { resolve };

      this.pending.set(key, pendingResolution);

      if (timeoutMs === null) return;

      pendingResolution.timeout = setTimeout(() => {
        const current = this.pending.get(key);
        if (!current) return;
        this.pending.delete(key);
        current.resolve({ action: autoAction, source: 'timeout' });
      }, timeoutMs);
    });
  }

  /**
   * Resolve and clear pending gate for a cancelled step.
   * @param executionId - Execution identifier.
   * @param stepId - Step identifier.
   */
  public resolveForCancellation(executionId: string, stepId: string): void {
    const key = this.getKey(executionId, stepId);
    const pendingResolution = this.pending.get(key);
    if (!pendingResolution) return;

    if (pendingResolution.timeout !== undefined) clearTimeout(pendingResolution.timeout);
    this.pending.delete(key);
    pendingResolution.resolve({ action: 'reject', source: 'timeout' });
  }

  /**
   * Resolve and clear all pending gates (runtime shutdown).
   */
  public dispose(): void {
    for (const [key, pendingResolution] of this.pending) {
      if (pendingResolution.timeout !== undefined) clearTimeout(pendingResolution.timeout);
      pendingResolution.resolve({ action: 'reject', source: 'timeout' });
      this.pending.delete(key);
    }
  }

  /**
   * Build map key for pending gate entry.
   * @param executionId - Execution identifier.
   * @param stepId - Step identifier.
   * @returns Stable map key.
   */
  private getKey(executionId: string, stepId: string): string {
    return `${executionId}:${stepId}`;
  }
}
