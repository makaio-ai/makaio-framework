/**
 * Value handling shared by every realization of the execution attempt port.
 *
 * The port states four rules about values crossing it: timestamps are
 * instants rather than strings, durable values are validated on the way in
 * rather than on the way back out, a recovery listing never silently omits a
 * row it cannot narrow, and it reports what it does list oldest first. Each is
 * written once here so an in-memory realization and a durable one can never
 * disagree about it — the ordering rule as a comparator, which a realization
 * with a query engine expresses as an `ORDER BY` over the same fields instead.
 *
 * Three rules do not live here, because they are the port's own decisions
 * rather than shared value handling: `sameAllocationRef` (what counts as the
 * same reference), `sameDurableOutcome` (what counts as the same committed
 * outcome), and `durableOutcome` (what an outcome is durably rendered as).
 * The port module states those itself, and every realization imports them
 * from there.
 * @packageDocumentation
 */
import { z } from 'zod';
import type {
  ExecutionAttemptInstruction,
  ExecutionAttemptPreparationResult,
  ProviderAllocationRef,
  WorkerAllocationLifetime,
} from '@makaio/contracts';
import {
  ExecutionAttemptInstructionSchema,
  ExecutionAttemptPreparationResultSchema,
  ProviderAllocationRefSchema,
  WorkerAllocationLifetimeSchema,
} from '@makaio/contracts';
import type {
  AllocationRefEvolution,
  AttemptControlState,
  ExecutionAttemptRecord,
  RecoverableAttemptRecord,
  PreparationReceipt,
} from '../execution-attempt-repository.js';

/**
 * Parse an ISO-8601 timestamp into the epoch instant it denotes.
 *
 * The port orders timestamps as instants, so every comparison goes through
 * here rather than comparing the strings a caller happened to supply.
 * @param timestamp - ISO-8601 timestamp supplied by a caller or read back from storage.
 * @returns Milliseconds since the epoch.
 * @throws When the value is not a parsable ISO-8601 timestamp.
 */
