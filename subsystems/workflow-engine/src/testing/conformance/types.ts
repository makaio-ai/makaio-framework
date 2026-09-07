import type { ExecutionAttemptRepository, OutcomeCodec } from '../../execution-attempt-repository.js';

/** Narrow fixture input for recovery's oldest-first, identifier-tiebreak ordering contract. */
export interface RecoverableAttemptsSeed {
  /** Owner shared by all candidates created by this fixture. */
  readonly executionId: string;
  /** Fresh candidate identifiers and creation instants, in the insertion order to seed. */
  readonly entries: readonly {
    readonly executionAttemptId: string;
    /** Canonical UTC ISO-8601 instant with millisecond precision. */
    readonly createdAt: string;
  }[];
}

/**
 * One isolated, recovery-capable realization exercised by the conformance suite.
 * @typeParam TOutcome - Owner-specific outcome reconstructed by the injected codec.
 */
export interface ExecutionAttemptRepositoryContractHarness<TOutcome> {
  /** Primary controller exposing the complete repository port, including recovery. */
  readonly repository: Required<ExecutionAttemptRepository<TOutcome>>;
  /** Independent controller sharing the primary controller's durable state. */
  readonly peer: Required<ExecutionAttemptRepository<TOutcome>>;
  /**
   * Replace stored outcome text directly, bypassing validation by the port.
   * This test-only hook represents corrupt durable data or a changed codec;
   * it must not create another attempt or change the active-attempt pointer.
   * @param executionAttemptId - Existing attempt whose outcome text to replace.
   * @param text - Durable outcome text to store verbatim.
   */
  readonly writeStoredOutcomeText: (executionAttemptId: string, text: string) => Promise<void>;
  /**
   * Replace the host-owned bootstrap-claim expiry directly, bypassing the
   * repository port. This fixture hook models the host path that issues
   * bootstrap claims; it must not change any other attempt field.
   * @param executionAttemptId - Existing attempt whose claim expiry to replace.
   * @param claimExpiresAt - Canonical expiry instant, or `null` for no expiry.
   */
  readonly setClaimExpiry: (executionAttemptId: string, claimExpiresAt: string | null) => Promise<void>;
  /**
   * Seed a legacy null bootstrap deadline without changing any other attempt fact.
   * @param executionAttemptId - Existing attempt whose stored bootstrap deadline to clear.
   */
  readonly clearStoredBootstrapDeadline: (executionAttemptId: string) => Promise<void>;
  /**
   * Seed complete allocated, unsettled, claimable candidates with no claim expiry.
   * Preserve the supplied insertion order and creation instants. Include valid
   * provider binding and operation state required by the backend. Unlike ordinary
   * replacement, this testing-only fixture keeps every supplied candidate eligible
   * for recovery after all entries are created; it does not accept arbitrary rows.
   * @param input - One owner and fresh candidate identifiers with canonical creation instants.
   */
  readonly seedRecoverableAttempts: (input: RecoverableAttemptsSeed) => Promise<void>;
  /** Close both controllers and remove resources owned by this harness. */
  readonly dispose: () => void | Promise<void>;
}

/** Configuration passed to the callable Vitest repository conformance suite. */
export interface ExecutionAttemptRepositoryContractFactory {
  /** Realization label included in test names, for example `postgres`. */
  readonly name: string;
  /**
   * Create fresh, isolated storage with two independent controllers.
   * Every call must honor the supplied codec, including non-workflow outcomes.
   * If initialization fails, release partially opened resources before rejecting;
   * the suite can dispose only a harness this factory successfully returns.
   * @param codec - Codec both controllers use to validate and persist outcomes.
   * @returns Initialized harness, owned by the suite until its teardown.
   * @typeParam TOutcome - Owner-specific outcome type for this contract group.
   */
  create<TOutcome>(codec: OutcomeCodec<TOutcome>): Promise<ExecutionAttemptRepositoryContractHarness<TOutcome>>;
}
