import { Cron } from 'croner';
import type { AutomationTriggerCleanup } from '@makaio/contracts';
import { extensionToken } from '@makaio/contracts';

/**
 * One schedule request placed by an active cron automation trigger binding.
 *
 * Carries no workflow identity and no machine role: who reacts to a firing, and
 * whether this host is allowed to schedule at all, are decided above this port.
 * A provider only needs to know when to fire and how to report a firing.
 */
export interface AutomationCronScheduleInput {
  /**
   * Canonical binding key of the requesting activation.
   *
   * Diagnostic identity, supplied by the trigger so a provider can attribute a
   * schedule to the binding that owns it. Providers must not treat it as a
   * unique index: the binding runtime may briefly hold a retiring and a fresh
   * activation of the same key at the same time.
   */
  readonly bindingKey: string;
  /** Cron expression, e.g. `0 9 * * 1`. */
  readonly schedule: string;
  /** IANA timezone the expression is evaluated in. */
  readonly timezone: string;
  /**
   * Reports one firing to the requesting activation.
   * @param payload - The scheduled occurrence that fired.
   * @returns Resolves once the firing has been dispatched.
   */
  readonly emit: (payload: { readonly scheduledFor: number }) => Promise<void>;
}

/**
 * Host-selected provider that turns cron schedules into firings.
 *
 * The framework ships a local, in-process provider; a host that must schedule
 * centrally (for example through a relay) registers its own provider under
 * {@link AutomationCronSchedulerToken} instead. Exactly one provider is active
 * in a booted runtime.
 */
export interface AutomationCronScheduler {
  /**
   * Registers one cron schedule.
   * @param input - Schedule expression, timezone, owner key, and firing sink.
   * @returns Cleanup that cancels this schedule; idempotent.
   * @throws When the schedule expression or timezone is not valid.
   */
  readonly schedule: (input: AutomationCronScheduleInput) => Promise<AutomationTriggerCleanup>;
}

/** Token for the host-selected automation cron scheduler provider. */
export const AutomationCronSchedulerToken = extensionToken<AutomationCronScheduler>('automation-cron-scheduler');

/**
 * Rejects a schedule request whose expression or timezone cannot be evaluated.
 *
 * Lives beside the port rather than inside one provider because every provider
 * owes callers the same rejection: a provider that accepts an unparseable
 * expression — because it forwards scheduling elsewhere and only finds out later —
 * would report a healthy binding that silently never fires, and the binding's
 * author would learn about it from nothing. Validating against the same cron
 * implementation the local provider runs is what makes "accepted here" mean
 * "schedulable there".
 *
 * Constructs and immediately discards a paused job: croner performs its parse in
 * the constructor, and a paused instance starts no timer, so nothing is scheduled.
 *
 * `nextRun()` is called for its validation rather than its value. Croner accepts
 * an unknown timezone at construction and only rejects it when an occurrence is
 * actually resolved, so without this call an unresolvable timezone would pass
 * validation and instead surface later — as a raw croner error from whichever
 * provider first tried to use it, naming neither the timezone nor the binding.
 * @param input - Schedule request whose expression and timezone are checked.
 * @throws When croner rejects the expression or the timezone, with the offending
 *   values and the requesting binding named.
 */
export function assertValidCronSchedule(input: AutomationCronScheduleInput): void {
  try {
    new Cron(input.schedule, { timezone: input.timezone, paused: true }).nextRun();
  } catch (error) {
    throw new Error(
      `Invalid cron schedule '${input.schedule}' in timezone '${input.timezone}' for binding '${input.bindingKey}'`,
      { cause: error },
    );
  }
}
