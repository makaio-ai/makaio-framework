/**
 * Public helper for registering span enricher rules on the bus.
 *
 * Returns a cleanup function that unregisters the rule when called, suitable
 * for use in extension lifecycle hooks or service shutdown sequences.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { TelemetryOtelSubjects } from './namespace.js';
import type { SpanEnricherRule } from './types.js';

/**
 * Emit a `registerEnricherRule` event on the bus and return an async
 * unregister callback.
 * @param bus - The application bus instance.
 * @param rule - Fully-formed enricher rule to register.
 * @returns Async cleanup function that emits `unregisterEnricherRule` for the
 *   registered rule id.
 */
export async function registerSpanEnricherRule(bus: IMakaioBus, rule: SpanEnricherRule): Promise<() => Promise<void>> {
  await bus.emit(TelemetryOtelSubjects.registerEnricherRule, rule);
  return async () => {
    await bus.emit(TelemetryOtelSubjects.unregisterEnricherRule, { ruleId: rule.id });
  };
}