export function instantOf(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an ISO-8601 timestamp, received '${timestamp}'`);
  }
  return parsed;
}

/**
 * Normalize a caller-supplied timestamp to the port's canonical stored form.
 *
 * Storing the canonical UTC millisecond form is what makes an offset-bearing
 * or second-precision input order identically in memory and in a store with
 * native temporal types.
 * @param timestamp - ISO-8601 timestamp supplied by a caller.
 * @returns The same instant as canonical UTC ISO-8601 with millisecond precision.
 * @throws When the value is not a parsable ISO-8601 timestamp.
 */
export function normalizeInstant(timestamp: string): string {
  return new Date(instantOf(timestamp)).toISOString();
}

/**
 * Freeze creation time and bootstrap deadline from one clock observation.
 * @param bootstrapTimeoutMs - Explicit host-selected positive safe-integer budget.
 * @returns Canonical creation and deadline timestamps, validated before any write.
 * @throws When the budget or resulting deadline is not representable.
 */
export function createAttemptTiming(bootstrapTimeoutMs: number): {
  readonly createdAt: string;
  readonly bootstrapDeadlineAt: string;
} {
  if (!Number.isSafeInteger(bootstrapTimeoutMs) || bootstrapTimeoutMs <= 0) {
    throw new RangeError('bootstrapTimeoutMs must be a positive safe integer');
  }
  const createdAtMs = Date.now();
  const deadlineMs = createdAtMs + bootstrapTimeoutMs;
  if (!Number.isSafeInteger(deadlineMs) || !Number.isFinite(new Date(deadlineMs).getTime())) {
    throw new RangeError('bootstrapTimeoutMs produces an unrepresentable bootstrap deadline');
  }
  return {
    createdAt: new Date(createdAtMs).toISOString(),
    bootstrapDeadlineAt: new Date(deadlineMs).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Ingress parsing
// ─────────────────────────────────────────────────────────────

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
function snapshot<TValue>(value: unknown, parse: (candidate: unknown) => TValue): TValue {
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

/**
 * Own the semantic result before evaluating or storing a Preparation report.
 * @param result - Runtime-supplied successful Preparation result.
 * @returns A validated, recursively frozen copy.
 */
export function parsePreparationResult(result: ExecutionAttemptPreparationResult): ExecutionAttemptPreparationResult {
  return snapshot(result, (candidate) => ExecutionAttemptPreparationResultSchema.parse(candidate));
}

const preparationReceiptsSchema = z.array(
  z
    .object({
      operationId: z.string().min(1),
      runtimeGeneration: z.number().int().positive(),
      result: ExecutionAttemptPreparationResultSchema,
    })
    .strict(),
);

/**
 * Decode retained receipt history without exposing mutable storage-owned values.
 * @param receipts - Receipt history being stored or read from durable JSON.
 * @returns Validated, recursively frozen receipt history.
 */
export function parsePreparationReceipts(receipts: unknown): readonly PreparationReceipt[] {
  return snapshot(receipts, (candidate) => preparationReceiptsSchema.parse(candidate));
}

/**
 * Snapshot a caller-supplied allocation reference for durable storage.
 * @param allocationRef - Reference the caller presented.
 * @returns A frozen, schema-valid copy.
 * @throws When the reference violates {@link ProviderAllocationRefSchema}.
 */
export function parseAllocationRef(allocationRef: ProviderAllocationRef): ProviderAllocationRef {
  return snapshot(allocationRef, (candidate) => ProviderAllocationRefSchema.parse(candidate));
}

/**
 * Validate a caller-supplied allocation lifetime for durable storage.
 *
 * The value is a bare enum member, so there is nothing to clone: validating
 * it on ingress is what keeps an out-of-vocabulary lifetime from reaching the
 * immutable provider binding at all.
 * @param allocationLifetime - Lifetime declared by the bound provider.
 * @returns The same value, validated.
 * @throws When the value is outside the contract vocabulary.
 */
export function parseAllocationLifetime(allocationLifetime: WorkerAllocationLifetime): WorkerAllocationLifetime {
  return WorkerAllocationLifetimeSchema.parse(allocationLifetime);
}

/**
 * Validate both references of an allocation reference evolution.
 *
 * The port requires the two to name the same provider: correlation refines
 * the opaque `providerData` of one allocation, it never moves an attempt to a
 * different provider. Nothing in the decision vocabulary can report such a
 * request, so it is a caller bug and is rejected rather than answered.
 *
 * Only `nextRef` becomes durable, so only it gets the frozen snapshot.
 * `currentRef` is the caller's compare-and-set evidence: it is validated —
 * which is also what puts it in the same normalized shape the comparison
 * expects — and then discarded with the call.
 * @param input - Evolution input carrying the current and next references.
 * @returns The validated current reference and a frozen, schema-valid next reference.
 * @throws When either reference is invalid, or the two name different providers.
 */
export function parseAllocationRefEvolution(input: AllocationRefEvolution): {
  readonly currentRef: ProviderAllocationRef;
  readonly nextRef: ProviderAllocationRef;
} {
  const currentRef = ProviderAllocationRefSchema.parse(input.currentRef);
  const nextRef = parseAllocationRef(input.nextRef);
  if (currentRef.providerId !== nextRef.providerId) {
    throw new Error(
      `Allocation reference evolution must keep one provider, ` +
        `received '${currentRef.providerId}' and '${nextRef.providerId}'`,
    );
  }
  return { currentRef, nextRef };
}

/**
 * Require an allocation reference to name the attempt's own provider.
 *
 * The attempt's `providerId` is immutable from the moment provisioning began,
 * so a reference naming a different provider describes infrastructure this
 * attempt never owned. Nothing in the allocation decision vocabulary can
 * report that, so it is a caller bug and is rejected before any mutation —
 * including when the caller's claim is also stale, for the same reason
 * malformed evidence is rejected regardless of ownership.
 *
 * A `null` `providerId` is a mismatch too: an attempt with no bound provider
 * cannot own an allocation reference at all.
 * @param attempt - Durable attempt record the reference is being stored on.
 * @param allocationRef - Reference the caller presented.
 * @throws When the reference names a provider other than the attempt's own.
 */
export function requireAllocationRefProvider(
  attempt: ExecutionAttemptRecord,
  allocationRef: ProviderAllocationRef,
): void {
  if (attempt.providerId === allocationRef.providerId) return;
  throw new Error(
    `Allocation reference for attempt '${attempt.executionAttemptId}' names provider ` +
      `'${allocationRef.providerId}' but the attempt is bound to ` +
      `'${attempt.providerId ?? 'no provider'}'`,
  );
}

// ─────────────────────────────────────────────────────────────
// Runtime and operation control state
// ─────────────────────────────────────────────────────────────

/**
 * The control state a freshly created attempt holds.
 *
 * Stated once so both realizations open an attempt in the same place: no
 * runtime, no readiness, nothing running, and a start gate that is open. A
 * durable realization spells the same values as column defaults; that they
 * agree is what makes a record built in memory and a row read back from
 * storage the same attempt.
 */
export const INITIAL_ATTEMPT_CONTROL_STATE: AttemptControlState = {
  runtimeGeneration: 0,
  runtimeIncarnationId: null,
  runtimeReadyAt: null,
  operationStartGate: 'open',
  activeOperationId: null,
  activeOperationKind: null,
  activeOperationKey: null,
  activeOperationGeneration: null,
  activeOperationAdmittedAt: null,
  lastCompletedOperationId: null,
};

/**
 * Project an attempt record onto its control state alone.
 *
 * The record carries all ten members as required, so this resolves nothing —
 * it narrows. What it is for is the port's `getAttemptControlState`, which owes
 * a caller the control facts and not the rest of the attempt, and the decision
 * sites that read control state rather than reaching into a record for it.
 * @param record - Attempt record whose control state to read.
 * @returns The ten control facts the record holds.
 */
export function toAttemptControlState(record: ExecutionAttemptRecord): AttemptControlState {
  return {
    runtimeGeneration: record.runtimeGeneration,
    runtimeIncarnationId: record.runtimeIncarnationId,
    runtimeReadyAt: record.runtimeReadyAt,
    operationStartGate: record.operationStartGate,
    activeOperationId: record.activeOperationId,
    activeOperationKind: record.activeOperationKind,
    activeOperationKey: record.activeOperationKey,
    activeOperationGeneration: record.activeOperationGeneration,
    activeOperationAdmittedAt: record.activeOperationAdmittedAt,
    lastCompletedOperationId: record.lastCompletedOperationId,
  };
}

// ─────────────────────────────────────────────────────────────
// Recovery narrowing and ordering
// ─────────────────────────────────────────────────────────────

/**
 * Order two recoverable attempts the way the port promises to report them.
 *
 * Oldest first by `createdAt` as an instant, ties broken by ascending
 * `executionAttemptId` so two attempts created within the same millisecond
 * still order identically everywhere.
 *
 * A store expresses the same rule as an `ORDER BY` over its own columns; the
 * two agree because the port stores `createdAt` in the canonical UTC
 * millisecond form, where a lexicographic comparison *is* the instant
 * comparison.
 * @param left - First attempt to order.
 * @param right - Second attempt to order.
 * @returns Negative when `left` sorts first, positive when `right` does, zero when neither.
 */
export function compareRecoveryOrder(left: RecoverableAttemptRecord, right: RecoverableAttemptRecord): number {
  const byInstant = instantOf(left.createdAt) - instantOf(right.createdAt);
  if (byInstant !== 0) return byInstant;
  return left.executionAttemptId < right.executionAttemptId
    ? -1
    : left.executionAttemptId > right.executionAttemptId
      ? 1
      : 0;
}

/**
 * Narrow an attempt a recovery query selected onto the recoverable record.
 *
 * A row that a recovery query matched but that cannot be narrowed is an
 * inconsistent durable record, not a row to leave out: an attempt selected as
 * recoverable and then silently dropped is exactly the attempt whose live
 * infrastructure nobody goes on to reclaim. Failing here is the same choice
 * the port makes for a stored value outside its vocabulary.
 * @param record - Attempt record a recovery query selected.
 * @returns The same attempt, narrowed to the recoverable record.
 * @throws When the record does not satisfy every recoverable guarantee.
 */
export function toRecoverableAttempt(record: ExecutionAttemptRecord): RecoverableAttemptRecord {
  const { status, claimable, settlementKind, allocationRef, providerId } = record;
  const { allocationLifetime, provisionerIncarnationId } = record;
  if (
    status !== 'allocated' ||
    claimable !== true ||
    settlementKind != null ||
    allocationRef === null ||
    providerId === null ||
    allocationLifetime === null ||
    provisionerIncarnationId === null
  ) {
    throw new Error(
      `Attempt '${record.executionAttemptId}' was selected as recoverable but is not: ` +
        `status '${status}', claimable '${String(claimable)}', settlement '${String(settlementKind)}', ` +
        `allocation '${allocationRef === null ? 'none' : 'present'}', provider '${String(providerId)}', ` +
        `lifetime '${String(allocationLifetime)}', provisioner '${String(provisionerIncarnationId)}'`,
    );
  }
  return {
    ...record,
    status,
    claimable: true,
    settlementKind: null,
    allocationRef,
    providerId,
    allocationLifetime,
    provisionerIncarnationId,
  };
}
