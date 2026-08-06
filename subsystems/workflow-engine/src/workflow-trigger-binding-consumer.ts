/**
 * Consumer-side semantics of a persisted workflow trigger binding.
 *
 * A workflow consumes automation trigger events; it does not own the sources that
 * emit them. Everything a consumer applies *after* a trigger has validated and
 * emitted an event lives here, so every consumer — the engine's reconciler and
 * the worker's await mode alike — applies identical semantics.
 */

import { matchesFilter } from '@makaio/bus-core';
import type { JsonValue, WorkflowAutomationTriggerBinding } from '@makaio/contracts';
import { compile } from '@makaio/expression';

/**
 * Predicate deciding whether one emitted trigger payload passes a workflow
 * binding's consumer-owned filters.
 * @param payload - Payload of an automation trigger event.
 * @returns `true` when the payload passes every declared filter.
 * @throws When the compiled `filterExpression` fails at evaluation time.
 */
export type WorkflowTriggerPayloadPredicate = (payload: JsonValue) => boolean;

/**
 * Compiles the consumer-owned filters of a workflow trigger binding.
 *
 * `filter` and `filterExpression` are consumer semantics: they narrow an event
 * that an automation trigger has already validated and emitted, so they are
 * evaluated here rather than by the trigger source. Both are ANDed, structural
 * filter first, and a binding that declares neither yields a predicate that
 * accepts every payload.
 *
 * The expression is compiled eagerly so an unparseable expression fails at
 * reconciliation time — where a caller can keep its last-good subscriptions —
 * instead of silently behaving like "no expression" on every event.
 *
 * Evaluation failures are **not** swallowed: the predicate throws so each caller
 * can attribute the failure to its own consumer identity before deciding to skip
 * the event.
 * @param binding - Persisted workflow trigger binding.
 * @returns Predicate applying the binding's filters to an emitted payload.
 * @throws When `filterExpression` cannot be compiled.
 */
export function compileWorkflowTriggerBindingFilter(
  binding: WorkflowAutomationTriggerBinding,
): WorkflowTriggerPayloadPredicate {
  const { filter, filterExpression } = binding;
  const expression = filterExpression === undefined ? undefined : compile(filterExpression);

  if (filter === undefined && expression === undefined) return () => true;

  return (payload) => {
    if (filter !== undefined && !matchesFilter(payload, filter)) return false;
    if (expression === undefined) return true;
    return Boolean(expression.evalSync({ payload }));
  };
}

/**
 * Asserts that a generic automation event carries the object root required by a
 * workflow start.
 *
 * Workflow consumers admit only descriptors whose output JSON Schema declares
 * an object root. This assertion protects the final delivery seam from contract
 * drift without inventing data for a scalar source.
 * @param payload - Validated automation trigger event payload.
 * @returns The same object payload.
 * @throws When a workflow-incompatible payload reaches the consumer.
 */
export function assertWorkflowTriggerPayload(payload: JsonValue): Record<string, JsonValue> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Workflow trigger payload must have an object root');
  }
  // Single narrowing cast: the `object` branch of JsonValue carries no index
  // signature, but the JSON contract guarantees every own property of a
  // schema-validated payload is itself a JsonValue once null and arrays are out.
  return payload as Record<string, JsonValue>;
}
