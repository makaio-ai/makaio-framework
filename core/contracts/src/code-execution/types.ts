import type { ICapabilityProvider } from '../capability/index.js';
import type { JsonValue } from '../shared/json-value.js';

/** Capability identifier used for CodeExecution providers. */
export const CODE_EXECUTION_CAPABILITY_ID = 'code-execution' as const;

// ─────────────────────────────────────────────────────────────
// Trust Levels
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of every trust level a CodeExecution provider may
 * declare.
 *
 * Source of truth for the {@link CodeExecutionTrustLevel} union, and the enum
 * the requirements schema is built from — `CodeExecutionRequirementsSchema`
 * spells its `trust` field as `z.enum(CODE_EXECUTION_TRUST_LEVELS)`, so adding
 * a level here widens the schema with it.
 */
export const CODE_EXECUTION_TRUST_LEVELS = ['trusted-code-only', 'isolated'] as const;

/**
 * Trust level a CodeExecution provider declares for the code it runs.
 *
 * - `trusted-code-only`: the provider executes code with the privileges of
 *   its host process. Only code the host already trusts may be submitted.
 * - `isolated`: the provider executes code inside an isolation boundary of
 *   its own (e.g. a container or microVM).
 *
 * Requirements may demand a trust level, but demanding one never grants it:
 * whether a provider is available and what it is trusted with is decided by
 * local runtime composition, not by the request.
 */
export type CodeExecutionTrustLevel = (typeof CODE_EXECUTION_TRUST_LEVELS)[number];

// ─────────────────────────────────────────────────────────────
// Prepared Program
// ─────────────────────────────────────────────────────────────

/**
 * Prepared, JSON-safe TypeScript/ESM module set to execute.
 *
 * This is a module-materialization contract: the provider materializes the
 * virtual module set into an ESM program root and imports the entry module
 * from it. The path rules keep that materialization well-defined across
 * provider hosts; they do not create runtime filesystem isolation.
 *
 * Virtual paths use canonical POSIX separators independent of the provider
 * host. Every key of {@link files} — and {@link entryFile} — must be a
 * non-empty, relative, normalized path without `.`/`..` segments,
 * backslashes, empty segments, or NUL bytes.
 */
export interface CodeExecutionProgram {
  /** Virtual module set, keyed by canonical relative POSIX path. */
  readonly files: Readonly<Record<string, string>>;
  /** Virtual path of the entry module. Must name one of {@link files}. */
  readonly entryFile: string;
  /**
   * Name of the export invoked on the entry module (e.g. `'default'`).
   *
   * Bounded in length by the program schema, like every identity string a
   * request carries: no provider budget measures it, and a provider copies it
   * per invocation into whatever runs the program.
   */
  readonly exportName: string;
}

// ─────────────────────────────────────────────────────────────
// Requirements
// ─────────────────────────────────────────────────────────────

/**
 * Optional constraints a request places on provider selection.
 *
 * Every field is an exact-match constraint; omitted fields impose no
 * constraint. Requirements only narrow the set of locally registered
 * providers — they never grant trust and never enable a provider that the
 * host did not compose.
 *
 * Each pin is bounded in length by the requirements schema: a pin longer than
 * any value it could ever match narrows nothing, and is only a larger request
 * to retain.
 */
export interface CodeExecutionRequirements {
  /** Exact provider identifier to pin (matches {@link ICapabilityProvider.id}). */
  readonly providerId?: string;
  /** Required exact runtime tag (matches {@link ICodeExecutionProvider.runtime}). */
  readonly runtime?: string;
  /** Required exact language tag (matches {@link ICodeExecutionProvider.language}). */
  readonly language?: string;
  /** Required exact module format (matches {@link ICodeExecutionProvider.moduleFormat}). */
  readonly moduleFormat?: string;
  /** Required exact trust level (matches {@link ICodeExecutionProvider.trust}). */
  readonly trust?: CodeExecutionTrustLevel;
}

// ─────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────

/**
 * One prepared, JSON-safe invocation routed to one CodeExecution provider.
 */
export interface CodeExecutionRequest {
  /**
   * Caller-supplied identifier correlating this invocation across logs and
   * telemetry. Bounded in length by the request schema.
   */
  readonly invocationId: string;
  /** Prepared virtual TypeScript/ESM module set to execute. */
  readonly program: CodeExecutionProgram;
  /** JSON-safe value passed to the invoked export as its single argument. */
  readonly arguments: JsonValue;
  /** Optional exact-match constraints on provider selection. */
  readonly requirements?: CodeExecutionRequirements;
  /** Wall-clock budget for the execution, in milliseconds. */
  readonly timeoutMs: number;
}

// ─────────────────────────────────────────────────────────────
// Terminal Outcomes
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of every terminal outcome status.
 *
 * Neither the {@link CodeExecutionOutcome} union nor
 * `CodeExecutionOutcomeSchema` is derived from this array: the union names its
 * variant interfaces and the schema spells each discriminant as a `z.literal`,
 * because a discriminated union needs literal discriminants a generated enum
 * cannot supply. What keeps the three in step is a type-level assertion in the
 * contract tests, which requires this array's members to equal
 * `CodeExecutionOutcome['status']` exactly. Adding a status therefore fails
 * that assertion until the union, the schema, and this array all name it.
 */
