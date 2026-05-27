import type { IMakaioBus } from '@makaio/bus-core';
import type { EventMessagePayload, SubjectDefinition } from '@makaio/core';
import type { BusEventTrigger, WorkflowWorkerConfig } from '@makaio/contracts';
import type { RuntimeLoadedWorkflow } from './types.js';

type AdHocEventPayload = EventMessagePayload;
type AdHocEventSubject = SubjectDefinition<Record<string, AdHocEventPayload>, string, string>;

/**
 * Build an ad-hoc event subject definition from a fully qualified subject string.
 *
 * Same pattern as the workflow cancel subject helper: construct a subject
 * definition without requiring the namespace schema to be registered locally.
 * @param fullSubject - Fully qualified subject in `namespace.subject` form.
 * @returns Ad-hoc subject definition suitable for bus subscriptions.
 */
function createAdHocEventSubject(fullSubject: string): AdHocEventSubject {
  const separator = fullSubject.indexOf('.');
  if (separator <= 0 || separator === fullSubject.length - 1) {
    throw new Error(`Invalid trigger subject: ${fullSubject}`);
  }

  return {
    subject: fullSubject.slice(separator + 1),
    $meta: {
      namespace: fullSubject.slice(0, separator),
      isRequest: false,
      payload: {} as AdHocEventPayload,
      local: false,
      channel: false,
    },
  };
}

/**
 * Subscribe to declared bus-event triggers and wait for the first matching event.
 *
 * Returns the event payload of the first trigger that fires. All subscriptions
 * are cleaned up before returning. Rejects if the abort signal fires first.
 * @param bus - Bus used for trigger subscriptions.
 * @param triggers - Bus-event trigger definitions from the loaded workflow.
 * @param signal - Abort signal for cooperative cancellation.
 * @returns Matched event payload to use as `triggerPayload` for the orchestrator.
 */
function awaitBusEventTrigger(
  bus: IMakaioBus,
  triggers: readonly BusEventTrigger[],
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Await-trigger aborted'));
      return;
    }

    const cleanups: Array<() => void> = [];

    /** Unsubscribe all active trigger subscriptions and clear the array. */
    function cleanup(): void {
      for (const fn of cleanups) fn();
      cleanups.length = 0;
    }

    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error('Await-trigger aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));

    try {
      for (const trigger of triggers) {
        const subject = createAdHocEventSubject(trigger.subject);
        const unsubscribe = bus.on(
          subject,
          (ctx) => {
            cleanup();
            resolve(ctx.payload as Record<string, unknown>);
          },
          trigger.filter ? { filter: trigger.filter } : undefined,
        );
        cleanups.push(unsubscribe);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Apply workflow await-trigger semantics to a worker config.
 *
 * When the config has an empty `triggerPayload` and the loaded workflow declares
 * bus-event triggers, wait for the first matching event and return a config
 * with that event payload. Otherwise return the original config unchanged.
 * @param config - Validated workflow worker configuration.
 * @param loaded - Loaded workflow definition and runtime step map.
 * @param bus - Bus used for trigger subscriptions.
 * @param signal - Abort signal for cooperative cancellation.
 * @returns Original config or a copy with the matched trigger payload.
 */
export async function resolveAwaitTriggerConfig(
  config: WorkflowWorkerConfig,
  loaded: RuntimeLoadedWorkflow,
  bus: IMakaioBus,
  signal: AbortSignal,
): Promise<WorkflowWorkerConfig> {
  const busEventTriggers = (loaded.definition.triggers ?? []).filter(
    (trigger): trigger is BusEventTrigger => trigger.type === 'bus-event',
  );
  const hasEmptyTriggerPayload = Object.keys(config.triggerPayload).length === 0;

  if (!hasEmptyTriggerPayload || busEventTriggers.length === 0) {
    return config;
  }

  const matchedPayload = await awaitBusEventTrigger(bus, busEventTriggers, signal);
  return { ...config, triggerPayload: matchedPayload };
}
