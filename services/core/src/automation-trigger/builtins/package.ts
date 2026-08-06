import type { IMakaioBus } from '@makaio/bus-core';
import { dep, type MakaioNodeExtension } from '@makaio/contracts';
import { AutomationCronSchedulerToken } from '../cron-scheduler.js';
import { busBackedAutomationTriggers } from './bus-event-trigger.js';
import { createCronAutomationTrigger } from './cron-trigger.js';

/**
 * Owner name of the framework's built-in automation triggers.
 *
 * Deliberately the bare `makaio` namespace: the registry requires every trigger
 * kind to be prefixed with its owner, and the built-in kinds are canonically
 * `makaio.bus-event` and `makaio.cron`. Registering them under the same `makaio`
 * owner keeps the owner/kind invariant in force for built-ins instead of
 * carving out an exception for them.
 */
export const AUTOMATION_TRIGGER_BUILTINS_OWNER = 'makaio';

/**
 * Package contributing the framework's built-in automation triggers.
 *
 * Contributes through the ordinary `automationTriggers` surface, so built-ins
 * take exactly the same registration, replay, and teardown path as any
 * extension-contributed trigger. Each trigger captures what it needs from the
 * contribution context at creation time — the bus for `makaio.bus-event`, a lazy
 * scheduler resolver for `makaio.cron` — so the activation context stays free of
 * host wiring.
 *
 * The dependency on the cron scheduler provider is declared **optional**, which
 * buys start ordering without a disable refusal: a provider present in the
 * composition is started before these built-ins, so the first reconciliation that
 * activates a stored `makaio.cron` binding already finds it — a host that lists
 * its provider after this package would otherwise leave those bindings
 * unavailable with no further signal to retry on. When no provider is composed at
 * all the built-ins still register, and a `makaio.cron` activation then fails with
 * a message naming the missing service, which keeps `makaio.bus-event` available
 * to a host whose scheduler is degraded.
 */
export const automationTriggerBuiltinsPackage: MakaioNodeExtension<IMakaioBus> = {
  name: AUTOMATION_TRIGGER_BUILTINS_OWNER,
  displayName: 'Makaio Built-in Automation Triggers',
  version: '0.1.0',
  dependencies: [dep(AutomationCronSchedulerToken.name, undefined, true)],
  critical: true,
  automationTriggers: {
    createAutomationTriggers: (ctx) => [
      ...busBackedAutomationTriggers(ctx.bus),
      createCronAutomationTrigger(() => ctx.getService(AutomationCronSchedulerToken)),
    ],
  },
};
