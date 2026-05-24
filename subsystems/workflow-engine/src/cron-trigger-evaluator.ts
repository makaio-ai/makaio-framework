/**
 * Machine-side cron trigger evaluator.
 *
 * Schedules local cron jobs for workflows with `cron` triggers and fires
 * `WorkflowSubjects.start` when they become due. Only active on machines
 * with the `'main-dev-machine'` role.
 */

import { Cron } from 'croner';
import type { IMakaioBus } from '@makaio/bus-core';
import type { WorkflowDefinition } from '@makaio/contracts';
import { WorkflowSubjects } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';

// ─────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────

/**
 * An active croner job entry for a single cron trigger.
 */
interface CronJobEntry {
  /** Workflow identifier. */
  workflowId: string;
  /** Position of the trigger in the workflow triggers array. */
  triggerIndex: number;
  /** Active croner instance. */
  job: Cron;
}

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build a deterministic key for a cron job entry.
 * @param workflowId - Owning workflow identifier
 * @param triggerIndex - Trigger position
 * @returns Composite job key
 */
function buildJobKey(workflowId: string, triggerIndex: number): string {
  return `${workflowId}:${triggerIndex}`;
}

/**
 * Resolve the cron timezone contract.
 * @param timezone - Optional workflow trigger timezone
 * @returns Explicit cron timezone
 */
export function resolveCronTimezone(timezone: string | undefined): string {
  return timezone ?? 'UTC';
}

// ─────────────────────────────────────────────────────────────
// Evaluator service
// ─────────────────────────────────────────────────────────────

/**
 * Schedules and fires cron triggers for workflows on `'main-dev-machine'` role machines.
 *
 * On `init`, loads all workflow definitions with `cron` triggers and schedules
 * them via croner. Subscribes to workflow CRUD events to keep the schedule
 * index live.
 *
 * Each cron trigger fires `WorkflowSubjects.start` with the workflow ID and
 * a `triggerPayload` containing the scheduled fire time.
 *
 * ## Role partitioning
 *
 * Only machines with role `'main-dev-machine'` should run this evaluator.
 * Server-role machines rely on the relay-side `CronEvaluator` for routing.
 * @example
 * ```typescript
 * if (machineRole === 'main-dev-machine') {
 *   const evaluator = new CronTriggerEvaluator(bus);
 *   await evaluator.init();
 *   // ...on shutdown:
 *   evaluator.destroy();
 * }
 * ```
 */
export class CronTriggerEvaluator {
  private readonly cleanupFns: Array<() => void> = [];
  private initialized = false;

  /**
   * Active cron jobs keyed by `{workflowId}:{triggerIndex}`.
   */
  private readonly jobs = new Map<string, CronJobEntry>();

  /**
   * @param bus - The shared bus instance
   */
  public constructor(private readonly bus: IMakaioBus) {}

  /**
   * Initialize the evaluator.
   *
   * Idempotent: calling `init()` on an already-initialized evaluator is a no-op.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Subscribe to workflow CRUD events to keep the job index fresh.
      this.cleanupFns.push(
        this.bus.on(WorkflowSubjects.definition.created, (ctx) => {
          this.scheduleWorkflow(ctx.payload);
        }),
        this.bus.on(WorkflowSubjects.definition.updated, (ctx) => {
          this.unscheduleWorkflow(ctx.payload.id);
          this.scheduleWorkflow(ctx.payload);
        }),
        this.bus.on(WorkflowSubjects.definition.deleted, (ctx) => {
          this.unscheduleWorkflow(ctx.payload.id);
        }),
      );

      // Schedule all existing workflows with cron triggers.
      await this.loadExistingTriggers();

      this.initialized = true;
    } catch (error) {
      this.cleanupFns.forEach((fn) => fn());
      this.cleanupFns.length = 0;
      this.stopAllJobs();
      throw error;
    }
  }

  /**
   * Destroy the evaluator, stopping all cron jobs and removing all subscriptions.
   *
   * Idempotent: calling `destroy()` on a non-initialized evaluator is a no-op.
   */
  public destroy(): void {
    if (!this.initialized) return;
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns.length = 0;
    this.stopAllJobs();
    this.initialized = false;
  }

  public activeJobCount(): number {
    return this.jobs.size;
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Load all existing workflow definitions and schedule their cron triggers.
   */
  private async loadExistingTriggers(): Promise<void> {
    const { workflows } = await this.bus.request(WorkflowStorageSubjects.list, {});
    for (const workflow of workflows) {
      this.scheduleWorkflow(workflow);
    }
  }

  /**
   * Schedule all `cron` triggers found in a workflow definition.
   * @param workflow - Workflow definition to schedule
   */
  private scheduleWorkflow(workflow: WorkflowDefinition): void {
    if (workflow.scope.type === 'global') return;
    const triggers = workflow.triggers ?? [];
    for (let i = 0; i < triggers.length; i++) {
      const trigger = triggers[i];
      if (trigger.type !== 'cron') continue;

      const key = buildJobKey(workflow.id, i);
      // Stop any existing job for this key before replacing.
      this.stopJob(key);
      try {
        const timezone = resolveCronTimezone(trigger.timezone);
        const job = new Cron(trigger.schedule, { timezone }, () => {
          this.fireTrigger(workflow.id, i);
        });

        this.jobs.set(key, { workflowId: workflow.id, triggerIndex: i, job });
      } catch (error) {
        console.warn(
          `[CronTriggerEvaluator] Skipping invalid cron trigger key="${key}" ` +
            `workflowId="${workflow.id}" triggerIndex=${i} schedule="${trigger.schedule}" ` +
            `timezone="${trigger.timezone ?? 'UTC'}"`,
          error,
        );
      }
    }
  }

  /**
   * Stop and remove all cron jobs for a given workflow.
   * @param workflowId - Workflow identifier to unschedule
   */
  private unscheduleWorkflow(workflowId: string): void {
    for (const [key, entry] of this.jobs) {
      if (entry.workflowId === workflowId) {
        entry.job.stop();
        this.jobs.delete(key);
      }
    }
  }

  /**
   * Stop and remove a single cron job by key.
   * @param key - Job key (`{workflowId}:{triggerIndex}`)
   */
  private stopJob(key: string): void {
    const existing = this.jobs.get(key);
    if (existing) {
      existing.job.stop();
      this.jobs.delete(key);
    }
  }

  /**
   * Stop all active cron jobs and clear the jobs map.
   */
  private stopAllJobs(): void {
    for (const entry of this.jobs.values()) {
      entry.job.stop();
    }
    this.jobs.clear();
  }

  /**
   * Fire a cron trigger by requesting workflow start.
   *
   * Errors are logged but not propagated — cron jobs are fire-and-forget.
   * @param workflowId - Workflow to start
   * @param triggerIndex - Index of the trigger that fired
   */
  private fireTrigger(workflowId: string, triggerIndex: number): void {
    this.bus
      .request(WorkflowSubjects.start, {
        workflowId,
        triggerPayload: { firedAt: Date.now(), triggerIndex },
      })
      .catch((error: unknown) => {
        console.error(
          `[CronTriggerEvaluator] Failed to start workflow "${workflowId}" ` +
            `for cron trigger index ${triggerIndex}:`,
          error,
        );
      });
  }
}
