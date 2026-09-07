import type {
  BoundedRecoveryEvidence,
  ExecutionAttemptInstruction,
  ExecutionAttemptOperationKind,
  ExecutionAttemptOperationReportRequest,
  ExecutionAttemptOperationReportResponse,
  ExecutionAttemptPreparationResult,
  ExecutionAttemptWorkspaceBinding,
  ProviderAllocationRef,
  WorkerAllocationLifetime,
} from '@makaio/contracts';
import { canonicalStringify } from '@makaio/utils';
import type {
  ProcessBoundProvisionerLossProof,
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationMutationDecision,
  ProviderOperationOwnershipRecord,
} from './provider-operation.js';

export {
  evaluateAttemptReachability,
  evaluateRuntimeRegistration,
  evaluateOperationAdmission,
  evaluateOperationCompletion,
  evaluatePreparationReport,
  evaluateRuntimeReadiness,
} from './execution-attempt-decisions.js';
export type { AttemptReachability, AttemptReachabilityDecision } from './execution-attempt-decisions.js';

// ─────────────────────────────────────────────────────────────
// Attempt Lifecycle States
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of every execution attempt lifecycle status.
 *
 * The order is the progression an attempt follows. Declaring the vocabulary
 * once lets an implementation validate a stored status against the same list
 * the type is derived from.
 */
export const EXECUTION_ATTEMPT_STATUSES = ['pending', 'provisioning', 'allocated', 'settled'] as const;

/**
 * Lifecycle status of an execution attempt.
 *
 * - `pending`: attempt created but provider provisioning has not started.
 * - `provisioning`: a provider call is in flight but no allocation is recorded.
 * - `allocated`: a provider has accepted the attempt and recorded an allocation.
 * - `settled`: the attempt has a committed terminal outcome (accepted or failed).
 */
export type ExecutionAttemptStatus = (typeof EXECUTION_ATTEMPT_STATUSES)[number];

/**
 * Constant array of every way a settled attempt can have reached its terminal
 * state. `null` is deliberately absent: it means "not settled at all", which
 * is the absence of a settlement rather than one of its kinds.
 */
export const EXECUTION_ATTEMPT_SETTLEMENT_KINDS = ['outcome', 'abandoned', 'infrastructure-failure'] as const;

/**
 * How a settled attempt reached its terminal state.
 *
 * - `outcome`: a worker submitted an outcome that was accepted.
 * - `infrastructure-failure`: the provider allocation terminated without
 *   an acknowledged worker outcome. The owner may retry the work.
 * - `abandoned`: dispatch ended before allocation, including a positively
 *   proven absence recorded through
 *   {@link ExecutionAttemptRepository.recordProvisioningAbsent} or a
 *   process-bound provisioner loss recorded through
 *   {@link ExecutionAttemptRepository.recordProvisionerIncarnationLost}.
 *
 * `null` when the attempt has not yet settled.
 */
export type ExecutionAttemptSettlementKind = (typeof EXECUTION_ATTEMPT_SETTLEMENT_KINDS)[number] | null;

/**
 * Constant array of every state the attempt's operation start gate can hold.
 *
 * Declared as an array for the same reason the status vocabulary is: a stored
 * value outside it is corruption, and a realization narrows what it read
 * against this list rather than against a literal of its own.
 */
export const ATTEMPT_OPERATION_START_GATES = ['open', 'closed'] as const;

/**
 * State of the single durable ordering point an attempt admits operations
 * through.
 *
 * - `open`: the attempt may still admit operations, subject to every other
 *   guard.
 * - `closed`: the attempt will never admit another operation. Closing is
 *   one-way and happens exactly where the attempt stops being a place work may
 *   begin — when a newer attempt supersedes it, and when it settles.
 */
export type AttemptOperationStartGate = (typeof ATTEMPT_OPERATION_START_GATES)[number];

/** Coherent durable facts required before an attempt may enter runtime registration. */
export interface BootstrapStartState {
  /** A terminal outcome or infrastructure settlement has been recorded. */
  readonly settled: boolean;
  /** The owner's active pointer still names this attempt, independently of settlement. */
  readonly active: boolean;
  /** An allocation reference is recorded, independently of its termination. */
  readonly allocated: boolean;
  /** Provider-operation state durably confirms allocation termination. */
  readonly allocationTerminated: boolean;
  /** One-way durable gate controlling whether new work may start. */
  readonly operationStartGate: AttemptOperationStartGate;
  /** Immutable ISO deadline, or null for legacy attempts that cannot newly bootstrap. */
  readonly bootstrapDeadlineAt: string | null;
}

/** Trusted owner and attempt identity for the narrow bootstrap observation. */
export interface ReadBootstrapStartStateInput {
  /** Authenticated durable owner of the attempt. */
  readonly executionId: ExecutionOwnerId;
  /** Attempt whose durable start facts are observed. */
  readonly executionAttemptId: string;
}

// ─────────────────────────────────────────────────────────────
// Value Equality
//
// Two of the port's decisions turn on whether a value the caller presented is
// the value the attempt already holds. Both comparisons are specified here,
// as functions, so no realization can pick its own rule: the values involved
// carry provider-owned records whose key order is an artifact of however they
// were built, parsed, or round-tripped through storage, and a store that
// normalizes key order would otherwise disagree with one that does not.
// ─────────────────────────────────────────────────────────────

/**
 * Compare two provider allocation references as values.
 *
 * `providerData` is an opaque provider-owned record, so equality is over the
 * canonical serialization rather than over a literal one: two references are
 * the same reference when they carry the same members with the same values,
 * whatever order those members happen to be in. Array order stays significant,
 * because array position is part of the value.
 * @param stored - Reference the attempt currently holds.
 * @param candidate - Reference the caller presented.
 * @returns `true` when the two denote the same allocation reference.
 */
export function sameAllocationRef(stored: ProviderAllocationRef, candidate: ProviderAllocationRef): boolean {
  return canonicalStringify(stored) === canonicalStringify(candidate);
}

/**
 * Identifier of the durable aggregate that owns a series of attempts.
 *
 * For the workflow adapter this is the `WorkflowExecution` id. The generic
 * port never interprets it; it is the fence key that decides which attempt is
 * active for an owner. The alias is scoped to the repository port, the
 * authority, the dispatch runner, and the convergence ports — wire claims and
 * workflow-storage lookup keys keep plain `string`.
 */
export type ExecutionOwnerId = string;

/**
 * Compare two durable outcome texts as values.
 *
 * The rule {@link sameAllocationRef} states, for the same reason: an outcome
 * may carry caller-authored data whose key order is incidental, and a replay
 * of the identical outcome must be reported as `duplicate` by every
 * realization. The texts are parsed back before canonicalization because a
 * codec is free to emit whatever key order it likes, and key order is not
 * part of the value.
 *
 * Both operands are the codec's durable text — the only representation every
 * realization shares. The stored one is what the attempt actually holds, read
 * out of the realization's own record rather than reproduced from the decoded
 * value: a codec may normalize while serializing, and the contract requires
 * `parse(JSON.parse(serialize(outcome)))` only to succeed, never to serialize
 * back to the same text. Re-serializing the decoded outcome would therefore
 * compare a retry against a text the first commit never wrote, and would
 * answer `conflict` for a worker's honest replay. Comparing texts also keeps
 * a value such as a `bigint` — which a codec may legitimately encode, and
 * which has no JSON form of its own — away from the canonicalizer entirely.
 * @param stored - Durable text the attempt committed.
 * @param candidate - Durable text the caller's submission would commit.
 * @returns `true` when the two denote the same outcome.
 */
export function sameDurableOutcome(stored: string, candidate: string): boolean {
  return canonicalStringify(JSON.parse(stored) as unknown) === canonicalStringify(JSON.parse(candidate) as unknown);
}

/**
 * The durable text a submission commits as, with the value that text yields.
 *
 * The two are produced together, by one call to {@link durableOutcome}, because
 * they are one durable fact: the text is what a realization writes, and the
 * outcome is what a reload of that text returns. Deriving either from the
 * other later would re-serialize an already-normalized value, and a codec is
 * not required to serialize such a value back to the text it came from.
 *
 * It is the currency of the whole outcome path. A caller renders a submission
 * once through {@link ExecutionAttemptRepository.canonicalizeOutcome},
 * validates `outcome`, and hands the same rendering to
 * {@link ExecutionAttemptRepository.commitOutcome}, which stores `text`
 * verbatim. Nothing between those steps re-reads the submitter's object, so a
 * mutable outcome the caller changes afterwards cannot make the committed
 * value differ from the validated one.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface DurableOutcome<TOutcome> {
  /** The codec text a realization persists for this submission. */
  readonly text: string;
  /** The outcome that text reads back as, produced by the same rendering. */
  readonly outcome: TOutcome;
}

