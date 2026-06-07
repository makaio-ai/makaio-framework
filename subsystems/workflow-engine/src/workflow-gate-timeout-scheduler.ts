import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowStorageSubjects } from './storage/namespace.js';

export interface WorkflowGateTimeoutPayload {
  readonly executionId: string;
  readonly nodeId: string;
  readonly frameId: string;
  readonly timeoutMs: number | null;
  readonly openedAt: number;
}

/** Maximum delay Node.js timers accept without overflowing to a near-immediate timeout. */
const NODE_SET_TIMEOUT_MAX_DELAY_MS = 2_147_483_647;

/** Delay between expired gate timeout checks while the runner is still parking. */
const PAUSE_PERSISTENCE_RETRY_DELAY_MS = 25;

/** Initial delay before retrying a failed expired-gate wakeup. */
const EXPIRED_WAKEUP_FAILURE_RETRY_INITIAL_DELAY_MS = 250;

/** Maximum delay between failed expired-gate wakeup retries. */
const EXPIRED_WAKEUP_FAILURE_RETRY_MAX_DELAY_MS = 2_000;

/** Maximum failed expired-gate wakeup retries before surfacing a stuck gate. */
const EXPIRED_WAKEUP_FAILURE_MAX_RETRIES = 4;

type ScheduledWorkflowGateTimeoutPayload = WorkflowGateTimeoutPayload & {
  readonly timeoutMs: number;
  readonly failedWakeupAttempts?: number;
};
type TimedOutGateResumeDecision = 'resumed' | 'retry' | 'settled';

/**
 * Owns timeout wakeups for gate frames whose workflow runner has parked.
 */
export class WorkflowGateTimeoutScheduler {
  private readonly handles = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Create a timeout scheduler for paused workflow gates.
   * @param bus - Workflow bus used to inspect persisted execution and gate state.
   * @param resumePausedExecution - Callback that re-dispatches a paused execution.
   */
  public constructor(
    private readonly bus: IMakaioBus,
    private readonly resumePausedExecution: (executionId: string) => Promise<void>,
  ) {}

  /**
   * Dispose all pending timeout handles.
   */
  public dispose(): void {
    for (const timeoutHandle of this.handles.values()) {
      clearTimeout(timeoutHandle);
    }
    this.handles.clear();
  }

  /**
   * Clear a scheduled timeout for a concrete gate frame.
   * @param executionId - Execution the gate belongs to.
   * @param gateId - Gate node ID.
   * @param frameId - Gate frame ID.
   */
  public clear(executionId: string, gateId: string, frameId: string): void {
    const key = this.makeKey(executionId, gateId, frameId);
    const timeoutHandle = this.handles.get(key);
    if (timeoutHandle === undefined) return;
    clearTimeout(timeoutHandle);
    this.handles.delete(key);
  }

  /**
   * Schedule re-dispatch for a paused gate when its timeout expires.
   *
   * In-process gates keep their own runtime timer. Exit-based gates tear that
   * runtime down after `gate.suspended`, so this long-lived scheduler wakes the
   * paused execution back up at the deadline. The gate node then applies the
   * timeout through its normal persisted-gate resume path.
   * @param gate - Suspended gate lifecycle payload.
   */
  public schedule(gate: WorkflowGateTimeoutPayload): void {
    if (gate.timeoutMs === null) return;

    this.clear(gate.executionId, gate.nodeId, gate.frameId);
    this.scheduleNextWakeup({ ...gate, timeoutMs: gate.timeoutMs });
  }

  /**
   * Schedule the next wakeup chunk for a finite timeout gate.
   * @param gate - Suspended gate with a finite timeout policy.
   */
  private scheduleNextWakeup(gate: ScheduledWorkflowGateTimeoutPayload): void {
    const key = this.makeKey(gate.executionId, gate.nodeId, gate.frameId);
    const delayMs = Math.max(0, gate.openedAt + gate.timeoutMs - Date.now());
    const timerDelayMs = Math.min(delayMs, NODE_SET_TIMEOUT_MAX_DELAY_MS);
    const timeoutHandle = setTimeout(() => {
      this.handles.delete(key);
      if (Date.now() < gate.openedAt + gate.timeoutMs) {
        this.scheduleNextWakeup(gate);
        return;
      }

      void this.handleExpiredWakeup(gate);
    }, timerDelayMs);
    this.handles.set(key, timeoutHandle);
  }

