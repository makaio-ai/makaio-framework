import type { IMakaioBus } from '@makaio/bus-core';
import { createWorkflowCancelSubject } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import { WorkflowSubjects } from './namespace.js';

export type GateResolution = {
  action: 'approve' | 'reject';
  source: 'user' | 'timeout';
};

type PendingGateResolution = {
  resolve: (value: GateResolution) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type GateAwaitApprovalPayload = ExtractSubjectPayload<typeof WorkflowSubjects.gate.awaitApproval>;

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
   * Register `workflow.gate.respond` handler, routing its cleanup to the
   * provided sink so the executor's `BaseService` lifecycle owns teardown.
   * @param addCleanup - Cleanup sink from the owning service.
   */
  public registerResponseHandler(addCleanup: (cleanup: () => void) => void): void {
    addCleanup(
      this.bus.on(WorkflowSubjects.gate.respond, (ctx) => {
        const { executionId, stepId, action, reason } = ctx.payload;
        ctx.setResult({ accepted: this.resolve(executionId, stepId, action, 'user', reason) });
      }),
    );
  }

  /**
   * Resolve a pending gate by key, applying the given action from the given source.
   * @param executionId - Execution identifier.
   * @param stepId - Gate step identifier.
   * @param action - Resolution action to apply.
   * @param source - Source of the resolution (user or timeout).
   * @param _reason - Optional reason string (reserved for future use).
   * @returns True if a pending gate was found and resolved, false otherwise.
   */
  private resolve(
    executionId: string,
    stepId: string,
    action: 'approve' | 'reject',
    source: 'user' | 'timeout',
    _reason?: string,
  ): boolean {
    const key = this.getKey(executionId, stepId);
    const pendingResolution = this.pending.get(key);
    if (!pendingResolution) {
      return false;
    }
    this.pending.delete(key);
    if (pendingResolution.timeout !== undefined) clearTimeout(pendingResolution.timeout);
    pendingResolution.resolve({ action, source });
    return true;
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
   * Handle the main-process `gate.awaitApproval` RPC lifecycle.
   *
   * Registers cancellation before emitting `gate.requested`, preserving the
   * same tick response ordering while ensuring workflow cancellation releases
   * the pending gate promise.
   * @param payload - Gate approval request payload.
   * @returns Resolved gate action and source.
   */
  public async awaitApprovalRequest(payload: GateAwaitApprovalPayload): Promise<GateResolution> {
    const { executionId, stepId, autoAction, timeoutMs } = payload;
    const resolutionPromise = this.awaitResolution(executionId, stepId, autoAction, timeoutMs);
    const cancelCleanup = this.bus.on(createWorkflowCancelSubject(`workflow.${executionId}.cancel`), () => {
      this.resolveForCancellation(executionId, stepId);
    });
    try {
      await this.bus.emit(WorkflowSubjects.gate.requested, payload);
      return await resolutionPromise;
    } catch (error) {
      this.resolveForCancellation(executionId, stepId);
      throw error;
    } finally {
      cancelCleanup();
    }
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