/**
 * Render a caller-supplied outcome as the durable fact a commit would write.
 *
 * The rendering rule every realization owes, stated once here for the same
 * reason {@link sameDurableOutcome} is: it decides what an attempt holds, so
 * two realizations deriving it independently could disagree about it.
 *
 * Three steps, in this order and each exactly once. `parse` validates the
 * submission before any durable decision, so a value the codec rejects is
 * refused at the same point by every realization. `serialize` produces the
 * text to persist — the single serialization the pair is built from.
 * `parse(JSON.parse(text))` yields what a reload returns, which is the
 * outcome the port reports and an owner converges on; a codec may normalize
 * while serializing, so it is not in general the submitted value.
 *
 * Nothing is cloned and nothing is frozen. The round trip already produces a
 * value derived from freshly parsed JSON rather than from the caller's
 * object, so no reference reaches back into anything the caller still holds.
 * A `structuredClone` in front of it would reject an outcome type that is
 * codec-serializable but not structured-cloneable, such as a `URL`, and an
 * `Object.freeze` behind it would throw outright for one that is not
 * freezable, such as a non-empty `Uint8Array` — both of which the codec
 * contract allows. What keeps a committed outcome stable instead is that a
 * realization stores the text and decodes it afresh on every read, so a
 * caller that mutates the value it was handed changes nothing a later read
 * reports.
 * @param codec - Owner-injected codec that owns the durable representation.
 * @param outcome - Outcome the caller presented.
 * @returns The text to persist and the outcome it reads back as.
 * @throws When the codec rejects the outcome or its own durable text.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export function durableOutcome<TOutcome>(codec: OutcomeCodec<TOutcome>, outcome: TOutcome): DurableOutcome<TOutcome> {
  const text = codec.serialize(codec.parse(outcome));
  return { text, outcome: decodeDurableOutcome(codec, text) };
}

/**
 * Read a committed durable text back as the outcome it holds.
 *
 * The read rule every realization owes, stated once here for the same reason
 * {@link durableOutcome} states the write rule: what a stored text yields
 * must not depend on which realization reads it. `JSON.parse` undoes the
 * transport form and `parse` validates the envelope, so a text the codec
 * refuses — durable corruption, or a codec an owner changed under an existing
 * row — fails loudly rather than reaching a caller as an ordinary outcome.
 *
 * Every read decodes afresh, and nothing is shared, cloned, or frozen. A
 * codec may reconstruct a mutable object whose state a freeze does not even
 * reach, such as a `URL`, so one reader mutating the value it was handed must
 * not change what the next read reports; the stored text stays the only
 * source of truth.
 * @param codec - Owner-injected codec that owns the durable representation.
 * @param text - Durable text an attempt committed.
 * @returns The outcome that text holds, held by nobody else.
 * @throws When the text is not JSON, or not JSON the codec accepts.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export function decodeDurableOutcome<TOutcome>(codec: OutcomeCodec<TOutcome>, text: string): TOutcome {
  return codec.parse(JSON.parse(text) as unknown);
}

/**
 * Validates and serializes the owner-specific outcome type of an attempt.
 *
 * Injected into every {@link ExecutionAttemptRepository} realization so the
 * generic port can enforce "input validation precedes every durable decision"
 * without knowing the outcome shape. `parse` runs on every submitted outcome
 * before the durable decision and on every committed outcome read back from
 * storage; `serialize` produces the durable representation.
 *
 * **The durable representation is JSON text, and the two members round-trip
 * through it.** A realization persists exactly what `serialize` returned,
 * reads it back with `JSON.parse`, and hands the parsed value to `parse`; a
 * codec must therefore accept `JSON.parse(serialize(outcome))` for every
 * outcome it produced. Which envelope lives inside that text is the codec's
 * own choice — no realization may assume it is `JSON.stringify(outcome)`.
 *
 * **The text is strict JSON, in the sense `JSON.stringify` defines.** Only
 * values that function can represent are inside the contract: finite numbers,
 * strings, booleans, `null`, arrays, and plain objects. A non-finite number —
 * `Infinity`, `-Infinity`, `NaN`, written as `1e9999` or any other spelling —
 * is outside it, as is anything else JSON has no form for, because the port
 * decides outcome equality by canonicalizing the parsed text with
 * `canonicalStringify` (see {@link sameDurableOutcome}), which renders every
 * such value as `null` and would report two different outcomes as the same
 * one. A codec whose outcomes need those values encodes them as values JSON
 * does have — a string, or a tagged envelope — which is the codec's own job
 * and not something a realization can do for it. Equality follows JSON
 * semantics for the same reason: signed zero is outside the contract, `-0`
 * and `0` are one and the same outcome, because `JSON.stringify` renders both
 * as `0` and the canonical form cannot tell them apart. A codec that needs the
 * sign encodes it explicitly, as it would any other value JSON does not carry.
 *
 * **Both members are deterministic, pure functions of their argument.** The
 * same outcome serializes to the same text every time and the same value
 * parses to the same outcome every time; neither may consult history, a
 * counter, a clock, or any state outside the argument it was handed.
 *
 * The port itself renders a submission exactly once, through
 * {@link ExecutionAttemptRepository.canonicalizeOutcome}, and carries that one
 * {@link DurableOutcome} into {@link ExecutionAttemptRepository.commitOutcome}
 * — so validation, the durable write, and convergence are one rendering and
 * cannot drift apart. Determinism is still owed, because two renderings of
 * the same outcome do meet: `commitOutcome` compares the text a retry renders
 * against the text the first commit stored, and a codec that closed over a
 * counter would misclassify a worker's honest retry.
 *
 * Determinism is not idempotence. `serialize` need not map its own decoded
 * output back to the text it came from: a codec may normalize, and every
 * decision the port makes about a committed outcome is made on the text that
 * commit actually stored rather than on a re-serialization of it.
 *
 * `null` and `undefined` are not outcomes. A realization records "no outcome
 * committed" as the absence of a stored value, so a codec that accepted a
 * nullish outcome would make the two indistinguishable.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface OutcomeCodec<TOutcome> {
  /**
   * Validate an untrusted value as an outcome.
   *
   * Deterministic and pure: the same input always yields the same outcome.
   * @param input - Value to validate.
   * @returns The validated outcome.
   * @throws When the value violates the outcome contract, including when it is nullish.
   */
  parse(input: unknown): TOutcome;
  /**
   * Serialize an outcome for durable storage.
   *
   * Deterministic and pure: the same outcome always yields the same text,
   * because a retry's rendering is compared against the text an earlier
   * commit stored.
   * @param outcome - Outcome to serialize.
   * @returns The JSON text to persist, which `parse` accepts after `JSON.parse`.
   */
  serialize(outcome: TOutcome): string;
}

/**
 * Rejection of an attempt identifier that already names a durable attempt.
 *
 * Named so that every realization reports the same failure for the same cause,
 * and so a caller can tell a reused identifier apart from a storage fault
 * without matching on message text. A realization that detects the collision
 * through a unique-constraint violation rather than a prior read translates
 * that violation into this error before it leaves
 * {@link ExecutionAttemptRepository.createAttempt}.
 */
export class DuplicateExecutionAttemptError extends Error {
  /** Attempt identifier that already exists. */
  public readonly executionAttemptId: string;

  /**
   * @param executionAttemptId - Attempt identifier that already exists.
   * @param options - Standard error options, carrying the driver failure as `cause` where one exists.
   */
  public constructor(executionAttemptId: string, options?: ErrorOptions) {
    super(`Execution attempt '${executionAttemptId}' already exists`, options);
    this.name = 'DuplicateExecutionAttemptError';
    this.executionAttemptId = executionAttemptId;
  }
}

// ─────────────────────────────────────────────────────────────
// Attempt Records (JSON-safe, non-secret)
// ─────────────────────────────────────────────────────────────

/**
 * The runtime and operation control state of one attempt.
 *
 * Ten facts that together decide who may act on an attempt's runtime endpoint
 * and whether an operation may start. They live *on* the attempt rather than in
 * a record beside it: every guard that reads them is also a guard the write has
 * to repeat, and a single-row compare-and-set is what keeps that expressible.
 *
 * The three fences are independent and each answers a different question:
 * {@link runtimeGeneration} says which runtime incarnation is current,
 * {@link operationStartGate} says whether the attempt still starts work at all,
 * and {@link activeOperationId} says whether it is already busy.
 *
 * It is also the shape {@link ExecutionAttemptRepository.getAttemptControlState}
 * reports, so a process that lost its own memory of an attempt can read back
 * exactly what a fresh decision would be made against.
 */
export interface AttemptControlState {
  /**
   * Monotonic fence over runtime incarnations, `0` before any registered.
   *
   * Allocated by {@link ExecutionAttemptRepository.registerRuntime} and never
   * proposed by a caller: a runtime only ever echoes the generation it was
   * given. Anything presented against an older generation is
   * `stale-generation`.
   */
  readonly runtimeGeneration: number;
  /**
   * Runtime incarnation currently registered, or `null` before any was.
   *
   * The registration idempotency key. A report naming the stored incarnation
   * is a replay and is answered `duplicate`; a different one is a new
   * incarnation and takes the next generation.
   */
  readonly runtimeIncarnationId: string | null;
  /**
   * ISO-8601 instant at which readiness was accepted for the current
   * generation, or `null` while it has not been.
   *
   * Written by {@link ExecutionAttemptRepository.markRuntimeReady} and cleared
   * by every {@link ExecutionAttemptRepository.registerRuntime} that allocates
   * a new generation: readiness is a property of one incarnation, so it can
   * never outlive the incarnation that proved it.
   */
  readonly runtimeReadyAt: string | null;
  /**
   * Whether the attempt still admits operations.
   *
   * `open` from creation. Closed by {@link ExecutionAttemptRepository.createAttempt}
   * on the attempt it supersedes, and by every terminal settlement on the
   * attempt it settles. Closing is one-way.
   */
  readonly operationStartGate: AttemptOperationStartGate;
  /**
   * Operation currently occupying the attempt, or `null` when it is idle.
   *
   * The at-most-one guard: an attempt runs one operation at a time. Cleared by
   * {@link ExecutionAttemptRepository.completeOperation} together with
   * {@link activeOperationKind}, {@link activeOperationKey},
   * {@link activeOperationGeneration}, and {@link activeOperationAdmittedAt} —
   * one write, because a half-cleared
   * operation would be neither active nor absent.
   *
   * A terminal settlement deliberately leaves it in place, so a completion that
   * arrives after the attempt settled reads `resolved` rather than
   * `not-active`.
   */
  readonly activeOperationId: string | null;
  /**
   * Kind of the active operation, or `null` when the attempt is idle.
   *
   * Kept because the bounded runtime probe and a durable owner's run are not
   * interchangeable: the probe is admitted while readiness is still unproven
   * and is never announced to anyone but its own runtime.
   */
  readonly activeOperationKind: ExecutionAttemptOperationKind | null;
  /**
   * Idempotency key the active operation was admitted under, or `null` when the
   * attempt is idle.
   *
   * A second admission presenting this key is the same admission retried, and
   * is answered `duplicate` with the operation identifier the first one
   * received.
   */
  readonly activeOperationKey: string | null;
  /**
   * Runtime generation the active operation is fenced against, or `null` when
   * the attempt is idle.
   *
   * A completion reported against an older generation belongs to a runtime that
   * has since been superseded and is refused as `stale-generation`.
   */
  readonly activeOperationGeneration: number | null;
  /**
   * ISO-8601 instant at which the active operation was admitted, or `null`
   * when the attempt is idle.
   *
   * Recorded so a replayed admission announces the instant the authority
   * admitted the operation, not the instant of the replay. Cleared together
   * with the other active-operation members.
   */
  readonly activeOperationAdmittedAt: string | null;
  /**
   * Operation identifier of the most recent completion, or `null` before any.
   *
   * What makes a replayed completion answerable: the active operation is gone
   * by then, so without it the replay would be indistinguishable from a
   * completion for an operation that never existed.
   */
  readonly lastCompletedOperationId: string | null;
}

/**
 * Durable record for one execution attempt.
 *
 * Produced by the injected {@link ExecutionAttemptRepository} and consumed by
 * the Authority service. All fields are JSON-safe and contain no secrets.
 *
 * The {@link AttemptControlState} members are part of the record because they
 * are columns on the attempt, not a separate aggregate — and they are required,
 * unlike {@link claimable} and {@link settlementKind}. Every attempt holds all
 * ten from {@link ExecutionAttemptRepository.createAttempt} onwards, so a
 * record that omits one describes an attempt that cannot exist. Requiring them
 * is what makes that omission a type error at the place the record is built,
 * rather than a default silently resolved at each place it is read.
 */
