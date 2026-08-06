import { Cron } from 'croner';
import type { IMakaioBus } from '@makaio/bus-core';
import type { AutomationTriggerCleanup, MakaioNodeExtension } from '@makaio/contracts';
import type { AutomationCronScheduleInput, AutomationCronScheduler } from './cron-scheduler.js';
import { assertValidCronSchedule, AutomationCronSchedulerToken } from './cron-scheduler.js';

/** Log prefix for local cron scheduler diagnostics. */
const LOG_PREFIX = '[LocalAutomationCronScheduler]';

/**
 * One live croner job owned by the scheduler.
 *
 * The binding key is carried for diagnostics only — see
 * {@link AutomationCronScheduleInput.bindingKey} for why it is not an index.
 */
interface ScheduledJob {
  /** Canonical binding key that requested this job. */
  readonly bindingKey: string;
  /** The croner instance driving the schedule. */
  readonly job: Cron;
}

/**
 * In-process {@link AutomationCronScheduler} backed by croner.
 *
 * The default provider for hosts that schedule locally. It owns nothing but its
 * jobs: no workflow lookup, no persistence, no machine-role decision. A host
 * that must not schedule locally simply registers a different provider under
 * {@link AutomationCronSchedulerToken}.
 *
 * Jobs are held in a set of entries rather than a map keyed by binding key,
 * because two activations of the same key can legitimately overlap while one is
 * retiring. Each cleanup cancels exactly the job it created, so an overlapping
 * pair can never cancel each other's job or leak one past {@link shutdown}.
 */
export class LocalAutomationCronScheduler implements AutomationCronScheduler {
  /** Live jobs; entry identity is what a cleanup cancels. */
  private readonly jobs = new Set<ScheduledJob>();

  /**
   * Registers one cron schedule.
   *
   * The schedule is validated, then the croner instance is constructed, before
   * the entry is tracked — so an invalid expression or timezone rejects without
   * leaving a job behind. A failing `emit` is logged rather than propagated: it
   * runs inside croner's timer callback, where an escaping rejection would become
   * an unhandled one and could stop the job from firing again.
   * @param input - Schedule expression, timezone, owner key, and firing sink.
   * @returns Cleanup that cancels exactly this schedule; idempotent.
   * @throws When croner rejects the expression or the timezone.
   */
  public async schedule(input: AutomationCronScheduleInput): Promise<AutomationTriggerCleanup> {
    assertValidCronSchedule(input);

    const job = this.createJob(input);
    const entry: ScheduledJob = { bindingKey: input.bindingKey, job };
    this.jobs.add(entry);

    return () => {
      // `delete` reports whether this call is the one that retires the entry,
      // which is what makes repeated cleanup a no-op.
      if (!this.jobs.delete(entry)) return;
      entry.job.stop();
    };
  }

  /**
   * Cancels every live schedule.
   *
   * Idempotent, and the only teardown path a host needs: the scheduler holds no
   * other resources.
   */
  public async shutdown(): Promise<void> {
    for (const entry of this.jobs) {
      entry.job.stop();
    }
    this.jobs.clear();
  }

  /**
   * Cancels every live schedule on service teardown.
   *
   * Delegates to {@link shutdown}; exists so the scheduler satisfies the
   * `ExtensionServiceLifecycle` contract and the coordinator can call
   * `service.destroy?.()` on package teardown.
   * @returns Resolves once every job has been cancelled.
   */
  public destroy(): Promise<void> {
    return this.shutdown();
  }

  /**
   * Number of live schedules.
   * @returns Count of jobs currently registered.
   */
  public activeScheduleCount(): number {
    return this.jobs.size;
  }

  /**
   * Builds the croner job for one schedule request.
   *
   * `scheduledFor` is the **scheduled occurrence**, not the moment the callback
   * ran. Croner's `currentRun()` is the wall clock captured when it entered the
   * callback, so a busy event loop would report a drifted minute and every
   * consumer of the payload would inherit that drift. The occurrence is therefore
   * tracked here: seeded from the job's next run before it can fire, and rolled
   * forward inside the callback, where `nextRun()` already reports the occurrence
   * after the one being served.
   *
   * Infallible by precondition: the caller already ran
   * {@link assertValidCronSchedule} against the same expression and timezone, so
   * the construction below cannot reject them.
   * @param input - The schedule request being registered.
   * @returns A started croner instance.
   */
  private createJob(input: AutomationCronScheduleInput): Cron {
    /** Occurrence the next firing serves; `null` once no occurrence remains. */
    let occurrence: Date | null = null;

    const job = new Cron(input.schedule, { timezone: input.timezone }, (self) => {
      const scheduledFor = occurrence?.getTime() ?? self.currentRun()?.getTime() ?? Date.now();
      occurrence = self.nextRun();
      input.emit({ scheduledFor }).catch((error: unknown) => {
        console.error(`${LOG_PREFIX} emit failed for '${input.bindingKey}':`, error);
      });
    });
    // Assigned synchronously, before the event loop can run the callback: a
    // timer cannot fire while this method is still on the stack.
    occurrence = job.nextRun();
    return job;
  }
}

/**
 * Package registering the in-process cron scheduler provider.
 *
 * The default choice for framework-only boots. A host replaces it by supplying
 * its own provider package for {@link AutomationCronSchedulerToken}; exactly one
 * provider may be registered in a booted runtime.
 */
export const localAutomationCronSchedulerPackage: MakaioNodeExtension<IMakaioBus> = {
  name: AutomationCronSchedulerToken.name,
  displayName: 'Local Automation Cron Scheduler',
  version: '0.1.0',
  critical: true,
  create: () => new LocalAutomationCronScheduler(),
};