  /**
   * Re-arm an already-expired gate timeout after a fixed delay.
   * @param gate - Suspended gate with a finite timeout policy.
   * @param delayMs - Delay before checking paused execution state again.
   */
  private scheduleNextWakeupAfterDelay(gate: ScheduledWorkflowGateTimeoutPayload, delayMs: number): void {
    const key = this.makeKey(gate.executionId, gate.nodeId, gate.frameId);
    const timeoutHandle = setTimeout(() => {
      this.handles.delete(key);
      void this.handleExpiredWakeup(gate);
    }, delayMs);
    this.handles.set(key, timeoutHandle);
  }

  /**
   * Resume an expired gate timeout or keep polling while the runner persists pause state.
   * @param gate - Expired suspended gate with a finite timeout policy.
   */
  private async handleExpiredWakeup(gate: ScheduledWorkflowGateTimeoutPayload): Promise<void> {
    try {
      const decision = await this.resumeTimedOutPausedGate(gate);
      if (decision === 'retry') {
        this.scheduleNextWakeupAfterDelay(gate, PAUSE_PERSISTENCE_RETRY_DELAY_MS);
      }
    } catch (error: unknown) {
      this.scheduleFailedWakeupRetry(gate, error);
    }
  }

  /**
   * Retry transient wakeup failures with bounded backoff.
   *
   * The short 25 ms poll is reserved for the expected runner-unwinding state.
   * Exceptions can also represent permanent invariant failures, so they need a
   * retry budget instead of an unbounded tight loop.
   * @param gate - Expired suspended gate whose wakeup failed.
   * @param error - Failure thrown while reading state or dispatching resume.
   */
  private scheduleFailedWakeupRetry(gate: ScheduledWorkflowGateTimeoutPayload, error: unknown): void {
    const failedWakeupAttempts = (gate.failedWakeupAttempts ?? 0) + 1;
    if (failedWakeupAttempts > EXPIRED_WAKEUP_FAILURE_MAX_RETRIES) {
      console.error(
        `[WorkflowExecutor] Giving up on timed-out gate '${gate.nodeId}' after ${EXPIRED_WAKEUP_FAILURE_MAX_RETRIES} failed wakeup retries:`,
        error,
      );
      return;
    }

    const retryDelayMs = Math.min(
      EXPIRED_WAKEUP_FAILURE_RETRY_INITIAL_DELAY_MS * 2 ** (failedWakeupAttempts - 1),
      EXPIRED_WAKEUP_FAILURE_RETRY_MAX_DELAY_MS,
    );
    console.error(
      `[WorkflowExecutor] Failed to resume timed-out gate '${gate.nodeId}', retrying in ${retryDelayMs} ms:`,
      error,
    );
    this.scheduleNextWakeupAfterDelay({ ...gate, failedWakeupAttempts }, retryDelayMs);
  }

  private makeKey(executionId: string, gateId: string, frameId: string): string {
    return `${executionId}:${gateId}:${frameId}`;
  }

  private async resumeTimedOutPausedGate(gate: {
    readonly executionId: string;
    readonly nodeId: string;
    readonly frameId: string;
  }): Promise<TimedOutGateResumeDecision> {
    this.clear(gate.executionId, gate.nodeId, gate.frameId);

    const { gate: persistedGate } = await this.bus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId: gate.executionId,
      nodeId: gate.nodeId,
      frameId: gate.frameId,
    });
    if (persistedGate === null || persistedGate.status !== 'waiting') return 'settled';

    const { execution } = await this.bus.request(WorkflowStorageSubjects.getExecution, {
      executionId: gate.executionId,
    });
    if (execution?.status === 'running') return 'retry';
    if (execution?.status !== 'paused') return 'settled';

    await this.resumePausedExecution(gate.executionId);
    return 'resumed';
  }
}
