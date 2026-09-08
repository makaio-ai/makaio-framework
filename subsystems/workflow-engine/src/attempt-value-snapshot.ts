/**
 * Immutable value ownership shared by Authority inputs and repository realizations.
 * Each public boundary snapshots independently; private insertion reuses that snapshot.
 * @packageDocumentation
 */
import type { ExecutionAttemptInstruction } from '@makaio/contracts';
import { ExecutionAttemptInstructionSchema } from '@makaio/contracts';

/**
 * Narrow an arbitrary value to something whose members can be walked.
 *
 * Deliberately wider than the shared `isRecord` in `@makaio/utils`, which
 * excludes arrays: {@link freezeDeep} has to descend into an array as readily
 * as into an object, because an unfrozen array inside a durable value is just
 * as reachable from a caller that kept a handle on it.
 * @param value - Value to probe.
 * @returns Whether the value has own enumerable members.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Freeze a snapshot and everything reachable from it.
 *
 * Applied to the repository's own copy of an inbound value, never to the
 * caller's object. It is what makes "the repository owns its durable values"
 * true at runtime rather than only in the `readonly` types, so a realization
 * that hands a stored value back cannot have it mutated underneath.
 * @param value - Repository-owned snapshot to freeze in place.
 */
function freezeDeep(value: unknown): void {
  if (!isRecord(value) || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const member of Object.values(value)) {
    freezeDeep(member);
  }
}

/**
 * Take an immutable, schema-valid snapshot of an inbound durable value.
 *
 * Parsing rejects a value the contract does not allow *before* the first
 * mutation, rather than when some later read happens to validate it.
 *
 * The clone in front of it is what makes {@link freezeDeep} safe to apply to
 * the result without reaching the caller's own object. Today's contract
 * schemas happen to rebuild every node they accept, so the clone is redundant
 * for them; it stops being redundant the moment any schema on this path gains
 * a `z.unknown()`, a `z.custom()`, or a `.passthrough()`, because the parse
 * output would then carry references straight back into the caller's value and
 * we would freeze an object we do not own. The clone is kept so that change
 * stays a contract change rather than a silent one here.
 * @param value - Caller-supplied value about to become durable.
 * @param parse - Public contract schema that owns the value's shape.
 * @returns A frozen, repository-owned copy of the value.
 * @throws When the value violates its contract schema.
 * @typeParam TValue - Value type the column stores.
 */
export function snapshot<TValue>(value: unknown, parse: (candidate: unknown) => TValue): TValue {
  const parsed = parse(structuredClone(value));
  freezeDeep(parsed);
  return parsed;
}

/**
 * Own an immutable assignment before an attempt becomes dispatchable.
 * @param instruction - Owner-supplied portable assignment.
 * @returns A validated, recursively frozen copy.
 */
export function parseInstruction(instruction: ExecutionAttemptInstruction): ExecutionAttemptInstruction {
  return snapshot(instruction, (candidate) => ExecutionAttemptInstructionSchema.parse(candidate));
}