export const CODE_EXECUTION_OUTCOME_STATUSES = ['completed', 'failed', 'timed_out', 'cancelled'] as const;

/**
 * Ordered constant array of every failure code valid on a `failed` outcome.
 *
 * These are the codes with no dedicated outcome status of their own: the
 * timeout and cancellation codes are excluded because they are pinned to the
 * `timed_out` and `cancelled` variants. Source of truth for the
 * `CodeExecutionFailedOutcomeCodeSchema` and the
 * {@link CodeExecutionFailedOutcomeCode} union.
 */
export const CODE_EXECUTION_FAILED_OUTCOME_CODES = [
  'provider_unavailable',
  'invalid_provider',
  'invalid_program',
  'unsupported_import',
  'compilation_failed',
  'entrypoint_not_found',
  'handler_failed',
  'invalid_result',
  'provider_failed',
] as const;

/**
 * Ordered constant array of every stable failure code.
 *
 * Composed from {@link CODE_EXECUTION_FAILED_OUTCOME_CODES} plus the two
 * codes pinned to their own outcome variants. Source of truth for the
 * `CodeExecutionFailureCodeSchema` and the {@link CodeExecutionFailureCode}
 * union.
 */
export const CODE_EXECUTION_FAILURE_CODES = [
  ...CODE_EXECUTION_FAILED_OUTCOME_CODES,
  'execution_timeout',
  'cancelled',
] as const;

/**
 * Failure classification valid on a `failed` outcome.
 *
 * Excludes `execution_timeout` and `cancelled`, which are pinned to the
 * `timed_out` and `cancelled` outcome variants respectively.
 */
export type CodeExecutionFailedOutcomeCode = (typeof CODE_EXECUTION_FAILED_OUTCOME_CODES)[number];

/**
 * Stable, machine-readable classification of a non-completed outcome.
 *
 * - `provider_unavailable`: no registered provider satisfies the request, or
 *   the admitted provider is not accepting work (disposed, draining, or at
 *   capacity).
 * - `invalid_provider`: a registered or selected provider violated the provider
 *   contract — a malformed registration as much as a non-conforming outcome.
 * - `invalid_program`: the prepared program failed contract validation.
 * - `unsupported_import`: the program imported something the provider does not resolve.
 * - `compilation_failed`: the program could not be compiled, loaded, or
 *   evaluated into runnable code.
 * - `entrypoint_not_found`: the entry module's `exportName` is absent or not callable.
 * - `handler_failed`: the invoked export threw or rejected.
 * - `invalid_result`: the invoked export returned a non-JSON-safe value.
 * - `provider_failed`: the provider itself failed outside the handler.
 * - `execution_timeout`: the execution exceeded `timeoutMs` (only on `timed_out`).
 * - `cancelled`: the execution was cancelled before it completed (only on `cancelled`).
 */
export type CodeExecutionFailureCode = (typeof CODE_EXECUTION_FAILURE_CODES)[number];

/**
 * Bounded, JSON-safe description of a non-completed outcome.
 *
 * The strict shape carries a stable code and a short summary — nothing else.
 * Failures must not carry stack traces, absolute temporary paths, environment
 * values, or provider-internal error objects over the bus; producers that
 * hold such data must reduce it to a bounded summary before it can cross
 * this boundary.
 * @typeParam TCode - Failure codes valid for the outcome variant carrying
 * this failure; defaults to the full {@link CodeExecutionFailureCode} union.
 */
export interface CodeExecutionFailure<TCode extends CodeExecutionFailureCode = CodeExecutionFailureCode> {
  /** Stable failure classification. */
  readonly code: TCode;
  /**
   * Short, human-readable, non-secret summary of what went wrong.
   *
   * Free text is not content-validated by the schema, so this bound is
   * behavioral: producers must not embed stack traces, absolute filesystem
   * paths, environment values, or provider-internal error serializations.
   * Detailed causes belong in local diagnostic logging only.
   */
  readonly message: string;
}

/** Terminal outcome of an execution whose invoked export returned a JSON-safe value. */
export interface CodeExecutionCompletedOutcome {
  /** Discriminant for a completed execution. */
  readonly status: 'completed';
  /** JSON-safe value returned by the invoked export. */
  readonly value: JsonValue;
}

/** Terminal outcome of an execution that failed before producing a value. */
export interface CodeExecutionFailedOutcome {
  /** Discriminant for a failed execution. */
  readonly status: 'failed';
  /** Bounded failure with a code from {@link CODE_EXECUTION_FAILED_OUTCOME_CODES}. */
  readonly error: CodeExecutionFailure<CodeExecutionFailedOutcomeCode>;
}

/** Terminal outcome of an execution that exceeded its wall-clock budget. */
export interface CodeExecutionTimedOutOutcome {
  /** Discriminant for a timed-out execution. */
  readonly status: 'timed_out';
  /** Bounded failure describing the exceeded budget; always coded `execution_timeout`. */
  readonly error: CodeExecutionFailure<'execution_timeout'>;
}