export interface ExecutionAttemptRecord extends AttemptControlState, AttemptExecutionState {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Owner identifier of the aggregate this attempt belongs to. */
  readonly executionId: ExecutionOwnerId;
  /** Current lifecycle status of the attempt. */
  readonly status: ExecutionAttemptStatus;
  /** Provider allocation reference, set after allocation recording. */
  readonly allocationRef: ProviderAllocationRef | null;
  /** ISO-8601 timestamp when the attempt was created. */
  readonly createdAt: string;
  /** Immutable creation-time bootstrap deadline; null only for legacy records. */
  readonly bootstrapDeadlineAt: string | null;
  /**
   * Provider bound to this attempt, or `null` before provisioning began.
   *
   * Written exactly once, atomically, by the first successful
   * {@link ExecutionAttemptRepository.beginProvisioning}. It never changes
   * afterwards: an attempt belongs to one provider for its whole life, and a
   * different provider means a different attempt.
   */
  readonly providerId: string | null;
  /**
   * Allocation lifetime declared by the bound provider, or `null` before
   * provisioning began.
   *
   * Immutable alongside {@link providerId}. Remediation reads it to decide
   * whether losing the provisioning process also loses the allocation.
   */
  readonly allocationLifetime: WorkerAllocationLifetime | null;
  /**
   * Provisioner process incarnation that performed the provider call, or
   * `null` before provisioning began.
   *
   * Immutable alongside {@link providerId}. Process-loss proof is accepted
   * only when it names exactly this incarnation.
   */
  readonly provisionerIncarnationId: string | null;
  /**
   * How this attempt reached its terminal state.
   *
   * `null` while the attempt is `pending`, `provisioning`, or `allocated`. Set to `'outcome'`
   * when a worker outcome is committed, or `'infrastructure-failure'` when
   * the provider allocation terminated without an acknowledged outcome, or
   * `'abandoned'` when dispatch ends before allocation or absence is proven.
   */
  readonly settlementKind?: ExecutionAttemptSettlementKind;
  /**
   * Whether this attempt is eligible for bootstrap claims.
   *
   * Set to `true` when the active attempt is allocated and a recovery-capable
   * provider is assigned. Cleared when the attempt settles or is replaced.
   * An attempt that is no longer the active attempt for its execution never
   * becomes bootstrap-claimable, even when remediation records an allocation
   * for it.
   */
  readonly claimable?: boolean;
  /**
   * ISO-8601 timestamp after which claim eligibility expires.
   *
   * `null` when claim eligibility has no expiry or the attempt is not
   * claimable, which is what {@link ExecutionAttemptRepository.createAttempt}
   * establishes.
   *
   * The host application owns claim expiry outright: no transition on this
   * port ever writes this field. The host sets it through whatever path
   * issues its bootstrap claims, and the port's obligations are to preserve
   * it across every transition, report it on every read, and honour it in
   * {@link ExecutionAttemptRecoveryOperations.getRecoverableAttempts}. An
   * implementation that reset it during an unrelated transition would extend
   * a claim window the host had already closed.
   */
  readonly claimExpiresAt?: string | null;
}

/**
 * An allocated attempt that is eligible for recovery.
 *
 * Guarantees that `allocationRef` is non-null, status is `'allocated'`,
 * the attempt has not settled, and the immutable provider binding is
 * populated. Used as the return type of
 * {@link ExecutionAttemptRecoveryOperations.getRecoverableAttempts} to give
 * callers a narrowed type without runtime re-checks.
 */
export interface RecoverableAttemptRecord extends ExecutionAttemptRecord {
  /** Always `'allocated'` for recoverable attempts. */
  readonly status: 'allocated';
  /** Always non-null for recoverable attempts. */
  readonly allocationRef: ProviderAllocationRef;
  /** Always `true` for recoverable attempts. */
  readonly claimable: true;
  /** Always `null` for recoverable attempts (not yet settled). */
  readonly settlementKind: null;
  /** Always bound for recoverable attempts. */
  readonly providerId: string;
  /** Always bound for recoverable attempts. */
  readonly allocationLifetime: WorkerAllocationLifetime;
  /** Always bound for recoverable attempts. */
  readonly provisionerIncarnationId: string;
}

// ─────────────────────────────────────────────────────────────
// Repository Input Shapes
// ─────────────────────────────────────────────────────────────

/**
 * Input for creating a new execution attempt.
 *
 * The Authority generates `executionAttemptId` before calling this method.
 */
export interface ExecutionAttemptCreate {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Owner identifier the attempt belongs to. */
  readonly executionId: ExecutionOwnerId;
  /** Portable assignment snapshotted before this attempt becomes dispatchable. */
  readonly instruction: ExecutionAttemptInstruction;
  /** Explicit positive safe-integer bootstrap budget in milliseconds, frozen at creation. */
  readonly bootstrapTimeoutMs: number;
}

/** Durable acceptance of one successful Preparation operation. */
export interface PreparationReceipt {
  /** Identity of the completed Preparation operation. */
  readonly operationId: string;
  /** Runtime realization to which the binding belongs. */
  readonly runtimeGeneration: number;
  /** Original semantic result, retained for replay comparison and diagnostics. */
  readonly result: ExecutionAttemptPreparationResult;
}

/** Immutable assignment and accepted Preparation facts read with control state. */
export interface AttemptExecutionState {
  /** The attempt's original assignment, never the owner's latest configuration. */
  readonly instruction: ExecutionAttemptInstruction;
  /** Accepted historical results; only the current generation permits Invocation. */
  readonly preparationReceipts: readonly PreparationReceipt[];
}

/** Owner-scoped query for the immutable assignment of one attempt. */
export interface GetInstructionInput {
  /** Owning aggregate, supplied by the authenticated host boundary. */
  readonly executionId: ExecutionOwnerId;
  /** Attempt whose stored assignment is requested. */
  readonly executionAttemptId: string;
}

/** Successful Preparation report plus its trusted owner identity. */
export type ReportOperationInput = ExecutionAttemptOperationReportRequest & {
  /** Owning aggregate, supplied by the authenticated host boundary. */
  readonly executionId: ExecutionOwnerId;
};

/** Semantic acceptance or refusal of a Preparation result. */
export type OperationReportDecision =
  | { readonly kind: 'accepted'; readonly binding: ExecutionAttemptWorkspaceBinding }
  | { readonly kind: 'duplicate'; readonly binding: ExecutionAttemptWorkspaceBinding }
  | {
      readonly kind: Extract<ExecutionAttemptOperationReportResponse, { decision: 'refused' }>['refusalReason'];
    };

/**
 * Input for claiming the provisioning phase of an attempt.
 *
 * Carries both the immutable provider binding written by the first successful
 * begin and the host-owned initial claim context. The repository writes them
 * in one transaction, so an attempt can never be bound to a provider without
 * an owned operation, or vice versa.
 */
export interface BeginProvisioningInput {
  /** Attempt whose provider call is about to begin. */
  readonly executionAttemptId: string;
  /** Owner identifier the attempt must belong to. */
  readonly executionId: ExecutionOwnerId;
  /** Provider to bind to the attempt, immutably. */
  readonly providerId: string;
  /** Allocation lifetime declared by that provider, immutably. */
  readonly allocationLifetime: WorkerAllocationLifetime;
  /** Provisioner process incarnation performing the call, immutably. */
  readonly provisionerIncarnationId: string;
  /** Controller process incarnation that will hold the initial claim. */
  readonly ownerId: string;
  /** ISO-8601 deadline for the initial lease. */
  readonly leaseExpiresAt: string;
}

/**
 * Input for committing a terminal outcome to an attempt.
 *
 * The repository makes the durable accept/duplicate/conflict/fence decision
 * and returns the canonical outcome for convergence. Outcome commitment
 * carries no claim: a worker's answer never depends on who currently owns
 * the attempt's provider operation.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface ExecutionAttemptOutcomeCommit<TOutcome> {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Owner identifier the attempt belongs to. */
  readonly executionId: ExecutionOwnerId;
  /**
   * The rendering to commit, from
   * {@link ExecutionAttemptRepository.canonicalizeOutcome}.
   *
   * A rendering rather than a raw outcome so the value a caller validated and
   * the value that becomes durable are the same one: the caller renders the
   * submission once and never reads its own object again.
   */
  readonly result: DurableOutcome<TOutcome>;
  /** Runtime correlation checked atomically for a fresh commit; owner-only paths may omit it. */
  readonly runtimeFence?: RuntimeOutcomeFence;
}

/** Runtime and operation expected to remain current when an outcome becomes durable. */
export interface RuntimeOutcomeFence {
  /** Registered runtime generation that produced the result. */
  readonly runtimeGeneration: number;
  /** Admitted operation, or null for a startup failure before any operation. */
  readonly operationId: string | null;
}

/** A runtime result lost its execution slot before commit; the attempt remains available to its current runtime. */
export class RuntimeOutcomeFenceMismatchError extends Error {
  public constructor() {
    super('Runtime outcome no longer matches the current generation and operation');
    this.name = 'RuntimeOutcomeFenceMismatchError';
  }
}

/**
 * Require a fresh runtime outcome to belong to the coherently read execution slot.
 * Repositories call this after canonical replay/settlement decisions and repeat its
 * predicates in the committing write. A mismatch must not settle the attempt's waiter.
 * @param control - Current runtime and operation facts.
 * @param fence - Expected runtime slot, absent for owner-only outcome submission.
 * @throws RuntimeOutcomeFenceMismatchError when the originating runtime slot changed.
 */
export function assertRuntimeOutcomeFence(control: AttemptControlState, fence: RuntimeOutcomeFence | undefined): void {
  if (fence === undefined) return;
  if (
    control.runtimeGeneration !== fence.runtimeGeneration ||
    control.activeOperationId !== fence.operationId ||
    (fence.operationId !== null && control.activeOperationGeneration !== fence.runtimeGeneration)
  ) {
    throw new RuntimeOutcomeFenceMismatchError();
  }
}

/** Input for extending the lease of a currently held provider operation. */
export interface RenewProviderOperationClaimInput {
  /** Claim the caller currently believes it holds. */
  readonly claim: ProviderOperationClaim;
  /** New ISO-8601 lease deadline. */
  readonly leaseExpiresAt: string;
}

/**
 * Input for taking ownership of an unowned or expired provider operation.
 *
 * Takeover needs no prior claim — that is the point. It succeeds only when
 * the operation is unowned or its lease has expired relative to `observedAt`,
 * and it always increments the generation so every claim issued before it is
 * fenced immediately.
 */
export interface TakeOverProviderOperationInput {
  /** Attempt whose provider operation is being taken over. */
  readonly executionAttemptId: string;
  /** Controller process incarnation requesting ownership. */
  readonly ownerId: string;
  /** ISO-8601 observation time used to evaluate lease expiry. */
  readonly observedAt: string;
  /** ISO-8601 deadline for the new lease. */
  readonly leaseExpiresAt: string;
}

/**
 * Input for releasing a held provider operation without resolving it.
 *
 * Handoff is a graceful release, not a failure: optional evidence explains
 * why control was released but does not count towards the failure total.
 */
export interface HandoffProviderOperationInput {
  /** Claim being released. */
  readonly claim: ProviderOperationClaim;
  /** Optional bounded evidence explaining the release. */
  readonly evidence?: BoundedRecoveryEvidence;
}

/**
 * Input for recording that a provider observation stayed inconclusive.
 *
 * Uncertainty is the only honest record for an ambiguous provider result. It
 * retains the current obligation and never terminalizes the attempt.
 */
export interface RecordProviderOperationUncertaintyInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Bounded evidence describing what blocked a conclusion. */
  readonly evidence: BoundedRecoveryEvidence;
}

/** Input for recording an allocation reference against a held operation. */
export interface RecordAllocationInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /**
   * Validated, JSON-safe provider allocation reference.
   *
   * Its `providerId` must equal the attempt's immutable `providerId`. An
   * attempt belongs to one provider for its whole life, so a reference naming
   * a different one cannot describe this attempt's infrastructure, and storing
   * it would durably point remediation at a provider that never allocated
   * anything for it.
   */
  readonly allocationRef: ProviderAllocationRef;
}

