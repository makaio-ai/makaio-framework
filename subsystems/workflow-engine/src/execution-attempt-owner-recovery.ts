/**
 * Shared ingress and settlement rules for owner-request recovery.
 * Stores own atomic observation and mutation; these helpers own value interpretation.
 * @packageDocumentation
 */
import { canonicalStringify } from '@makaio/utils';
import { parseInstruction } from './attempt-value-snapshot.js';
import { decodeDurableOutcome } from './execution-attempt-repository.js';
import type {
  AttemptOutcomeControlObservation,
  DurableOutcome,
  ExecutionAttemptRecord,
  ExecutionOwnerId,
  OutcomeCodec,
} from './execution-attempt-repository.js';
import type { ExecutionAttemptInstruction } from '@makaio/contracts';

/** A durable owner's replayable demand for one immutable assignment. */
export interface EnsureExecutionAttemptInput {
  /** Durable owner whose request-key scope this demand belongs to. */
  readonly executionId: ExecutionOwnerId;
  /** Non-empty opaque key, retained by the owner across retries and restarts. */
  readonly requestKey: string;
  /** Assignment whose validated value must match on every replay. */
  readonly instruction: ExecutionAttemptInstruction;
}

/** Authority-supplied candidate identity and budget for first acceptance only. */
export interface EnsureExecutionAttemptPersistenceInput extends EnsureExecutionAttemptInput {
  /** Fresh candidate; ignored when the request already has an association. */
  readonly executionAttemptId: string;
  /** Positive safe-integer budget; replay preserves the original deadline. */
  readonly bootstrapTimeoutMs: number;
}

/** Request replay never restores historical authority or mutates the attempt. */
export type EnsureExecutionAttemptDecision =
  | { readonly kind: 'created' | 'replayed'; readonly attempt: ExecutionAttemptRecord }
  | { readonly kind: 'conflict' };

/** Trusted owner and exact attempt to observe, including historical attempts. */
export interface ReadAttemptSettlementInput {
  readonly executionId: ExecutionOwnerId;
  readonly executionAttemptId: string;
}

/** Coherent settlement evidence; current-pointer identity is not mutation authority. */
export type AttemptSettlementRead<TOutcome> =
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'unsettled' | 'settled-without-outcome';
      readonly attempt: ExecutionAttemptRecord;
      readonly isCurrentAttempt: boolean;
    }
  | {
      readonly kind: 'outcome';
      readonly attempt: ExecutionAttemptRecord;
      readonly isCurrentAttempt: boolean;
      readonly result: DurableOutcome<TOutcome>;
      /** Original commit-time facts, or null for a legacy outcome lacking that observation. */
      readonly controlObservation: AttemptOutcomeControlObservation | null;
    };

/** Raw facts a realization must read within one coherent store observation. */
export interface AttemptSettlementSnapshot {
  readonly attempt: ExecutionAttemptRecord | null;
  readonly activeAttemptId: string | null;
  readonly outcomeText: string | null;
  /** Stored commit-time observation; never reconstructed from current cancellation state. */
  readonly controlObservation: AttemptOutcomeControlObservation | null;
}

/** Required owner-recovery methods composed into every execution attempt repository. */
export interface OwnerRequestRecoveryRepository<TOutcome> {
  /**
   * Atomically associate an owner request with one attempt, or replay its original association.
   * Snapshot/validate before the first await. First acceptance shares fresh creation's
   * insertion, predecessor fencing and active-pointer transaction with the binding write.
   * An existing binding compares the validated instruction semantically; replay/conflict
   * makes no writes, even after settlement or supersession. A missing or wrong-owner bound
   * attempt is corruption, never permission to create again. Different request keys retain
   * fresh creation semantics; owners must only submit durably authorized demands.
   * @param input - Stable demand plus a candidate identity and host bootstrap budget.
   * @returns Created/replayed detached attempt, or conflict without mutation.
   * @throws DuplicateExecutionAttemptError for a new binding whose candidate ID already exists.
   */
  ensureAttempt(input: EnsureExecutionAttemptPersistenceInput): Promise<EnsureExecutionAttemptDecision>;

  /**
   * Read exact owner-scoped settlement and current-pointer facts in one coherent snapshot.
   * Historical evidence cannot restore mutation authority. Return stored outcome text
   * verbatim with a fresh codec decode; contradictory facts or invalid text throw.
   * @param input - Trusted owner and exact attempt; snapshot before the first await.
   * @returns Detached absent, unsettled, outcome, or settled-without-outcome evidence.
   */
  readAttemptSettlement(input: ReadAttemptSettlementInput): Promise<AttemptSettlementRead<TOutcome>>;
}

/**
 * Validate an opaque identity without trimming or otherwise changing its scope.
 * @param value - Identity supplied by the caller.
 * @param name - Input member to identify on validation failure.
 */
