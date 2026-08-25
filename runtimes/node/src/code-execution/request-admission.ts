import {
  CODE_EXECUTION_IDENTIFIER_MAX_LENGTH,
  snapshotJsonBoundary,
  JsonValueSchema,
  type CodeExecutionFailedOutcome,
  type CodeExecutionProgram,
  type JsonFidelityViolationKind,
} from '@makaio/contracts';
import { failedOutcome, measureSerializedBytes } from './types.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// The request rules the Piscina CodeExecution provider applies before it waits
// for an admission slot.
//
// Every rule here is pure, cheap relative to what it guards, and decides the
// outcome on its own — which is why they run ahead of admission rather than
// after it. An inadmissible request parked behind a full gate would hold its
// oversized export name or its untransportable argument in memory for the whole
// wait and then be reported as `timed_out`, naming the queue for something the
// request itself was never going to survive.
//
// They cover the two request fields no other check inspects. The program's
// sources and paths are the materializer's business; these are what is left.
//
// All of them mirror rules the contract already states, and mirror them
// deliberately: the routing service parses every request against the contract,
// but a host holding the provider directly does not, and this provider must be
// safe to call either way. `invalid_program` throughout, because for such a
// caller the honest answer is still that the request was not submittable.

/**
 * Summaries for an argument the JSON contract cannot carry, by violation kind.
 *
 * Each names the shape rather than the value or the path where it was found:
 * both are caller-controlled and unbounded, and neither is needed to act on the
 * rejection.
 */
const ARGUMENT_FIDELITY_MESSAGES: Readonly<Record<JsonFidelityViolationKind, string>> = {
  'prototype-key': 'The invocation arguments carry a "__proto__" key, which cannot be transported as JSON.',
  'non-plain-object':
    'The invocation arguments are not JSON data: only plain objects and arrays are transportable, ' +
    'so values such as a Date, a Map, or a class instance must be converted before they are submitted.',
  'symbol-key': 'The invocation arguments carry a symbol-keyed property, which cannot be transported as JSON.',
  'non-enumerable-key': 'The invocation arguments carry a non-enumerable property that the record parse would drop.',
  'extra-array-key':
    'The invocation arguments carry an array with extra own properties that the array rebuild would drop.',
  'cyclic-reference': 'The invocation arguments contain a cyclic reference and cannot be transported as JSON.',
  'nesting-too-deep': 'The invocation arguments exceed the maximum JSON container nesting.',
  'negative-zero': 'The invocation arguments contain -0, which JSON would transport as 0.',
  'unreadable-value': 'The invocation arguments could not be read into a stable JSON boundary snapshot.',
};

/**
 * Summary for an argument carrying a leaf value JSON has no representation for.
 *
 * The fidelity walk decides object *shapes* and never inspects a leaf, so it
 * passes a function, `undefined`, a `bigint`, a symbol, and a non-finite number
 * alike. {@link JsonValueSchema} is what refuses those, and this names the class
 * rather than the offending value or its path, for the reason given on
 * {@link ARGUMENT_FIDELITY_MESSAGES}.
 */
const ARGUMENT_NOT_JSON_MESSAGE =
  'The invocation arguments carry a value with no JSON form — a function, undefined, a bigint, ' +
  'a symbol, or a non-finite number — which cannot be transported as JSON.';

/**
 * Reject an invocation whose export name exceeds the contract's own bound.
 *
 * The export name is the one request field the provider *copies*: it is retained
 * from admission until dispatch and then structured-cloned into the worker task,
 * once per invocation. Mirroring the contract's bound here is what keeps that
 * copy bounded for a direct caller too.
 *
 * The figure quoted is the contract's, not a provider option, so a host cannot
 * widen it.
 * @param exportName - Name of the export the invocation would invoke.
 * @returns The rejection outcome, or `undefined` when the name fits.
 */