/**
 * Input for recording positively proven absence of any allocation.
 *
 * `executionId` is an ownership consistency check — the attempt must belong
 * to the named execution. It is deliberately not an active-attempt fence:
 * an open operation stays remediable after its attempt is superseded.
 */
export interface RecordProvisioningAbsentInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Owner identifier the attempt must belong to. */
  readonly executionId: ExecutionOwnerId;
  /** Bounded evidence supporting the absence claim. */
  readonly evidence: BoundedRecoveryEvidence;
}

/**
 * Input for closing pre-allocation debt on proven provisioner-process loss.
 *
 * `executionId` is an ownership consistency check, exactly as it is for
 * {@link RecordProvisioningAbsentInput}. The proof is passed whole rather than
 * decomposed, so an implementation cannot accept an incarnation identifier
 * without the bounded evidence that supports it.
 */
export interface RecordProvisionerIncarnationLostInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Owner identifier the attempt must belong to. */
  readonly executionId: ExecutionOwnerId;
  /** Proof that a specific provisioner process incarnation is gone. */
  readonly proof: ProcessBoundProvisionerLossProof;
}

/** Input for recording confirmed termination of a known allocation. */
export interface RecordAllocationTerminatedInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Bounded evidence supporting the termination claim. */
  readonly evidence: BoundedRecoveryEvidence;
}

/**
 * Input for settling an allocated attempt as an infrastructure failure.
 *
 * `executionId` is an ownership consistency check, not an active-attempt
 * fence.
 */
export interface RecordInfrastructureFailureInput {
  /** Claim authorizing the settlement. */
  readonly claim: ProviderOperationClaim;
  /** Owner identifier the attempt must belong to. */
  readonly executionId: ExecutionOwnerId;
}

/**
 * Input for a compare-and-set evolution of an allocation reference.
 *
 * Used when provider correlation updates the reference after initial
 * allocation (for example when a hosted runner's run and job identity only
 * become known after the dispatch call has already returned).
 *
 * The repository must verify that `currentRef` matches the stored
 * allocation reference for the claimed attempt. If it does not match,
 * the evolution is rejected to prevent lost updates.
 */
export interface AllocationRefEvolution {
  /** Claim authorizing the evolution. */
  readonly claim: ProviderOperationClaim;
  /** Owner identifier the attempt must belong to. */
  readonly executionId: ExecutionOwnerId;
  /**
   * The allocation reference the caller believes is currently stored.
   *
   * Compared against the stored reference by {@link sameAllocationRef}, and
   * that comparison alone decides whether the evolution is permitted. A
   * realization may additionally guard its write on the stored row being
   * unchanged since it read — that is a concurrency guard over its own
   * storage, and it answers a different question than the one the caller is
   * owed a decision about.
   */
  readonly currentRef: ProviderAllocationRef;
  /** The new allocation reference to store if the CAS check passes. */
  readonly nextRef: ProviderAllocationRef;
}

/**
 * Input for registering a runtime incarnation as an attempt's endpoint.
 *
 * `executionId` is the active-attempt fence, not merely an ownership check: a
 * superseded attempt must never acquire a fresh runtime endpoint, because
 * nothing would ever address it again.
 *
 * No generation is supplied. The repository allocates it, exactly as
 * {@link ExecutionAttemptRepository.beginProvisioning} mints the first claim,
 * so a runtime can never propose a fence for itself.
 */
export interface RegisterRuntimeInput {
  /** Attempt whose runtime endpoint is being registered. */
  readonly executionAttemptId: string;
  /** Owner identifier the attempt must belong to, and be active for. */
  readonly executionId: ExecutionOwnerId;
  /** Identifier of this concrete runtime incarnation, unique per boot. */
  readonly runtimeIncarnationId: string;
}

/**
 * Input for admitting one operation through an attempt's start gate.
 *
 * `admissionKey` is the caller's idempotency key and the only thing that makes
 * a retry answerable: the repository mints the operation identifier, so a
 * caller that lost the reply has no other way to ask which operation it got.
 */
export interface AdmitOperationInput {
  /** Attempt the operation would run under. */
  readonly executionAttemptId: string;
  /** Owner identifier the attempt must belong to, and be active for. */
  readonly executionId: ExecutionOwnerId;
  /** Kind of operation being admitted. */
  readonly operationKind: ExecutionAttemptOperationKind;
  /** Caller-chosen idempotency key for this admission. */
  readonly admissionKey: string;
  /** Runtime generation the caller fences the admission against. */
  readonly runtimeGeneration: number;
}

/**
 * Input for completing the operation an attempt currently runs.
 *
 * Carries no `executionId`: completion frees a slot the attempt already
 * occupies, and a superseded attempt owes that release just as much as an
 * active one does. Refusing it would strand the operation forever.
 */
export interface CompleteOperationInput {
  /** Attempt whose active operation is completing. */
  readonly executionAttemptId: string;
  /** Operation the caller believes it is completing. */
  readonly operationId: string;
  /** Runtime generation the completion is fenced against. */
  readonly runtimeGeneration: number;
}

/**
 * Input for recording that a registered runtime proved itself ready.
 *
 * Carries `executionId`, unlike {@link CompleteOperationInput}: completion
 * releases a slot the attempt already occupies, but readiness asserts that the
 * attempt's endpoint is current, and an attempt superseded between the probe's
 * completion and this write no longer has a current endpoint. The generation
 * fence alone cannot see that — a superseded attempt keeps its generation.
 */
export interface MarkRuntimeReadyInput {
  /** Attempt whose runtime proved ready. */
  readonly executionAttemptId: string;
  /** Owner identifier the attempt must belong to, and be active for. */
  readonly executionId: ExecutionOwnerId;
  /** Generation the readiness belongs to. */
  readonly runtimeGeneration: number;
  /** ISO-8601 instant at which readiness was observed. */
  readonly readyAt: string;
}

// ─────────────────────────────────────────────────────────────
// Repository Decisions
// ─────────────────────────────────────────────────────────────

/**
 * Durable decision for claiming provider provisioning ownership.
 *
 * `started` alone authorizes a provider call, and it carries the only claim
 * that can authorize the provider-side records which follow. Every other
 * decision denies a new call because provisioning already began, or the
 * attempt is allocated, resolved, superseded, or unknown.
 *
 * - `started`: this caller now owns the operation and may call the provider.
 * - `already-provisioning`: a begin already succeeded for this attempt. The
 *   caller must converge the existing operation instead of calling again.
 * - `allocated`: an allocation is already recorded for this attempt.
 * - `resolved`: the attempt has settled; the operation is closed.
 * - `fenced`: the attempt exists but is no longer the active attempt for its
 *   execution, so it may not bootstrap a new provider call.
 * - `not-found`: no such attempt for the given execution.
 */
export type ProvisioningClaimDecision =
  | { readonly kind: 'started'; readonly claim: ProviderOperationClaim }
  | { readonly kind: 'already-provisioning' }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved'; readonly allocationRef: ProviderAllocationRef | null }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording an allocation reference.
 *
 * `recorded` and `duplicate` confirm that the caller owns `allocationRef`.
 * Every other decision denies ownership and carries an existing reference when
 * one exists, preserving durable evidence for diagnostics and reconciliation.
 *
 * - `recorded`: the reference was stored and the operation now owns the
 *   allocation.
 * - `duplicate`: a reference {@link sameAllocationRef} judges identical was
 *   already stored; this is a replay.
 * - `conflict`: a different reference is already stored for this attempt.
 * - `resolved`: the attempt has settled; the operation is closed.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type AllocationRecordingDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'duplicate'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'conflict'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved'; readonly allocationRef: ProviderAllocationRef | null }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording an allocation found by provider discovery.
 *
 * Shares the vocabulary of {@link AllocationRecordingDecision} because the
 * outcomes are the same; the two differ in effect, not in reporting. A
 * discovered allocation never makes its attempt bootstrap-claimable.
 */
export type DiscoveredAllocationDecision = AllocationRecordingDecision;

/**
 * Durable decision for recording positively proven pre-allocation absence.
 *
 * - `recorded`: absence evidence was stored, the attempt settled as
 *   `abandoned`, and the operation closed — all in one transaction.
 * - `allocated`: an allocation won the race. Absence must never terminalize
 *   an attempt that owns live infrastructure.
 * - `resolved`: the attempt has already settled; the operation is closed.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type ProvisioningAbsenceDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for closing pre-allocation debt on proven loss of the
 * provisioner process incarnation.
 *
 * The counterpart of {@link ProvisioningAbsenceDecision} for the one lifetime
 * where nothing needs to be observed to conclude: a
 * `provisioner-process-bound` allocation cannot outlive the process that
 * created it, so proof that the exact recorded incarnation is gone is proof
 * that no allocation survives. Every refusal below is a statement about why the
 * proof does not apply, and each is reported distinctly because they oblige the
 * caller to do different things.
 *
 * - `recorded`: the proof was stored, the attempt settled as `abandoned`, and
 *   the operation closed — all in one transaction.
 * - `not-process-bound`: the attempt's recorded lifetime is not
 *   `provisioner-process-bound`, so losing a process says nothing about its
 *   allocation. The reported lifetime is the stored one, `null` before
 *   provisioning began.
 * - `incarnation-mismatch`: the proof names a different provisioner
 *   incarnation, or the attempt has none recorded, so the proof says nothing
 *   about this attempt. The reported identifier is the stored one.
 * - `allocated`: an allocation is already recorded, so the attempt owes
 *   allocation control rather than pre-allocation closure. Terminate the known
 *   allocation instead of closing the attempt from a proof.
 * - `resolved`: the attempt has already settled; the operation is closed.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt, or it does not
 *   belong to the named execution.
 */
export type ProvisionerIncarnationLossDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'not-process-bound'; readonly allocationLifetime: WorkerAllocationLifetime | null }
  | { readonly kind: 'incarnation-mismatch'; readonly provisionerIncarnationId: string | null }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for settling an allocated attempt as an infrastructure
 * failure.
 *
 * This terminal CAS competes with outcome submission; the first durable
 * transition wins and the loser observes `resolved`.
 *
 * - `recorded`: the failure was persisted, the attempt settled, and the
 *   operation closed.
 * - `resolved`: the attempt already has a terminal settlement.
 * - `not-allocated`: the attempt owns no allocation, so it cannot have
 *   suffered an infrastructure failure. Prove absence instead.
 * - `not-terminated`: the attempt owns an allocation whose termination has not
 *   been confirmed, so the operation still owes `allocation-control`. Confirm
 *   the termination through {@link ExecutionAttemptRepository.recordAllocationTerminated}
 *   first. Reported distinctly from `stale` for the same reason
 *   {@link AllocationTerminationDecision} separates the two: the caller's
 *   authority is current, and what it must do next is supply the missing
 *   transition rather than re-read ownership.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type InfrastructureFailureDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-allocated' }
  | { readonly kind: 'not-terminated' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording confirmed termination of a known allocation.
 *
 * It extends the shared mutation vocabulary with the one refusal that is not a
 * staleness signal. `stale` says the caller's authority is gone and it must
 * re-read; `not-allocated` says the caller's authority is current and the
 * operation simply owns nothing to terminate. Collapsing the two would let a
 * fenced controller mistake itself for a current one with no allocation, and
 * choose a write path on that mistake.
 *
 * - `recorded`: the obligation advanced to `terminal-convergence`.
 * - `not-allocated`: the claim is current, but no allocation is known for the
 *   attempt. Prove absence instead of claiming termination.
 * - `stale`: the claim no longer matches durable ownership.
 * - `resolved`: the attempt has settled, so the operation is closed.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type AllocationTerminationDecision = ProviderOperationMutationDecision | { readonly kind: 'not-allocated' };

/**
 * Durable decision for a compare-and-set allocation reference evolution.
 *
 * - `evolved`: the reference was successfully updated.
 * - `stale`: the caller's view is out of date — either `currentRef` does not
 *   match the stored reference, or the claim no longer matches durable
 *   ownership. `storedRef` carries the current reference when one exists.
 * - `resolved`: the attempt has settled; the operation is closed.
 * - `not-allocated`: the attempt has no allocation to evolve.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type AllocationRefEvolutionDecision =
  | { readonly kind: 'evolved' }
  | { readonly kind: 'stale'; readonly storedRef: ProviderAllocationRef | null }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-allocated' }
  | { readonly kind: 'not-found' };

/** Durable decision for an attempt that failed before provider provisioning began. */
export type PendingAttemptAbandonmentDecision =
  | { readonly kind: 'abandoned' }
  | { readonly kind: 'already-abandoned' }
  | { readonly kind: 'already-settled' }
  | { readonly kind: 'allocated' }
  | { readonly kind: 'provisioning' }
  | { readonly kind: 'fenced' };

/**
 * Durable outcome decision returned by {@link ExecutionAttemptRepository.commitOutcome}.
 *
 * - `accepted`: the outcome was committed as canonical for the first time.
 *   The stored text decoded is reported, never the caller's copy of it.
 * - `duplicate`: an outcome whose durable text {@link sameDurableOutcome}
 *   judges identical to the committed one was submitted again; this is a
 *   replay. The committed outcome is reported, never the caller's copy of it.
 * - `conflict`: the attempt already reached a different terminal state — either
 *   a different committed outcome, or a competing terminal transition that
 *   settled it without one.
 * - `fenced`: the attempt is no longer the active attempt for this execution.
 *
 * Both settling kinds carry `text`: the durable text the attempt holds for
 * this outcome. For `accepted` that is the text the commit just wrote; for
 * `duplicate` it is the text the earlier commit wrote, which is not
 * necessarily the retry's own rendering — {@link sameDurableOutcome} judges
 * two texts the same outcome while member order, and anything else a codec
 * may render differently, still differs between them. A caller that needs a
 * copy of the committed outcome nobody else has held decodes this text
 * through {@link ExecutionAttemptRepository.decodeOutcome}; decoding its own
 * submission's text instead would hand out the retry's representation rather
 * than the committed one.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export type ExecutionAttemptOutcomeDecision<TOutcome> =
  | { readonly kind: 'accepted'; readonly outcome: TOutcome; readonly text: string }
  | { readonly kind: 'duplicate'; readonly outcome: TOutcome; readonly text: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'fenced' };

// ─────────────────────────────────────────────────────────────
// Runtime and operation control decisions
//
// `registerRuntime` and `admitOperation` evaluate every refusal below in one
// fixed order:
//
//   not-found -> resolved -> fenced -> not-allocated
//     -> operation-active -> gate-closed -> not-ready -> stale-generation
//
// It is fixed rather than left to each realization because the answers are not
// interchangeable: they tell a caller different things to do next, and two
// stores reporting different ones for the same durable state would make the
// caller's behaviour depend on which store it was configured with. The order
// runs from statements about whether the attempt is a place work may happen at
// all, through statements about what is happening there now, to statements
// about the caller's own view being out of date.
//
// One consequence is worth naming: a settled attempt that still carries a
// leftover active operation answers `resolved`, never `operation-active`. The
// operation is deliberately left in place by every terminal settlement, so
// without the fixed order a late caller would be told to wait for an operation
// nothing will ever complete.
//
// The idempotent replay answers sit inside that order rather than beside it.
// `duplicate` is decided once the attempt itself has been judged reachable —
// after `not-allocated`, before `operation-active` — because a replay has to be
// answerable while the very operation the first call started is still running.
// ─────────────────────────────────────────────────────────────

/**
 * Durable decision for registering a runtime incarnation as an attempt's
 * endpoint.
 *
 * - `registered`: the incarnation now owns the attempt's runtime endpoint at
 *   `runtimeGeneration`, and everything it later presents must carry that
 *   generation. Readiness starts unproven.
 * - `duplicate`: the attempt already holds exactly this incarnation. The
 *   report is a replay, so the stored generation is reported unchanged
 *   together with the readiness that generation has — `runtimeReadyAt` is
 *   `null` when readiness was not proven yet, and an instant when it was,
 *   which is what lets a caller tell "register again" from "already ready"
 *   without a second read.
 * - `not-found`: no such attempt, or it does not belong to the named owner.
 * - `resolved`: the attempt has settled, so it will never run anything again.
 * - `fenced`: the attempt is no longer the active attempt for its owner.
 * - `not-allocated`: no allocation is recorded, or the recorded one is durably
 *   confirmed terminated and only awaits its settlement, so there is no
 *   infrastructure a runtime could be the endpoint of.
 * - `operation-active`: a workload operation is running against the current
 *   generation. Registering would fence it mid-flight, so the reported
 *   operation must complete first. A `runtime-probe` left active is not in the
 *   way: the probe is the authority's own proof of an endpoint, and one that
 *   was never completed belongs to a handshake that died. Registration
 *   reclaims it in the same write that allocates the new generation, so a
 *   crashed handshake cannot block the attempt's next incarnation.
 */
export type RuntimeRegistrationDecision =
  | { readonly kind: 'registered'; readonly runtimeGeneration: number }
  | { readonly kind: 'duplicate'; readonly runtimeGeneration: number; readonly runtimeReadyAt: string | null }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'not-allocated' }
  | { readonly kind: 'operation-active'; readonly operationId: string };

/**
 * Durable decision for admitting one operation through an attempt's start gate.
 *
 * - `admitted`: the operation now occupies the attempt, under the reported
 *   identifier and fenced against the reported generation.
 * - `duplicate`: an operation admitted under the same `admissionKey` is already
 *   the active one. The retry receives that operation's identifier and the
 *   generation it was admitted under rather than a second admission.
 * - `not-found`: no such attempt, or it does not belong to the named owner.
 * - `resolved`: the attempt has settled.
 * - `fenced`: the attempt is no longer the active attempt for its owner.
 * - `not-allocated`: no allocation is recorded, or the recorded one is durably
 *   confirmed terminated and only awaits its settlement, so there is nothing
 *   to run on.
 * - `operation-active`: a different operation already occupies the attempt.
 * - `gate-closed`: the attempt was superseded or settled, so it will never
 *   admit another operation. Distinct from `fenced` and `resolved` because the
 *   gate is the durable fact, and the two of them are how it came to be closed.
 * - `not-ready`: readiness has not been proven for the current generation.
 *   Every kind but `runtime-probe` waits for it — the probe is precisely what
 *   proves readiness, so it cannot require it.
 * - `stale-generation`: the caller fenced against a generation the attempt has
 *   moved past. The current generation is reported so the caller can re-fence
 *   rather than re-read.
 * - `preparation-required`: Invocation requires a Workspace but no Preparation
 *   receipt belongs to the current runtime generation.
 * - `preparation-not-required`: the assignment does not request a Workspace.
 * - `preparation-already-completed`: Preparation succeeded for this generation;
 *   a fresh admission key must not run setup again.
 */
export type OperationAdmissionDecision =
  | {
      readonly kind: 'admitted';
      readonly operationId: string;
      readonly runtimeGeneration: number;
      /** ISO-8601 instant the admission was recorded at. */
      readonly admittedAt: string;
    }
  | {
      readonly kind: 'duplicate';
      readonly operationId: string;
      readonly runtimeGeneration: number;
      /** ISO-8601 instant the first pass recorded the admission at. */
      readonly admittedAt: string;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'not-allocated' }
  | { readonly kind: 'operation-active'; readonly operationId: string }
  | { readonly kind: 'gate-closed' }
  | { readonly kind: 'not-ready' }
  | { readonly kind: 'preparation-required' }
  | { readonly kind: 'preparation-not-required' }
  | { readonly kind: 'preparation-already-completed' }
  | { readonly kind: 'stale-generation'; readonly runtimeGeneration: number };

/**
 * Durable decision for completing the operation an attempt currently runs.
 *
 * - `completed`: the operation was the active one and the attempt is idle
 *   again.
 * - `duplicate`: this operation was already completed. A replay, answered from
 *   {@link AttemptControlState.lastCompletedOperationId} rather than from an
 *   active operation that is by then gone.
 * - `result-required`: Preparation must submit its semantic report, and generic
 *   Invocation must submit its terminal outcome, instead of merely freeing the slot.
 * - `mismatch`: a different operation occupies the attempt. The active one is
 *   reported, because the caller's next move depends on which it is.
 * - `not-active`: no operation occupies the attempt and this one is not the
 *   last completed one, so the caller is completing something that never ran.
 * - `stale-generation`: the completion is fenced against an older generation
 *   than the operation it names, so it comes from a superseded runtime.
 * - `resolved`: the attempt has settled. Reported ahead of `not-active`
 *   because a terminal settlement leaves the active operation in place
 *   precisely so a late completion learns why nobody is waiting for it.
 * - `not-found`: no such attempt.
 */
