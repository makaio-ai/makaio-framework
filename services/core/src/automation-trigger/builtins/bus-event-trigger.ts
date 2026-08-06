import type { IMakaioBus } from '@makaio/bus-core';
import { matchesSubscription } from '@makaio/bus-core';
import { createNamespaceWildcardSubject, splitSubjectKey } from '@makaio/core';
import type { AutomationTriggerType } from '@makaio/contracts';
import {
  BUS_EVENT_AUTOMATION_TRIGGER_KIND,
  JsonRecordSchema,
  defineAutomationTrigger,
  toAutomationTriggerType,
} from '@makaio/contracts';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Log prefix for built-in bus-event trigger diagnostics. */
const LOG_PREFIX = '[BusEventAutomationTrigger]';

/**
 * Full bus subject key: a non-empty namespace, a dot, then a non-empty subject.
 *
 * Kept as a regular-expression constraint so Zod projects the invariant into
 * the detached JSON Schema consumed by descriptor-driven authoring surfaces.
 * The subject segment may itself contain dots, matching {@link splitSubjectKey}.
 */
const OBSERVABLE_BUS_EVENT_SUBJECT_PATTERN = /^[^.]+\.[\s\S]+$/;

/** Activation parameters: the bus subject pattern this binding observes. */
const BusEventTriggerParamsSchema = z.object({
  /**
   * Full bus subject key or namespace-level wildcard, e.g. `git.checkout`,
   * `git.*`, or `storage:workflow.list`.
   */
  subject: z
    .string()
    .regex(
      OBSERVABLE_BUS_EVENT_SUBJECT_PATTERN,
      "Bus-event subject must be '<namespace>.<subject>' with both segments non-empty.",
    ),
});

// ---------------------------------------------------------------------------
// Trigger factory
// ---------------------------------------------------------------------------

/**
 * Creates the built-in `makaio.bus-event` automation trigger.
 *
 * One activation observes exactly one subject pattern and forwards every
 * matching **event** as a trigger event. Three properties define it:
 *
 * 1. **Events only.** The namespace wildcard is registered as an event handler
 *    only, so the activation is never advertised as a request route for the whole
 *    namespace, and a request that matches the pattern is skipped even if it ever
 *    reaches the handler: a trigger must never observe, delay, or answer an RPC.
 * 2. **Object-root JSON payloads.** A scalar, array, or non-JSON payload is
 *    skipped and logged instead of thrown: the handler runs inside the emitter's
 *    dispatch, so throwing would surface a trigger's validation problem as a
 *    failure of the unrelated code that emitted the event.
 * 3. **No consumer semantics.** No workflow identity and no consumer-owned
 *    filtering live here. Filtering an already-emitted event is the
 *    subscriber's concern; this trigger only decides what an activation
 *    observes.
 *
 * The bus is captured here, at trigger-creation time, from the contributing
 * extension's context — not from the activation context — so every activation
 * of this trigger observes the same bus the extension was activated with.
 * @param bus - Bus instance owned by the contributing extension.
 * @returns The registry-boundary trigger type for `makaio.bus-event`.
 */
export function createBusEventAutomationTrigger(bus: IMakaioBus): AutomationTriggerType {
  return toAutomationTriggerType(
    defineAutomationTrigger({
      kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND,
      label: 'Bus Event',
      description: 'Fires when a matching event is emitted on the Makaio bus.',
      categories: ['Bus'],
      paramsSchema: BusEventTriggerParamsSchema,
      eventSchema: JsonRecordSchema,
      activate: async (context, params) => {
        const segments = splitSubjectKey(params.subject);
        if (segments === undefined) {
          throw new Error(`Bus-event parameter schema admitted an unobservable subject: '${params.subject}'`);
        }

        // Subscribed as an *event* handler explicitly: a wildcard subscription
        // that leaves the handler kind open registers in the request map too and
        // advertises a request route for the whole namespace to remote
        // transports, which would make a trigger source look like an RPC handler.
        const unsubscribe = bus.on(
          createNamespaceWildcardSubject(segments.namespace),
          (eventContext) => {
            if (eventContext.isRequest) return;
            if (!matchesSubscription(eventContext.subject, params.subject)) return;

            const payload = JsonRecordSchema.safeParse(eventContext.payload);
            if (!payload.success) {
              console.warn(
                `${LOG_PREFIX} skipped non-object JSON payload on '${eventContext.subject}':`,
                payload.error,
              );
              return;
            }

            const { correlationId } = eventContext;
            void context
              .emit(payload.data, correlationId === undefined ? undefined : { correlationId })
              .catch((error: unknown) => {
                console.error(`${LOG_PREFIX} emit failed for '${eventContext.subject}':`, error);
              });
          },
          { handlerKind: 'event' },
        );

        return unsubscribe;
      },
    }),
  );
}

/**
 * Every built-in automation trigger that needs nothing but a bus.
 *
 * The composition seam for hosts that assemble their own trigger batch: a worker
 * or a headless host that must observe bus events, but composes no cron scheduler,
 * gets the bus-backed set from here instead of listing individual factories and
 * silently falling behind when another bus-backed built-in is added. The
 * framework's own built-ins package composes this list plus the triggers that need
 * more than a bus.
 * @param bus - Bus instance the activations observe.
 * @returns The bus-backed built-in trigger types.
 */
export function busBackedAutomationTriggers(bus: IMakaioBus): readonly AutomationTriggerType[] {
  return [createBusEventAutomationTrigger(bus)];
}
