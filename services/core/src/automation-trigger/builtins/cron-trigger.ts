import type { AutomationTriggerType } from '@makaio/contracts';
import {
  CronAutomationTriggerParamsSchema,
  CRON_AUTOMATION_TRIGGER_KIND,
  defineAutomationTrigger,
  toAutomationTriggerType,
} from '@makaio/contracts';
import { z } from 'zod';
import type { AutomationCronScheduler } from '../cron-scheduler.js';
import { AutomationCronSchedulerToken } from '../cron-scheduler.js';

/** Payload emitted on every firing. */
const CronTriggerEventSchema = z.object({
  /** UNIX epoch milliseconds of the scheduled occurrence that fired. */
  scheduledFor: z.number().finite(),
});

/**
 * Creates the built-in `makaio.cron` automation trigger.
 *
 * The trigger owns no timers. It resolves the host-selected
 * {@link AutomationCronScheduler} and delegates, so the same binding semantics
 * hold whether a host schedules in-process or centrally.
 *
 * The binding key handed to the scheduler is the one the runtime supplies on the
 * activation context, so a provider attributing a job to a binding names exactly
 * what the runtime indexed it under.
 *
 * The scheduler is resolved through the supplied resolver at activation time
 * rather than captured at creation time, so a provider that restarts is picked
 * up by the next activation instead of leaving this trigger holding a dead
 * reference.
 * @param resolveScheduler - Resolves the currently registered provider.
 * @returns The registry-boundary trigger type for `makaio.cron`.
 */
export function createCronAutomationTrigger(
  resolveScheduler: () => AutomationCronScheduler | undefined,
): AutomationTriggerType {
  return toAutomationTriggerType(
    defineAutomationTrigger({
      kind: CRON_AUTOMATION_TRIGGER_KIND,
      label: 'Schedule',
      description: 'Fires on a cron schedule in a fixed timezone.',
      categories: ['Schedule'],
      paramsSchema: CronAutomationTriggerParamsSchema,
      eventSchema: CronTriggerEventSchema,
      activate: async (context, params) => {
        const scheduler = resolveScheduler();
        if (!scheduler) {
          throw new Error(
            `Automation trigger '${CRON_AUTOMATION_TRIGGER_KIND}' requires the '${AutomationCronSchedulerToken.name}' service; no cron scheduler provider is registered.`,
          );
        }

        return scheduler.schedule({
          bindingKey: context.bindingKey,
          schedule: params.schedule,
          timezone: params.timezone,
          emit: (payload) => context.emit(payload),
        });
      },
    }),
  );
}