export type OperationCompletionDecision =
  | { readonly kind: 'completed' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'result-required' }
  | { readonly kind: 'mismatch'; readonly activeOperationId: string }
  | { readonly kind: 'not-active' }
  | { readonly kind: 'stale-generation' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording that a registered runtime proved itself ready.
 *
 * Evaluated in this order, in both realizations:
 * `not-found → resolved → fenced → not-allocated → stale-generation → duplicate → operation-active`.
 *
 * - `ready`: readiness is now durable for the fenced generation, at the
 *   reported instant.
 * - `duplicate`: readiness was already recorded for this generation. The
 *   instant reported is the stored one, not the caller's, so two callers
 *   converge on one answer.
 * - `operation-active`: an operation occupies the attempt. Readiness is a
 *   statement about an idle runtime, and recording it under a running
 *   operation would claim a proof nothing performed.
 * - `stale-generation`: the caller fenced against a generation the attempt has
 *   moved past, so the readiness it proved belongs to a runtime that is gone.
 * - `not-allocated`: no allocation is recorded, or the recorded one is durably
 *   confirmed terminated and only awaits its settlement. A probe completed on
 *   a dead allocation proves nothing that can be announced.
 * - `fenced`: the attempt is no longer the active attempt for its owner. Its
 *   generation may still match, but a superseded attempt has no current
 *   endpoint to declare ready.
 * - `resolved`: the attempt has settled.
 * - `not-found`: no such attempt for the given execution.
 */
export type RuntimeReadinessDecision =
  | { readonly kind: 'ready'; readonly acceptedAt: string }
  | { readonly kind: 'duplicate'; readonly acceptedAt: string }
  | { readonly kind: 'operation-active'; readonly operationId: string }
  | { readonly kind: 'stale-generation' }
  | { readonly kind: 'not-allocated' }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-found' };

// ─────────────────────────────────────────────────────────────
// Injected Port
// ─────────────────────────────────────────────────────────────

/**
 * Passive injected port for durable execution attempt persistence.
 *
 * The port owns decision semantics, including refusal and replay precedence;
 * the consuming host owns their atomic realization. The shared pure runtime
 * evaluators report non-write decisions or null to attempt a guarded write.
 * They never replace transactional reads, conditional writes, affected-row
 * checks, or re-evaluation after contention. The Authority service calls
 * through this port but never owns the underlying tables or storage.
 *
 * The port owns two related records per attempt: canonical attempt state, and
 * the fenced provider operation that tracks who may act on the attempt's
 * infrastructure. Two rules follow from that split and bind every
 * implementation:
 *
 * 1. **The state machine is repository-owned.** No mutation accepts an
 *    obligation, and no caller can choose one. The stored obligation moves
 *    only along the transitions below, never backwards:
 *
 * ```text
 * begin                       => provisioning-resolution
 * record allocation/discovery => allocation-control
 * record confirmed absence    => settled(abandoned) + operation closed
 * prove provisioner loss      => settled(abandoned) + operation closed
 * record termination          => terminal-convergence
 * infrastructure failure CAS  => settled(infrastructure-failure) + closed
 * uncertainty                 => retain current obligation
 * ```
 *
 *    The two pre-allocation closers are deliberately separate. Confirmed
 *    absence is a provider's positive conclusion that nothing was created;
 *    proven provisioner loss is a host's positive conclusion that nothing
 *    survives. Neither is expressible as the other, and neither is implied by
 *    an expired lease.
 *
 *    The table is also read downwards as a precondition: each transition is
 *    reachable only from the obligation the line above it establishes. One
 *    case is worth naming because it spans two calls rather than one.
 *    {@link recordInfrastructureFailure} is reachable **only** from
 *    `terminal-convergence`, so an allocated attempt reaches
 *    `settled(infrastructure-failure)` exclusively by first confirming
 *    termination through {@link recordAllocationTerminated}. An
 *    implementation that settles straight out of `allocation-control` would
 *    let a caller assert that infrastructure ended without ever recording the
 *    evidence that it did, and the settlement is irreversible.
 *
 * 2. **Provider-side evidence is claim-fenced; the worker outcome is not.**
 *    Every provider-side mutation requires the current generation and token.
 *    {@link commitOutcome} deliberately requires neither, so a worker can
 *    always deliver its canonical answer.
 *
 * 3. **An attempt starts work through one gate, and the gate closes for
 *    good.** {@link AttemptControlState.operationStartGate} is the single
 *    durable ordering point between "this attempt may still run something" and
 *    "it never will again". It opens at {@link createAttempt} and closes
 *    exactly twice over an attempt's life, both times inside the transaction
 *    that made the closing true: on the attempt a newer {@link createAttempt}
 *    supersedes, and on the attempt a terminal settlement settles. Closing it
 *    anywhere else, or reopening it, would let work begin on an attempt whose
 *    answer is already fixed.
 *
 *    The gate orders admission only. It never gates {@link commitOutcome}: a
 *    settled attempt closes its gate and *keeps* its active operation, so a
 *    worker's canonical answer and a late completion both still find the state
 *    that explains them.
 *
 *    The runtime fence beside it is monotonic in the same one-way sense.
 *    {@link registerRuntime} allocates each generation, refuses while an
 *    operation is active, and clears readiness when it advances — so a
 *    generation always names one incarnation, and readiness always names one
 *    generation.
 *
 *    Every refusal these transitions report is evaluated in one fixed order,
 *    stated with {@link RuntimeRegistrationDecision} and
 *    {@link OperationAdmissionDecision}. A realization that reorders it is
 *    non-conforming.
 *
 * An operation stays remediable after its attempt stops being the active
 * attempt for its execution. Claim-fenced discovery, absence, cleanup, and
 * terminal convergence may update such an attempt and close its operation,
 * but must never change which attempt is active, reactivate it, or make it
 * bootstrap-claimable.
 *
 * **Timestamps this port orders are instants, not strings.** Every ISO-8601
 * value the port itself compares or sorts by — lease deadlines, takeover
 * observation times, claim expiry, creation time — is stored canonically UTC
 * with millisecond precision, exactly the form `Date.prototype.toISOString`
 * produces (`YYYY-MM-DDTHH:mm:ss.sssZ`). An implementation normalizes those to
 * that form before storing them, and orders them as instants. A store with
 * native temporal types therefore compares the same way a lexicographic
 * comparison of the canonical form does, and an offset-bearing or
 * second-precision input can never silently mis-order a lease.
 *
 * `BoundedRecoveryEvidence.observedAt` is deliberately outside that rule. The
 * port never orders by it: evidence is retained and reported, never compared.
 * It is a public contract value its producer authored — commonly a provider
 * describing an instant in the zone its own infrastructure reported — and
 * `BoundedRecoveryEvidenceSchema` accepts a numeric offset on purpose. An
 * implementation therefore stores evidence exactly as validated and reports it
 * back verbatim, rewriting no field of it. Normalizing it would silently
 * change a value the producer asserted, and would make two conforming
 * implementations disagree on what a provider said.
 *
 * Durable records carry only JSON-safe, non-secret values: credential
 * references and bounded recovery evidence, never plaintext credentials,
 * stack traces, or raw provider responses.
 *
 * **Input validation precedes every durable decision.** Bounded recovery
 * evidence supplied to a mutation is validated against
 * `BoundedRecoveryEvidenceSchema` before ownership, execution membership, or
 * attempt state is consulted. Evidence that violates the contract is a caller
 * bug, not an outcome, so it is rejected rather than answered with a decision
 * — including when the caller's claim is also stale. Validating after the
 * guards would make the rejection depend on ownership, so the same malformed
 * payload would throw against one implementation and return `stale` from
 * another. Submitted outcomes follow the same rule through the injected
 * {@link OutcomeCodec}: `parse` runs before the durable outcome decision. A
 * committed outcome is always a defined value — a nullish outcome is outside
 * this port, because "no outcome committed" is itself recorded as the absence
 * of a stored value and the two would be indistinguishable.
 *
 * **The codec's durable text is what an attempt holds, and it is rendered
 * exactly once per submission.** {@link canonicalizeOutcome} produces the
 * {@link DurableOutcome} — the text to persist and the outcome that text
 * reads back as — and {@link commitOutcome} receives that rendering rather
 * than a raw value, persisting `text` verbatim. What an attempt reports is
 * therefore never the submitter's copy, which a normalizing codec makes a
 * different value, and never a second serialization, which a codec whose
 * serialization is not a fixed point makes a different text. Every later
 * decision about that outcome is made on the stored text or on the value it
 * yields: {@link commitOutcome} compares a retry's rendered text against the
 * stored one through {@link sameDurableOutcome}.
 *
 * **Every stored outcome is parsed before it decides anything.** An
 * implementation that finds a committed text takes it through `parse` ahead
 * of the duplicate-or-conflict decision, not only on the branch that reports
 * a value. A text the codec rejects is broken durable state — corruption, or
 * a codec changed under an existing row — and it fails loudly rather than
 * reaching the caller as an ordinary competing outcome. For the same reason
 * an outcome is decoded on every read instead of being handed out as one
 * shared instance: a codec may reconstruct a mutable object — one that no
 * freeze even reaches, or that cannot be frozen at all — and one reader
 * mutating it must not change what the next read reports.
 * {@link decodeOutcome} is that read, stated on the port so a caller holding
 * only a durable text can perform it too.
 *
 * **An `accepted` decision reports that same fresh decode of the text it just
 * stored**, not the outcome half of the rendering it was handed. The two are
 * one value only until someone touches it: a caller validates
 * {@link DurableOutcome.outcome} before the commit, and a mutable outcome it
 * changed there would otherwise be reported back as the committed one — a
 * value no reload of the attempt ever yields.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface ExecutionAttemptRepository<TOutcome> {
  /**
   * Persist a new execution attempt record.
   *
   * Called by the Authority before dispatch. The Authority owns
   * `executionAttemptId` generation; the repository only persists. The new
   * attempt atomically becomes the active attempt for its execution.
   * The instruction is validated and snapshotted before any write. It remains
   * immutable for the attempt's lifetime; no owner-context lookup may replace it.
   * The explicit bootstrap budget must be a positive safe integer whose sum with
   * the single creation instant is a representable Date. Validate it before any
   * mutation, and persist createdAt and bootstrapDeadlineAt from that same instant.
   * Later host policy changes never extend an existing attempt's deadline.
   *
   * The new attempt starts with its {@link AttemptControlState} at rest:
   * generation `0`, no incarnation, no readiness, no active operation, and
   * {@link AttemptControlState.operationStartGate} `open`.
   *
   * **The attempt it supersedes has its start gate closed in this same
   * transaction**, alongside the active pointer moving. A superseded attempt
   * whose gate stayed open could admit an operation between the pointer move
   * and any later cleanup, which is work begun on an attempt nobody addresses
   * any more. The pointer and the gate therefore become true together or not
   * at all.
   *
   * `executionAttemptId` is unique for all time. Creating an attempt whose
   * identifier already exists is a caller bug and is rejected — never
   * answered with a decision and never applied. There is no correct way to
   * apply it: the identifier may name an attempt that already owns provider
   * infrastructure, a committed outcome, or a terminal settlement, and a
   * fresh `pending` record in its place would discard all three while
   * orphaning the operation beside it.
   *
   * The rejection is a {@link DuplicateExecutionAttemptError}, whichever way
   * the realization detected the collision. Detecting it by reading first and
   * detecting it from a unique-constraint violation are both conforming — the
   * second is the only race-free option on a store that does not serialize
   * writers — but a realization that lets the driver's own error escape would
   * make the same caller bug indistinguishable from a storage fault, and
   * distinguishable only by message text between one realization and another.
   * @param input - Attempt identity and immutable assignment to persist.
   * @returns The created attempt record.
   * @throws A {@link DuplicateExecutionAttemptError} when an attempt with the same `executionAttemptId` already exists.
   */
  createAttempt(input: ExecutionAttemptCreate): Promise<ExecutionAttemptRecord>;

  /**
   * Read owner matching, settlement, active pointer, allocation, terminal provider
   * state, start gate and immutable deadline in one coherent observation. This is
   * a required bootstrap port, not a recovery capability. It must not decode the
   * instruction, Preparation receipts or outcome to answer the narrow lookup.
   * Legacy records without a deadline remain readable with a null deadline; only
   * fresh bootstrap is refused, never unrelated reads or already-running work.
   * @param input - Trusted owner and attempt identity.
   * @returns The coherent state, or null for a missing attempt or mismatched owner.
   */
  readBootstrapStartState(input: ReadBootstrapStartStateInput): Promise<BootstrapStartState | null>;

  /**
   * Read the frozen instruction of an owner-matching attempt, including historical attempts.
   * The returned snapshot must not allow mutation of the persisted assignment.
   * @param input - Attempt and owner identity.
   * @returns The original assignment, or null when the attempt does not belong to the owner.
   */
  getInstruction(input: GetInstructionInput): Promise<ExecutionAttemptInstruction | null>;

  /**
   * Accept Preparation and release its active slot in one durable transition.
   * Historical identical reports return their original binding without restoring readiness.
   * Conflicting reports preserve the first accepted result. Neither success nor replay
   * settles the attempt; terminal failures use the canonical outcome boundary.
   * @param input - Successful Preparation report and trusted owner identity.
   * @returns Durable acceptance, historical duplicate, or refusal.
   */
  reportOperation(input: ReportOperationInput): Promise<OperationReportDecision>;

  /**
   * Claim the durable provisioning phase immediately before a provider call.
   *
   * This is the sole authorization for invoking a provider, and it succeeds at
   * most once per attempt. The same transaction binds the provider, allocation
   * lifetime, and provisioner incarnation immutably, and opens the attempt's
   * provider operation at generation 1 with a fresh token.
   * @param input - Attempt identity, immutable provider binding, and initial claim context.
   * @returns The durable provisioning ownership decision.
   */
  beginProvisioning(input: BeginProvisioningInput): Promise<ProvisioningClaimDecision>;

  /**
   * Read the current provider operation for an attempt.
   * @param executionAttemptId - Attempt whose operation to read.
   * @returns The ownership record, or `null` when provisioning never began.
   */
  getProviderOperation(executionAttemptId: string): Promise<ProviderOperationOwnershipRecord | null>;

  /**
   * Extend the lease of a currently held provider operation.
   *
   * Preserves the generation and token: renewal is not a new claim, so it
   * cannot fence anyone.
   * @param input - Current claim and the new lease deadline.
   * @returns The durable claim decision.
   */
  renewProviderOperationClaim(input: RenewProviderOperationClaimInput): Promise<ProviderOperationClaimDecision>;

  /**
   * Take ownership of an unowned or lease-expired provider operation.
   *
   * Succeeds only when the operation is unowned or its lease has expired at
   * `observedAt`. On success the generation increments and a fresh token is
   * issued, which fences every previously issued claim immediately. The
   * obligation and accumulated evidence are preserved.
   * @param input - Attempt identity, requesting owner, observation time, and lease deadline.
   * @returns The durable claim decision.
   */
  takeOverProviderOperation(input: TakeOverProviderOperationInput): Promise<ProviderOperationClaimDecision>;

  /**
   * Release a held provider operation without resolving it.
   *
   * Atomically verifies the generation and token, preserves both the
   * generation and the obligation, then clears owner, token, and lease.
   * Clearing the token fences the released claim immediately. Because the
   * record is then unowned, takeover may claim it without waiting for the old
   * lease; that claim increments the generation and receives a new token.
   * @param input - Claim being released and optional bounded release evidence.
   * @returns The durable mutation decision.
   */
  handoffProviderOperation(input: HandoffProviderOperationInput): Promise<ProviderOperationMutationDecision>;

  /**
   * Record that a provider observation stayed inconclusive.
   *
   * Retains the current obligation and increments the bounded failure total.
   * Uncertainty never terminalizes an attempt: an ambiguous provider result
   * is not evidence that nothing was created.
   * @param input - Claim and bounded evidence describing the retained uncertainty.
   * @returns The durable mutation decision.
   */
  recordProviderOperationUncertainty(
    input: RecordProviderOperationUncertaintyInput,
  ): Promise<ProviderOperationMutationDecision>;

  /**
   * Record the provider allocation reference for a claimed operation.
   *
   * Called immediately after a provider successfully provisions a resource.
   * Advances the obligation to `allocation-control` and, for the active
   * attempt, marks it bootstrap-claimable. Idempotent for an identical
   * reference.
   *
   * The implementation verifies, inside the same transaction as the write and
   * before any mutation, that the reference names the attempt's immutable
   * `providerId`. Nothing in {@link AllocationRecordingDecision} can report a
   * foreign reference, so a mismatch is a caller bug and is rejected rather
   * than answered — and rejected whatever the claim's state, exactly as
   * malformed evidence is.
   * @param input - Claim and the validated allocation reference.
   * @returns The durable allocation ownership decision.
   * @throws When the reference names a provider other than the attempt's own.
   */
  recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision>;

  /**
   * Record positively proven absence of any allocation for the attempt.
   *
   * The atomic terminal CAS for the pre-allocation case: it stores bounded
   * absence evidence, settles the attempt as `abandoned`, and closes the
   * operation in one transaction. It never produces `terminal-convergence` —
   * that obligation is reserved for a known allocation whose termination was
   * already confirmed.
   * @param input - Claim, owning execution, and bounded absence evidence.
   * @returns The durable absence decision.
   */
  recordProvisioningAbsent(input: RecordProvisioningAbsentInput): Promise<ProvisioningAbsenceDecision>;

  /**
   * Close pre-allocation debt on proof that a provisioner incarnation is gone.
   *
   * The atomic terminal CAS for an attempt whose allocation could not have
   * outlived its provisioner. It exists because such an attempt has no other
   * reachable terminal state: its provider need not advertise recovery, so
   * there may be nothing to discover, inspect, or terminate, and
   * {@link abandonPendingAttempt} refuses an attempt that already began
   * provisioning.
   *
   * The implementation verifies, inside the same transaction as the write,
   * that the attempt's stored `allocationLifetime` is
   * `provisioner-process-bound` and that its immutable
   * `provisionerIncarnationId` is exactly the one the proof names. Both are
   * immutable facts written by {@link beginProvisioning}, so this is a
   * statement about the attempt rather than about the caller's view of it. An
   * expired lease can never satisfy either check.
   *
   * On success it stores the proof's bounded evidence, settles the attempt as
   * `abandoned`, and closes the operation in one transaction. `abandoned` is
   * the honest kind: no allocation was ever recorded for the attempt, so it
   * cannot have suffered an infrastructure failure in the sense
   * {@link recordInfrastructureFailure} defines.
   * @param input - Claim, owning execution, and the provisioner loss proof.
   * @returns The durable provisioner-loss decision.
   */
  recordProvisionerIncarnationLost(
    input: RecordProvisionerIncarnationLostInput,
  ): Promise<ProvisionerIncarnationLossDecision>;

  /**
   * Record a confirmed infrastructure failure for an allocated attempt.
   *
   * This terminal CAS competes with outcome submission; the first durable
   * transition wins and the loser receives `resolved`. Pre-allocation
   * conclusions must instead use {@link recordProvisioningAbsent}.
   *
   * It is reachable only from `terminal-convergence`. The implementation
   * verifies the stored obligation inside the settling transaction and refuses
   * an operation that still owes `allocation-control` as `not-terminated`, so
   * the evidence that the allocation ended is always durable before the
   * attempt is settled on the strength of it. That makes
   * {@link recordAllocationTerminated} the single entry to terminal
   * settlement, and it is what lets a pass interrupted between the two retry
   * only the settlement.
   * @param input - Claim and the owning execution.
   * @returns The infrastructure failure decision.
   */
  recordInfrastructureFailure(input: RecordInfrastructureFailureInput): Promise<InfrastructureFailureDecision>;

  /**
   * Record that a known allocation was confirmed terminated.
   *
   * The explicit monotonic transition from `allocation-control` to
   * `terminal-convergence`, and the only way an allocated attempt becomes
   * eligible for {@link recordInfrastructureFailure}. It does not settle the
   * attempt and does not increment the failure total: a successful termination
   * is not a failure. An operation that owns no allocation cannot make this
   * transition and is told so as `not-allocated`, distinctly from a fenced
   * claim.
   * @param input - Claim and bounded evidence supporting the termination.
   * @returns The durable termination decision.
   */
  recordAllocationTerminated(input: RecordAllocationTerminatedInput): Promise<AllocationTerminationDecision>;

  /**
   * Register a runtime incarnation as the attempt's endpoint.
   *
   * The repository allocates the generation — the caller supplies only the
   * incarnation identifier, which is both what it is registering and the
   * idempotency key for having registered it. A registration that succeeds
   * advances the generation by exactly one and clears
   * {@link AttemptControlState.runtimeReadyAt}, because the readiness the
   * previous incarnation proved says nothing about this one.
   *
   * It refuses while an operation is active. Advancing the generation there
   * would fence a running operation's own completion, so the reported
   * operation has to finish first — and this is why a replay by the incarnation
   * that is already registered is answered `duplicate` ahead of that refusal:
   * the operation in the way is frequently the very probe that registration
   * started.
   *
   * The refusal order is the fixed one; see {@link RuntimeRegistrationDecision}.
   * @param input - Attempt identity, owning execution, and the runtime incarnation.
   * @returns The durable registration decision.
   */
  registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRegistrationDecision>;

  /**
   * Admit one operation through the attempt's start gate.
   *
   * At most one operation occupies an attempt at a time, and the repository
   * mints its identifier. `admissionKey` is what makes a retry answerable: a
   * second admission presenting the key the active operation was admitted
   * under receives that operation's identifier rather than a second slot.
   *
   * Every kind requires proven readiness except `runtime-probe`, which is
   * admitted while {@link AttemptControlState.runtimeReadyAt} is still `null` —
   * the probe is the bounded no-op that *proves* the endpoint, so requiring
   * readiness of it would make readiness unreachable.
   *
   * The refusal order is the fixed one; see {@link OperationAdmissionDecision}.
   * @param input - Attempt identity, owning execution, kind, idempotency key, and fence.
   * @returns The durable admission decision.
   */
  admitOperation(input: AdmitOperationInput): Promise<OperationAdmissionDecision>;

  /**
   * Release the attempt's active operation.
   *
   * Clears the four active-operation members in one write and records the
   * completed identifier, so a replay is answered `duplicate` rather than
   * mistaken for a completion of something that never ran.
   *
   * Deliberately unfenced by the active-attempt pointer: a superseded attempt
   * owes the release exactly as much as an active one, and refusing it would
   * leave the operation occupying the attempt for good.
   * @param input - Attempt identity, the operation being completed, and its fence.
   * @returns The durable completion decision.
   */
  completeOperation(input: CompleteOperationInput): Promise<OperationCompletionDecision>;

  /**
   * Record that the registered runtime proved itself ready.
   *
   * Written only for the generation the caller fences against, so a proof that
   * a superseded incarnation produced can never mark the current one ready, and
   * only while the attempt is still the active attempt for its owner, so a
   * proof that completed before the attempt was superseded is refused `fenced`
   * rather than announced for an endpoint nobody will address. Recording is
   * idempotent: a second call for the same generation reports the instant
   * already stored, never the caller's own.
   * @param input - Attempt identity, the generation the proof belongs to, and when it was observed.
   * @returns The durable readiness decision.
   */
  markRuntimeReady(input: MarkRuntimeReadyInput): Promise<RuntimeReadinessDecision>;

  /**
   * Read an attempt's runtime and operation control state.
   *
   * The recovery read of {@link AttemptControlState}: a process that lost its
   * own memory of an attempt — a restart, a second controller — asks what the
   * durable state is instead of inferring it. Unfenced and regardless of
   * status, exactly like
   * {@link ExecutionAttemptRecoveryOperations.getAttemptWithAllocation}, because
   * the state of a superseded or settled attempt is precisely what a recovering
   * process needs to see.
   * @param executionAttemptId - Attempt whose control state to read.
   * @returns The control state, or `null` when no such attempt exists.
   */
  getAttemptControlState(executionAttemptId: string): Promise<AttemptControlState | null>;

  /**
   * Retrieve the active attempt for a given execution.
   *
   * Returns `null` when the attempt does not exist or has been superseded
   * (fenced) by a newer attempt for the same execution.
   * @param executionId - Owner identifier the attempt belongs to.
   * @param executionAttemptId - Attempt identifier to look up.
   * @returns The attempt record if active, or `null`.
   */
  getActiveAttempt(executionId: ExecutionOwnerId, executionAttemptId: string): Promise<ExecutionAttemptRecord | null>;

  /**
   * Render a submission as the durable fact a commit of it would write.
   *
   * **The port renders an outcome exactly once, and this is where.** A
   * realization stores the codec's durable text and reports what a reload of
   * that text yields, so the value an owner converges on is not in general
   * the value the submitter handed in — a codec may normalize while
   * serializing. This member produces both halves of that fact together,
   * without committing anything, so a caller can validate the outcome it will
   * actually receive and then hand the very same rendering to
   * {@link commitOutcome}.
   *
   * Carrying the rendering rather than re-deriving it is what closes the gap
   * between the two calls: the submitter's object is read once, so neither a
   * mutation of it nor a second serialization can make the committed outcome
   * differ from the validated one.
   *
   * Synchronous and free of durable effects: it consults the injected
   * {@link OutcomeCodec} and nothing else — {@link durableOutcome} is the
   * rendering rule, and a realization has no freedom to deviate from it.
   * @param outcome - Outcome a caller is about to submit.
   * @returns The text a commit would persist and the outcome that text yields.
   * @throws When the codec rejects the outcome or its own durable text.
   */
  canonicalizeOutcome(outcome: TOutcome): DurableOutcome<TOutcome>;

  /**
   * Read a committed durable text back as the outcome it holds.
   *
   * The counterpart of {@link canonicalizeOutcome}: that member says what a
   * commit writes, this one says what a read of that text yields. Both are
   * the codec's rules rather than a realization's, so
   * {@link decodeDurableOutcome} is the rendering and a realization has no
   * freedom to deviate from it.
   *
   * It exists because the durable text is the only copy of an outcome nobody
   * can have touched. Every value the port hands out is decoded from it, and
   * a caller that has passed one on — to an owner validation, to convergence
   * — and needs the committed outcome again asks for a fresh decode instead
   * of reusing a value some other step may have mutated. Each call returns
   * its own value; a mutation of one changes nothing the next one reports.
   *
   * Synchronous and free of durable effects: the caller supplies the text.
   * @param text - Durable text an attempt committed, as {@link DurableOutcome.text} carries it.
   * @returns The outcome that text holds, held by nobody else.
   * @throws When the text is not JSON, or not JSON the codec accepts.
   */
  decodeOutcome(text: string): TOutcome;

  /**
   * Commit a terminal outcome for an attempt.
   *
   * Deliberately claim-independent: a worker's canonical answer never depends
   * on who currently owns the attempt's provider operation. A successful
   * commit settles the attempt and closes its operation.
   *
   * The repository makes the durable decision in exactly this precedence
   * order. An implementation that reorders it is non-conforming, because each
   * step is only reachable once every earlier one has been ruled out:
   *
   * 1. `fenced` — the attempt is no longer the active attempt for its
   *    execution. Evaluated first because `accepted` and `duplicate` oblige
   *    the caller to converge owner state, and a superseded attempt must
   *    never drive that convergence.
   * 2. `duplicate` / `conflict` — an outcome is already committed for this
   *    attempt: `duplicate` when {@link sameDurableOutcome} judges the text
   *    the submission would commit canonically equal to the stored one,
   *    including member-order-insensitive objects; `conflict` when it differs
   *    under that rule.
   * 3. `conflict` — a competing terminal transition already settled the
   *    attempt without committing an outcome, that is
   *    {@link recordInfrastructureFailure} or
   *    {@link recordProvisioningAbsent} or
   *    {@link recordProvisionerIncarnationLost}. That transition won the
   *    terminal CAS, so a late outcome may neither overwrite its
   *    `settlementKind` nor reopen the attempt.
   * 4. When supplied, `runtimeFence` must still match the current runtime
   *    generation and operation (including its generation). A mismatch throws
   *    {@link RuntimeOutcomeFenceMismatchError} without changing the attempt.
   *    Checking this in the same write prevents owner decoding/validation awaits
   *    from committing a startup failure against a replacement runtime.
   * 5. `accepted` — the outcome becomes canonical, the attempt settles as
   *    `outcome`, and its operation closes.
   *
   * The submission arrives already rendered, as the {@link DurableOutcome} the
   * caller obtained from {@link canonicalizeOutcome}. An implementation
   * persists `result.text` verbatim and never re-serializes: a second
   * rendering is what would let the durable answer differ from the one the
   * owner validated. What it reports for `accepted` is that text decoded
   * again — {@link decodeOutcome} of `result.text` — rather than
   * `result.outcome`, which the caller has held since before its own
   * validation and may have mutated there.
   *
   * A settling decision also reports the durable text the attempt holds:
   * `result.text` for `accepted`, and the stored text for `duplicate` — the
   * record's own, not the submission's, because the two are the same outcome
   * without being the same text.
   * @param input - Attempt identity and the rendering to commit.
   * @returns The durable decision with the canonical outcome when applicable.
   */
  commitOutcome(input: ExecutionAttemptOutcomeCommit<TOutcome>): Promise<ExecutionAttemptOutcomeDecision<TOutcome>>;

  /**
   * Settle a pending attempt when dispatch cannot continue before provisioning.
   *
   * The operation is fenced and idempotent. `provisioning` and `allocated`
   * mean provisioning already began, so the caller must converge the provider
   * operation instead of abandoning the attempt.
   * @param executionAttemptId - Pending attempt to abandon.
   * @param executionId - Owner identifier the attempt belongs to.
   * @returns The durable abandonment decision.
   */
  abandonPendingAttempt(
    executionAttemptId: string,
    executionId: ExecutionOwnerId,
  ): Promise<PendingAttemptAbandonmentDecision>;

  /**
   * Recovery operations, present only on a recovery-capable repository.
   *
   * Absent when the repository serves only non-recoverable providers. The
   * Authority reads this one property to decide whether it may delegate, so a
   * repository is either recovery-capable or it is not — there is no partially
   * recoverable repository to reason about.
   */
  readonly recovery?: ExecutionAttemptRecoveryOperations;
}

