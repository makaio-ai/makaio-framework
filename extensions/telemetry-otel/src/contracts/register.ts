/**
 * Public helper for registering span enricher rules on the bus.
 *
 * Returns a cleanup function that unregisters the rule when called, suitable
 * for use in extension lifecycle hooks or service shutdown sequences.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/contracts';
import { TelemetryOtelSubjects } from './namespace.js';
import type { SpanEnricherRule } from './types.js';

/**
 * Emit a `registerEnricherRule` event on the bus and return an async
 * unregister callback.
 * @param call - Call context for the registration.
 * @param bus - The application bus instance.
 * @param rule - Fully-formed enricher rule to register.
 * @returns Async cleanup function that accepts its own call context and emits
 *   `unregisterEnricherRule` for the registered rule id.
 */
export async function registerSpanEnricherRule(
  call: CallContext,
  bus: IMakaioBus,
  rule: SpanEnricherRule,
): Promise<(call: CallContext) => Promise<void>> {
  await bus.emit(call, TelemetryOtelSubjects.registerEnricherRule, rule);
  return async (call) => {
    await bus.emit(call, TelemetryOtelSubjects.unregisterEnricherRule, { ruleId: rule.id });
  };
}