function requireOwnerRequestIdentity(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * Detach and validate an owner's demand before asynchronous storage work begins.
 * @param input - Caller-owned request and assignment.
 * @returns A validated copy without references into caller-owned values.
 */
export function snapshotEnsureExecutionAttemptInput(input: EnsureExecutionAttemptInput): EnsureExecutionAttemptInput {
  const { executionId, requestKey } = input;
  requireOwnerRequestIdentity(executionId, 'executionId');
  requireOwnerRequestIdentity(requestKey, 'requestKey');
  return {
    executionId,
    requestKey,
    instruction: parseInstruction(input.instruction),
  };
}

/**
 * Validate first-acceptance parameters without calculating an unused replay deadline.
 * @param input - Authority-owned demand, candidate identity and current host budget.
 * @returns Detached input to retain before the first await.
 */
export function snapshotEnsureExecutionAttemptPersistenceInput(
  input: EnsureExecutionAttemptPersistenceInput,
): EnsureExecutionAttemptPersistenceInput {
  const { executionAttemptId, bootstrapTimeoutMs } = input;
  requireOwnerRequestIdentity(executionAttemptId, 'executionAttemptId');
  if (!Number.isSafeInteger(bootstrapTimeoutMs) || bootstrapTimeoutMs <= 0) {
    throw new RangeError('bootstrapTimeoutMs must be a positive safe integer');
  }
  return { ...snapshotEnsureExecutionAttemptInput(input), executionAttemptId, bootstrapTimeoutMs };
}

/**
 * Retain trusted lookup identity without keeping a mutable input object across awaits.
 * @param input - Owner and exact attempt to observe.
 * @returns Validated identity copy.
 */
export function snapshotReadAttemptSettlementInput(input: ReadAttemptSettlementInput): ReadAttemptSettlementInput {
  const { executionId, executionAttemptId } = input;
  requireOwnerRequestIdentity(executionId, 'executionId');
  requireOwnerRequestIdentity(executionAttemptId, 'executionAttemptId');
  return { executionId, executionAttemptId };
}

/**
 * Decide an existing request binding without changing its historical attempt.
 * @param input - Already validated owner request.
 * @param boundAttempt - Attempt referenced by the existing binding, or null if corrupt.
 * @returns A detached replay or an instruction conflict.
 * @throws When the durable binding references no attempt or another owner.
 */
export function replayEnsuredAttempt(
  input: EnsureExecutionAttemptInput,
  boundAttempt: ExecutionAttemptRecord | null,
): EnsureExecutionAttemptDecision {
  if (boundAttempt === null || boundAttempt.executionId !== input.executionId) {
    throw new Error('Corrupt execution attempt request binding');
  }
  if (canonicalStringify(boundAttempt.instruction) !== canonicalStringify(input.instruction)) {
    return { kind: 'conflict' };
  }
  return { kind: 'replayed', attempt: structuredClone(boundAttempt) };
}

/**
 * Interpret settlement facts without hiding corruption or reserializing committed text.
 * @param input - Already validated trusted owner and exact attempt.
 * @param snapshot - Facts collected by the realization in one coherent observation.
 * @param codec - Owner-specific codec for decoding the original committed text afresh.
 * @returns Detached evidence, never authority to mutate the owner.
 * @throws When settlement facts contradict each other or committed text cannot decode.
 */
export function readAttemptSettlementSnapshot<TOutcome>(
  input: ReadAttemptSettlementInput,
  snapshot: AttemptSettlementSnapshot,
  codec: OutcomeCodec<TOutcome>,
): AttemptSettlementRead<TOutcome> {
  const { attempt, activeAttemptId, outcomeText } = snapshot;
  if (attempt === null || attempt.executionId !== input.executionId) return { kind: 'not-found' };
  if (attempt.executionAttemptId !== input.executionAttemptId) {
    throw new Error('Corrupt execution attempt settlement identity');
  }
  const facts = { attempt: structuredClone(attempt), isCurrentAttempt: activeAttemptId === attempt.executionAttemptId };
  if (attempt.status !== 'settled' && attempt.settlementKind == null && outcomeText === null) {
    return { kind: 'unsettled', ...facts };
  }
  if (attempt.status === 'settled' && attempt.settlementKind === 'outcome' && outcomeText !== null) {
    return {
      kind: 'outcome',
      ...facts,
      result: { text: outcomeText, outcome: decodeDurableOutcome(codec, outcomeText) },
      controlObservation: structuredClone(snapshot.controlObservation),
    };
  }
  if (
    attempt.status === 'settled' &&
    (attempt.settlementKind === 'abandoned' || attempt.settlementKind === 'infrastructure-failure') &&
    outcomeText === null
  ) {
    return { kind: 'settled-without-outcome', ...facts };
  }
  throw new Error('Corrupt execution attempt settlement facts');
}