// ─────────────────────────────────────────────────────────────
// Recovery Operations
// ─────────────────────────────────────────────────────────────

/**
 * Coherent recovery capability of the execution attempt port.
 *
 * Recovery is one indivisible capability: a repository implements all four
 * operations or none. Partial implementation is a type error because all four
 * are required members of this interface, exactly as they are on the provider
 * side of the same capability.
 *
 * The four exist together because a recovery pass needs all of them: it reads
 * a superseded attempt, records what discovery found for it, refines the
 * reference as correlation narrows it, and lists what is still outstanding. A
 * repository that answered three of them would strand the pass at whichever
 * step it omitted, after that pass had already begun acting on infrastructure.
 */
export interface ExecutionAttemptRecoveryOperations {
  /**
   * Look up an attempt by its identifier, regardless of active status.
   *
   * Unlike {@link ExecutionAttemptRepository.getActiveAttempt}, this returns
   * the attempt even if it has been superseded or settled. Used by recovery
   * flows that need to inspect a specific attempt's allocation state.
   * @param executionAttemptId - The attempt to look up.
   * @returns The attempt record, or `null` if no such attempt exists.
   */
  getAttemptWithAllocation(executionAttemptId: string): Promise<ExecutionAttemptRecord | null>;

  /**
   * Record an allocation that provider discovery found for the attempt.
   *
   * Used when a provider call's acknowledgement was lost and an exhaustive
   * lookup later found exactly one matching allocation. It advances the
   * obligation to `allocation-control` exactly like
   * {@link ExecutionAttemptRepository.recordAllocation}, but never marks the
   * attempt bootstrap-claimable and never changes which attempt is active:
   * discovery converges an old attempt, it does not revive it.
   *
   * It enforces the same provider binding as
   * {@link ExecutionAttemptRepository.recordAllocation}, for the same reason: a
   * discovery answer that names another provider describes somebody else's
   * infrastructure.
   * @param input - Claim and the discovered allocation reference.
   * @returns The durable discovered-allocation decision.
   * @throws When the reference names a provider other than the attempt's own.
   */
  recordDiscoveredAllocation(input: RecordAllocationInput): Promise<DiscoveredAllocationDecision>;

