/**
 * Consumer-side semantics of a persisted workflow trigger binding.
 *
 * A workflow consumes automation trigger events; it does not own the sources that
 * emit them. Everything a consumer applies *after* a trigger has validated and
 * emitted an event lives here, so every consumer — the engine's reconciler and
 * the worker's await mode alike — applies identical semantics.
 */

import type { JsonValue, WorkflowAutomationTriggerBinding } from '@makaio/contracts';
import type { JsonSchema } from '@makaio/contracts/shared';
import { assertValidCondition, type ConditionFinding, type ConditionOutcome, evaluate } from '@makaio/rules';

/**
 * Evaluator deciding whether one emitted trigger payload satisfies a workflow
 * binding's consumer-owned `when` condition.
 * @param payload - Payload of an automation trigger event.
 * @returns A matched outcome, or an error outcome carrying the findings when the
 *   condition could not be evaluated against this payload. Never throws.
 */
export type WorkflowTriggerConditionEvaluator = (payload: JsonValue) => ConditionOutcome;

/**
 * A compiled `when` condition and the warnings its registration-time check produced.
 */
export interface CompiledWorkflowTriggerCondition {
  /** Evaluator of the binding's `when` against an emitted payload. */
  readonly matches: WorkflowTriggerConditionEvaluator;
  /** Warning findings of the check; the caller reports them once, through its own logger. */
  readonly warnings: readonly ConditionFinding[];
}

/** Schema keywords whose values are instance data, not schemas; references inside them are data. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(['const', 'enum', 'default', 'examples']);

/** JSON pointer of the event schema inside the context wrapper. */
const PAYLOAD_POINTER = '#/properties/payload';

/**
 * Deep-copies a schema node, moving every local reference under {@link PAYLOAD_POINTER}.
 *
 * Only string-valued `$ref`s starting with `#` are rewritten, so a property that is
 * itself named `$ref` (its value is a schema object) is copied unchanged, and the
 * values of data keywords are copied verbatim.
 * @param node - Schema node or any nested JSON value.
 * @returns The rebased copy.
 */
function rebaseLocalRefs(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(rebaseLocalRefs);
  if (node === null || typeof node !== 'object') return node;
  const copy: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#')) {
      copy[key] = `${PAYLOAD_POINTER}${value.slice(1)}`;
    } else {
      copy[key] = DATA_KEYWORDS.has(key) || value === undefined ? value : rebaseLocalRefs(value);
    }
  }
  return copy;
}

/**
 * Checks and compiles the consumer-owned `when` condition of a workflow trigger binding.
 *
 * `when` is a consumer semantic: it narrows an event that an automation trigger
 * has already validated and emitted, so it is evaluated here rather than by the
 * trigger source. The evaluation context is `{ payload }`; the condition is
 * checked against a closed context schema that wraps the trigger's event schema
 * under a required `payload` key, so no consumer can skip the check. A binding
 * without `when` yields an evaluator that matches every payload.
 *
 * Evaluation failures are **not** thrown: they come back as an error outcome so
 * each caller can attribute the failure to its own consumer identity before
 * deciding to skip the event.
 * @param binding - Persisted workflow trigger binding.
 * @param eventSchema - Event schema of the trigger the binding resolved to.
 * @returns Evaluator applying the binding's `when` to an emitted payload, and the check's warnings.
 * @throws When the condition has an error finding against the event schema; the
 *   message lists every error and contains `does not fit the event schema`.
 */
export function compileWorkflowTriggerCondition(
  binding: WorkflowAutomationTriggerBinding,
  eventSchema: JsonSchema,
): CompiledWorkflowTriggerCondition {
  const { when } = binding;
  if (when === undefined) return { matches: () => ({ matched: true }), warnings: [] };
  // Invariant: the wrapper, not the event schema, is the reference root of the context.
  // Local references of the event schema (`#`, `#/$defs/…`, `#/definitions/…`) are rebased
  // onto its `payload` position so they keep resolving to the event schema.
  const warnings = assertValidCondition(
    {
      condition: when,
      context: {
        type: 'object',
        properties: { payload: rebaseLocalRefs(eventSchema) },
        required: ['payload'],
        additionalProperties: false,
      },
    },
    `Trigger condition 'when' of kind '${binding.kind}' does not fit the event schema`,
  );
  return { matches: (payload) => evaluate(when, { payload }), warnings };
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