function exportNameFailure(exportName: string): CodeExecutionFailedOutcome | undefined {
  if (exportName.length === 0) {
    return failedOutcome('invalid_program', 'The export name must not be empty.');
  }
  if (exportName.length <= CODE_EXECUTION_IDENTIFIER_MAX_LENGTH) return undefined;
  return failedOutcome(
    'invalid_program',
    `The export name is ${exportName.length} characters, ` +
      `which exceeds the limit of ${CODE_EXECUTION_IDENTIFIER_MAX_LENGTH}.`,
  );
}

/**
 * Reject an invocation whose arguments are not admissible JSON data.
 *
 * Three rules, in the order their answers depend on each other. Together they
 * are what the contract's `arguments` field already applies to a request that
 * arrived over the bus, restated for the direct caller that never parsed one:
 * the pool hands the argument to the worker by **structured clone**, which is
 * precisely the transport that carries a violation through unnoticed.
 *
 * A detached boundary snapshot is decided first. It rejects shapes JSON cannot
 * reproduce, detects cycles, and reads an admissible accessor once before the
 * schema sees the resulting tree.
 *
 * *Schema* is decided second, and covers leaf values the snapshot preserves: a
 * function, `undefined`, a
 * `bigint`, a symbol, or a non-finite number reaches it intact.
 * {@link JsonValueSchema} refuses each of those. Without it, a function value
 * serializes as `{}` — measuring under any budget — and then either fails the
 * structured clone as a `provider_failed` fault or, for the values clone does
 * carry, reaches the handler as something the contract says it cannot receive.
 * One parse per direct invocation is the whole cost, and a bus-path caller has
 * already paid it.
 *
 * *Size* is decided last, on the parsed value: only now is the measurement known
 * to be of a JSON value, which is what {@link measureSerializedBytes} requires.
 * The snapshot is what makes that figure the transported value's own.
 *
 * The serialization stays guarded even so. This function classifies rather than
 * throws, and every caller depends on that; a backstop is cheaper than a
 * precisely judged argument escaping as an unrelated provider fault.
 *
 * The argument is also the longest-lived part of a request: a queued invocation
 * holds it from admission until dispatch, which is the other reason the budget
 * is applied before the wait rather than after it.
 * @param value - Argument the invocation would hand to the worker.
 * @param maxArgumentBytes - Configured serialized-size budget for the argument.
 * @returns The rejection outcome, or `undefined` when the argument is admissible.
 */
function argumentFailure(value: unknown, maxArgumentBytes: number): CodeExecutionFailedOutcome | undefined {
  const snapshot = snapshotJsonBoundary(value);
  if (!snapshot.ok) return failedOutcome('invalid_program', ARGUMENT_FIDELITY_MESSAGES[snapshot.violation.kind]);

  const parsed = JsonValueSchema.safeParse(snapshot.value);
  if (!parsed.success) return failedOutcome('invalid_program', ARGUMENT_NOT_JSON_MESSAGE);

  let bytes: number;
  try {
    bytes = measureSerializedBytes(parsed.data);
  } catch {
    return failedOutcome('invalid_program', 'The invocation arguments have no JSON representation.');
  }
  if (bytes <= maxArgumentBytes) return undefined;
  return failedOutcome(
    'invalid_program',
    `The invocation arguments serialize to ${bytes} bytes, which exceeds the limit of ${maxArgumentBytes}.`,
  );
}

/**
 * Apply every pre-admission request rule, in order, and report the first failure.
 *
 * Total: it classifies the request rather than throwing, so the caller can
 * return the outcome without a second failure path.
 * @param request - Prepared invocation about to wait for an admission slot.
 * @param maxArgumentBytes - Configured serialized-size budget for the argument.
 * @returns The rejection outcome, or `undefined` when the request is admissible.
 */
export function requestAdmissionFailure(
  request: { readonly program: CodeExecutionProgram; readonly arguments: unknown },
  maxArgumentBytes: number,
): CodeExecutionFailedOutcome | undefined {
  return exportNameFailure(request.program.exportName) ?? argumentFailure(request.arguments, maxArgumentBytes);
}