  /**
   * Compare-and-set update of the allocation reference for a claimed attempt.
   *
   * Used when provider correlation discovers additional identity after the
   * initial allocation. The `currentRef` must match the stored reference under
   * {@link sameAllocationRef}; if it does not, the update is rejected as stale
   * to prevent lost updates from concurrent correlators.
   *
   * Both `currentRef` and `nextRef` must share the same `providerId`:
   * correlation refines one allocation's opaque `providerData`, it never
   * moves an attempt to a different provider. Nothing in
   * {@link AllocationRefEvolutionDecision} can report such a request, so a
   * mismatched pair is a caller bug and is rejected rather than answered.
   * @param input - Claim, owning execution, and current/next references.
   * @returns The evolution decision.
   * @throws When `currentRef` and `nextRef` name different providers.
   */
  evolveAllocationRef(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision>;

  /**
   * List all recoverable (allocated, non-settled) attempts for an execution.
   *
   * Returns attempts that have a provider allocation, have not settled
   * (no committed outcome or infrastructure failure), and are still eligible
   * for recovery claims. The caller uses these to drive provider inspect and
   * attach flows.
   *
   * Expired claims (past `claimExpiresAt`) are excluded.
   *
   * **Ordering is part of the contract:** attempts are returned oldest first,
   * by `createdAt` as an instant, ties broken by ascending
   * `executionAttemptId`. Recovery reclaims infrastructure in the order it was
   * created, and the tiebreak is what keeps two attempts created within the
   * same millisecond from ordering differently on two stores. An
   * implementation that returned an arbitrary order would make a caller that
   * bounds its pass reclaim a different subset on each realization.
   * @param executionId - Owner identifier the attempts belong to.
   * @returns Allocated, non-settled attempts eligible for recovery, oldest first.
   */
  getRecoverableAttempts(executionId: ExecutionOwnerId): Promise<readonly RecoverableAttemptRecord[]>;
}