/** Terminal outcome of an execution that was cancelled before completion. */
export interface CodeExecutionCancelledOutcome {
  /** Discriminant for a cancelled execution. */
  readonly status: 'cancelled';
  /** Bounded failure describing the cancellation; always coded `cancelled`. */
  readonly error: CodeExecutionFailure<'cancelled'>;
}

/**
 * Discriminated, JSON-safe union of every terminal execution outcome.
 *
 * Exactly one outcome is produced per invocation. Non-completed variants
 * carry a bounded {@link CodeExecutionFailure} instead of a thrown error so
 * that outcomes stay serializable and secret-free on the bus. Each variant
 * constrains its failure code: `timed_out` is always `execution_timeout`,
 * `cancelled` is always `cancelled`, and `failed` carries one of the
 * remaining codes — contradictory status/code pairings do not exist.
 */
export type CodeExecutionOutcome =
  | CodeExecutionCompletedOutcome
  | CodeExecutionFailedOutcome
  | CodeExecutionTimedOutOutcome
  | CodeExecutionCancelledOutcome;

// ─────────────────────────────────────────────────────────────
// Abort Reasons
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of every reason an execution's effective signal
 * aborts.
 *
 * Source of truth for the {@link CodeExecutionAbortReason} union and for the
 * literal values a routing service places on
 * {@link CodeExecutionProviderContext.signal}'s `reason`.
 */
export const CODE_EXECUTION_ABORT_REASONS = ['timeout', 'cancellation'] as const;

/**
 * Reason an execution's effective signal aborted.
 *
 * - `timeout`: the effective deadline elapsed before the execution completed.
 * - `cancellation`: the invocation's caller went away.
 *
 * The distinction decides which terminal outcome the invocation settles as —
 * `timed_out` versus `cancelled` — and only the signal's owner knows it. It
 * is carried on the signal precisely so that no observer has to re-derive it
 * by comparing a wall clock to {@link CodeExecutionProviderContext.deadlineEpochMs},
 * a comparison that races the settlement it is trying to classify.
 */
export type CodeExecutionAbortReason = (typeof CODE_EXECUTION_ABORT_REASONS)[number];

// ─────────────────────────────────────────────────────────────
// Provider Interface
// ─────────────────────────────────────────────────────────────

/**
 * Execution context handed to a provider alongside the request.
 *
 * Carries the effective cancellation and deadline signals the router derived
 * from the request's `timeoutMs`, so providers observe one authoritative
 * budget instead of re-deriving their own.
 */
export interface CodeExecutionProviderContext {
  /**
   * Effective cancellation signal for this execution.
   *
   * Aborts when the execution budget is exhausted or the invocation is
   * cancelled. Providers stop work cooperatively when it fires.
   *
   * When the routing service settles this signal, `signal.reason` is a
   * {@link CodeExecutionAbortReason}, and that value is authoritative:
   * providers classify a timeout against a cancellation from it rather than
   * from their own clock. A provider handed a foreign signal — one it did not
   * receive from the routing service — may fall back to comparing the current
   * time against {@link CodeExecutionProviderContext.deadlineEpochMs}.
   */
  readonly signal: AbortSignal;
  /**
   * Effective execution deadline as a Unix epoch timestamp in milliseconds.
   *
   * The earlier of the request's `timeoutMs` budget and an inherited bus
   * deadline at dispatch time. Providers that schedule internal work use this
   * absolute instant rather than re-anchoring the relative budget.
   */
  readonly deadlineEpochMs: number;
}

/**
 * Capability provider that executes one prepared program invocation and
 * returns one normalized terminal outcome.
 *
 * Providers are locally registered runtime objects; they are handed over the
 * capability registry as live references and are never serialized. A provider
 * resolves every invocation to a {@link CodeExecutionOutcome} — including
 * timeouts and cancellations — and rejects only on contract-level misuse.
 */
export interface ICodeExecutionProvider extends ICapabilityProvider {
  /** Request-addressable provider identifier within the public identifier length limit. */
  readonly id: string;
  /** Selection priority among matching providers; higher wins. */
  readonly priority: number;
  /** Request-addressable runtime tag within the public identifier length limit (e.g. `'node'`). */
  readonly runtime: string;
  /** Request-addressable source language within the public identifier length limit (e.g. `'typescript'`). */
  readonly language: string;
  /** Request-addressable module format within the public identifier length limit (e.g. `'esm'`). */
  readonly moduleFormat: string;
  /** Trust level this provider executes submitted code under. */
  readonly trust: CodeExecutionTrustLevel;
  /**
   * Execute one prepared invocation to a terminal outcome.
   * @param request - Prepared, JSON-safe invocation to execute.
   * @param context - Effective cancellation signal and deadline for the execution.
   * @returns Exactly one normalized terminal outcome for the invocation.
   */
  execute(request: CodeExecutionRequest, context: CodeExecutionProviderContext): Promise<CodeExecutionOutcome>;
}
