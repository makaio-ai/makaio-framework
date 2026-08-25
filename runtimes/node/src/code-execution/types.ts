import { z } from 'zod';
import {
  boundCodeExecutionFailureMessage,
  CODE_EXECUTION_FAILED_OUTCOME_CODES,
  CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH,
  JsonValueSchema,
  rejectingLossyJsonValues,
  type CodeExecutionFailedOutcome,
  type CodeExecutionFailedOutcomeCode,
  type JsonValue,
} from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Shared surface between the Piscina CodeExecution provider (host thread) and
// its worker entry (worker thread): the provider options, the documented
// budget defaults, the structured-clone-safe task/outcome envelope exchanged
// across the thread boundary, and the diagnostic sanitizer both sides use
// before a message can reach a bounded contract failure.
//
// This provider executes code with the full privileges of its worker thread.
// The budgets below bound resource usage and keep outcomes serializable; they
// are not an isolation boundary and must not be described as one.

// ─────────────────────────────────────────────────────────────
// Documented budget defaults
// ─────────────────────────────────────────────────────────────

// These names carry the domain because they are re-exported from the runtime
// package root, where a bare `DEFAULT_IDLE_TIMEOUT_MS` would say nothing about
// which subsystem's idle timeout it is — and would collide with the equally
// generic defaults other subsystems keep module-private today.

/** Default maximum number of virtual files a submitted program may contain. */
export const CODE_EXECUTION_DEFAULT_MAX_PROGRAM_FILES = 256;

/** Default maximum aggregate UTF-8 size of a submitted program's sources, in bytes (5 MiB). */
export const CODE_EXECUTION_DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/** Default maximum serialized JSON size of a handler result, in bytes (1 MiB). */
export const CODE_EXECUTION_DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

/**
 * Default maximum serialized JSON size of an invocation's arguments, in bytes (1 MiB).
 *
 * The argument is the one part of a request no other budget measures, and it is
 * retained for longer than any of them: a queued invocation holds it from
 * admission until dispatch, and the pool then structured-clones it into the
 * worker. Bounding it is what keeps a burst of large arguments from costing the
 * host more than the configured concurrency implies.
 *
 * Matched to {@link CODE_EXECUTION_DEFAULT_MAX_RESULT_BYTES} deliberately: both
 * bound one JSON value crossing the same thread boundary, in opposite
 * directions, so a host that raises one usually means the pair.
 */
export const CODE_EXECUTION_DEFAULT_MAX_ARGUMENT_BYTES = 1024 * 1024;

/** Default maximum number of concurrently executing worker threads. */
export const CODE_EXECUTION_DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Default maximum number of invocations allowed to wait for an execution slot.
 *
 * Concurrency bounds what executes; this bounds what is *retained while
 * waiting*. A queued invocation holds its whole request — up to
 * {@link CODE_EXECUTION_DEFAULT_MAX_SOURCE_BYTES} of sources and
 * {@link CODE_EXECUTION_DEFAULT_MAX_ARGUMENT_BYTES} of arguments — from arrival
 * until dispatch, and its deadline is the caller's rather than the provider's,
 * so an unbounded queue makes the host's retained memory a function of the
 * arrival rate. Refusing past the cap keeps it a function of configuration.
 *
 * 16 is four times {@link CODE_EXECUTION_DEFAULT_MAX_CONCURRENCY}, so an
 * ordinary burst still queues and is served rather than being refused, while
 * the worst-case retained request set stays a small multiple of what the
 * executing invocations already hold.
 */
export const CODE_EXECUTION_DEFAULT_MAX_QUEUED_INVOCATIONS = 16;

/** Default idle duration after which unused worker threads are reaped, in milliseconds. */
export const CODE_EXECUTION_DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Default number of invocations a worker thread serves before it is retired.
 *
 * Every invocation adds a module graph to its worker's ESM module map, and Node
 * never evicts one: the record is keyed by URL, and each invocation imports a
 * freshly materialized program under a URL that has never been seen before. A
 * worker that is never idle long enough to be reaped therefore grows without
 * bound. Retiring it after a fixed number of invocations is what turns that
 * into a bounded working set.
 *
 * 64 trades the two costs against each other: retirement pays one worker spawn
 * and one TypeScript-loader bootstrap, which is worth amortizing, while the
 * accumulated graphs of 64 bounded programs are not.
 */
export const CODE_EXECUTION_DEFAULT_MAX_INVOCATIONS_PER_WORKER = 64;

/**
 * Export the generated entry-namespace module carries the program's namespace on.
 *
 * The worker never imports a program's entry module directly, and cannot: a
 * module namespace is an ordinary object as far as promise resolution is
 * concerned, so a program exporting a callable `then` from its entry makes the
 * dynamic-import promise *assimilate* that namespace. The importer would then
 * receive whatever the program's `then` resolved with — or nothing at all, if it
 * never calls back — and the export it asked for would be reported missing,
 * substituted, or left hanging until the invocation's budget expires. The
 * program decides that, from an export it is otherwise free to have.
 *
 * So the materializer generates one module per program that statically imports
 * the entry and re-exports its namespace under this name. The generated module's
 * own namespace has no `then` export, so nothing assimilates it, and the
 * program's namespace arrives as a plain property of it — untouched, whatever
 * the program exports.
 *
 * Shared between the two halves that must agree on it: the materializer writes
 * the module, and the worker entry reads this export off it.
 */
export const CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT = 'namespace';

/**
 * Replacement token substituted for every redacted value in diagnostics.
 *
 * Deliberately neutral: the redaction set covers materialized program paths as
 * well as host-configured environment values, package roots, and the paths a
 * worker thread is launched against, so a placeholder naming only the program
 * would misdescribe half of what it replaces.
 */
export const REDACTION_PLACEHOLDER = '<redacted>';

// ─────────────────────────────────────────────────────────────
// Provider options
// ─────────────────────────────────────────────────────────────

/**
 * Composition options for the Piscina-backed CodeExecution provider.
 *
 * Every option is host-owned: the provider never derives capability, package
 * availability, or environment from the submitted program.
 */
export interface PiscinaCodeExecutionProviderOptions {
  /**
   * Provider identifier, bounded by the public CodeExecution identifier limit.
   * @defaultValue `'piscina-code-execution'`
   */
  readonly id?: string;
  /** Human-readable provider name. @defaultValue `'Local (Piscina)'` */
  readonly displayName?: string;
  /** Selection priority among matching providers; higher wins. @defaultValue 0 */
  readonly priority?: number;
  /** Maximum concurrent worker threads. @defaultValue {@link CODE_EXECUTION_DEFAULT_MAX_CONCURRENCY} */
  readonly maxConcurrency?: number;
  /**
   * Invocations allowed to wait for an execution slot before the provider
   * refuses further work.
   *
   * {@link maxConcurrency} bounds what executes; this bounds what is retained
   * while waiting. A queued invocation holds its sources and its arguments from
   * arrival until dispatch, under the caller's deadline rather than the
   * provider's, so without this bound a burst of valid requests would grow the
   * host's retained memory with the arrival rate.
   *
   * An invocation that arrives at a full queue is refused immediately — it is
   * never enqueued — and reported as `provider_unavailable`. Zero disables
   * queueing entirely: only what fits into a free slot right away is admitted.
   * @defaultValue {@link CODE_EXECUTION_DEFAULT_MAX_QUEUED_INVOCATIONS}
   */
  readonly maxQueuedInvocations?: number;
  /**
   * Idle duration before worker threads are reaped, in milliseconds.
   * @defaultValue {@link CODE_EXECUTION_DEFAULT_IDLE_TIMEOUT_MS}
   */
  readonly idleTimeoutMs?: number;
  /**
   * Invocations a worker thread serves before it is retired and replaced.
   *
   * Idle reaping alone does not bound a worker's memory: a pool that is
   * continuously busy never goes idle, and every invocation permanently adds a
   * module graph to its worker's ESM module map. This bound is what makes the
   * working set a function of the configured value rather than of uptime.
   *
   * Enforced as a strict upper bound per thread, and reached sooner when
   * {@link maxConcurrency} is above one — a whole generation of workers is
   * retired together once the *generation* has served this many invocations, so
   * no thread in it can have served more.
   * @defaultValue {@link CODE_EXECUTION_DEFAULT_MAX_INVOCATIONS_PER_WORKER}
   */
  readonly maxInvocationsPerWorker?: number;
  /**
   * Environment variables visible to worker threads.
   *
   * Defaults to an empty object rather than the host process environment, so
   * host secrets are not handed to executed code by accident. Node built-ins
   * and filesystem access stay available regardless — this provider runs
   * trusted code only and the environment is not a sandbox.
   *
   * Configured values are stripped from diagnostics before those can reach a
   * contract failure, but only above a minimum length: a value of three
   * characters or fewer occurs in ordinary prose, so redacting it would mangle
   * the diagnostic it is meant to protect. Such a value is therefore **not**
   * redacted and can appear verbatim in a bus-bound message — do not place a
   * secret in an environment value that short. The length is measured on the
   * whitespace-collapsed value, which is the form diagnostics are matched in.
   *
   * The resolved worker entry's own loader variables are applied *after* these,
   * so a value here that happens to name one of them does not take effect: that
   * loader is what bounds which ordinary packages a submitted program resolves,
   * and it is provider-owned rather than host-configurable.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Ordinary bare package names the program may import, mapped to absolute
   * package root directories.
   *
   * These packages are linked into the materialized program, and a resolve
   * guard in the worker rejects every *other* ordinary import — including one
   * an ambient `node_modules` above the temporary program root would otherwise
   * satisfy. So the map is the whole truth about which packages a program can
   * reach by name, on any host.
   *
   * It bounds bare specifiers and nothing else. Node built-ins, absolute and
   * `file:` specifiers, and direct filesystem access all remain available to
   * the executed code, and a configured package's own dependencies resolve
   * within that package as usual — configuring a package vouches for what it
   * depends on. This is a resolution boundary, not an isolation boundary.
   */
  readonly packageRoots?: Readonly<Record<string, string>>;
  /** Maximum number of virtual files per program. @defaultValue {@link CODE_EXECUTION_DEFAULT_MAX_PROGRAM_FILES} */
  readonly maxProgramFiles?: number;
  /**
   * Maximum aggregate UTF-8 source size per program, in bytes.
   * @defaultValue {@link CODE_EXECUTION_DEFAULT_MAX_SOURCE_BYTES}
   */
  readonly maxSourceBytes?: number;
  /**
   * Maximum serialized JSON size of a handler result, in bytes.
   * @defaultValue {@link CODE_EXECUTION_DEFAULT_MAX_RESULT_BYTES}
   */
  readonly maxResultBytes?: number;
  /**
   * Maximum serialized JSON size of an invocation's arguments, in bytes.
   *
   * Enforced before the invocation waits for an admission slot, and reported as
   * `invalid_program`: the argument is part of what was submitted, so an
   * over-budget one is a rejected request rather than a provider fault.
   * @defaultValue {@link CODE_EXECUTION_DEFAULT_MAX_ARGUMENT_BYTES}
   */
  readonly maxArgumentBytes?: number;
}

// ─────────────────────────────────────────────────────────────
// Worker task
// ─────────────────────────────────────────────────────────────

/**
 * Structured-clone-safe task handed to the worker entry for one invocation.
 *
 * The task carries only resolved primitives and JSON values. TypeScript
 * transpilation and module loading happen in the worker thread, so no
 * program source and no live host object crosses the boundary.
 */
export interface CodeExecutionWorkerTask {
  /**
   * `file:` URL of the generated module that re-exports the program's entry namespace.
   *
   * Not the program's entry module itself. Importing that directly would let a
   * program exporting a callable `then` hijack the import promise; see
   * {@link CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT}, which names the export this
   * module carries the entry namespace on.
   */
  readonly entryNamespaceUrl: string;
  /** `file:` URL used as the importing parent for the scoped import. */
  readonly parentUrl: string;
  /**
   * `file:` URL prefixes identifying the modules the import allowlist applies to.
   *
   * Every spelling of the program root, each ending in a slash. Everything the
   * worker resolves for its own module graph sits outside these prefixes and is
   * therefore unaffected. More than one prefix is required because the module
   * loader reports a module reached through a symlinked prefix by its real
   * path, which is a different spelling of the same root.
   */
  readonly programRootUrls: readonly string[];
  /**
   * Ordinary bare package names the program is allowed to import.
   *
   * Carried per task rather than read from the worker's environment because the
   * allowlist is a property of the host's composition, and the worker must be
   * able to enforce it without knowing how the provider was configured. Node
   * resolves a bare specifier by walking up from the importing module, so
   * linking these packages into the program root is not by itself an
   * allowlist — an ancestor `node_modules` would satisfy an unlisted import.
   */
  readonly allowedPackages: readonly string[];
  /** Name of the export invoked on the entry module. */
  readonly exportName: string;
  /** JSON-safe value passed to the invoked export as its single argument. */
  readonly arguments: JsonValue;
  /** Per-invocation TypeScript loader namespace, isolating module caches between invocations. */
  readonly namespace: string;
  /** Maximum serialized JSON size of the handler result, in bytes. */
  readonly maxResultBytes: number;
  /**
   * Values to strip from diagnostics before they leave the worker.
   *
   * Carries the materialized program paths for this invocation plus the
   * host-configured values the provider knows are sensitive. Redacting in the
   * worker as well as in the host keeps a long diagnostic from being truncated
   * around a value the host would then no longer be able to match.
   */
  readonly redactedPaths: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Worker outcome envelope
// ─────────────────────────────────────────────────────────────

/** Worker outcome for an invocation whose export returned a JSON-safe value the host revalidates after transfer. */
export interface CodeExecutionWorkerCompletedOutcome {
  /** Discriminant for a completed invocation. */
  readonly kind: 'completed';
  /** JSON-safe value validated by the worker and revalidated by the host after transfer. */
  readonly value: JsonValue;
}

/** Worker outcome for an invocation that failed inside the worker thread. */
export interface CodeExecutionWorkerFailedOutcome {
  /** Discriminant for a failed invocation. */
  readonly kind: 'failed';
  /** Stable failure classification, already narrowed to a `failed` outcome code. */
  readonly code: CodeExecutionFailedOutcomeCode;
  /** Sanitized, bounded summary of what went wrong. */
  readonly message: string;
}

/**
 * Discriminated envelope the worker entry returns for every invocation.
 *
 * The worker resolves rather than rejects for expected failures so that only
 * small, clone-safe values cross the thread boundary. Timeouts and
 * cancellations are not represented here: those are observed by the host
 * thread through the effective abort signal.
 */
export type CodeExecutionWorkerOutcome = CodeExecutionWorkerCompletedOutcome | CodeExecutionWorkerFailedOutcome;

/**
 * Zod schema for the worker outcome envelope.
 *
 * The host thread re-validates what the worker returned before mapping it onto
 * a contract outcome, so a worker entry that violates the envelope is reported
 * as a provider contract violation instead of corrupting the outcome union.
 *
 * The completed value is guarded exactly like the contract's own outcome value.
 * Parsing it through the bare JSON schema would drop a `__proto__` own key
 * silently, or reduce a non-plain object to its enumerable fields, so the host
 * would forward a value the worker never produced. Rejecting it keeps the
 * provider's terminal union faithful to the worker boundary.
 */
export const CodeExecutionWorkerOutcomeSchema: z.ZodType<CodeExecutionWorkerOutcome> = z.discriminatedUnion('kind', [
  z.strictObject({
    /** Discriminant for a completed invocation. */
    kind: z.literal('completed'),
    /** JSON-safe value the worker validated before transfer and the host revalidates after transfer. */
    value: rejectingLossyJsonValues(JsonValueSchema, {
      prototypeKey: '"__proto__" is not a valid result key',
      nonPlainObject: 'the result must be JSON data: only plain objects and arrays are transportable',
      symbolKey: 'the result carries a symbol-keyed property, which cannot be transported as JSON',
      nonEnumerableKey: 'the result carries a non-enumerable property, which the record parse would drop',
      extraArrayKey: 'the result carries an array with extra own properties, which the array rebuild would drop',
    }),
  }),
  z.strictObject({
    /** Discriminant for a failed invocation. */
    kind: z.literal('failed'),
    /** Stable failure classification. */
    code: z.enum(CODE_EXECUTION_FAILED_OUTCOME_CODES),
    /** Sanitized, bounded summary of what went wrong. */
    message: z.string().min(1).max(CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH),
  }),
]);

// ─────────────────────────────────────────────────────────────
// Diagnostic sanitizing
// ─────────────────────────────────────────────────────────────

/**
 * Reduce text to the single-line, single-space form a diagnostic is bounded in.
 *
 * Both the message and the values redacted out of it are folded through this,
 * because matching happens *after* the fold: a redaction still carrying its
 * original tab, newline, or double space could no longer occur in the collapsed
 * message, and would cross the bus verbatim.
 * @param value - Raw text to collapse.
 * @returns The text with every whitespace run folded to one space, ends trimmed.
 */
export function collapseDiagnosticWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Reduce a raw diagnostic to a bounded, non-secret failure summary.
 *
 * Contract failures must not carry stack traces, absolute temporary paths, or
 * environment values, so this collapses whitespace (folding any embedded
 * multi-line trace onto one line), replaces every supplied redaction with
 * {@link REDACTION_PLACEHOLDER}, and truncates to the contract bound.
 * Redactions are collapsed the same way the message is — see
 * {@link collapseDiagnosticWhitespace} — and applied longest-first so a value
 * that is a prefix of another cannot partially replace it.
 *
 * Redaction is exhaustive only over the values the provider knows: the
 * materialized program paths and the host-configured environment values,
 * package roots, and worker entry. A `trusted-code-only` handler can still
 * embed arbitrary text of its own — a secret it read itself, for instance — in
 * a thrown message, and no substring filter can recognize that. Bounding what
 * an untrusted handler may say is the job of an `isolated` provider, not of
 * this sanitizer.
 * @param message - Raw diagnostic text, typically an error name and message.
 * @param redactedPaths - Program paths, URLs, and configured values to strip.
 * @returns Bounded summary safe to place on a contract failure.
 */
export function sanitizeDiagnosticMessage(message: string, redactedPaths: readonly string[]): string {
  let sanitized = collapseDiagnosticWhitespace(message);
  const redactions = new Set(redactedPaths.map((path) => collapseDiagnosticWhitespace(path)));
  redactions.delete('');
  for (const redaction of [...redactions].sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(redaction).join(REDACTION_PLACEHOLDER);
  }
  if (sanitized.length === 0) return 'No diagnostic detail available.';
  return boundCodeExecutionFailureMessage(sanitized);
}

/**
 * Build a `failed` contract outcome.
 *
 * Shared rather than owned by the provider because the pre-admission request
 * rules produce the very same outcomes without ever reaching it; a second copy
 * would let the two spellings of "this invocation failed" drift apart.
 * @param code - Stable failure classification valid on a `failed` outcome.
 * @param message - Bounded, non-secret summary of what went wrong.
 * @returns Terminal failed outcome.
 */
export function failedOutcome(code: CodeExecutionFailedOutcomeCode, message: string): CodeExecutionFailedOutcome {
  return { status: 'failed', error: { code, message } };
}

/**
 * Measure the serialized UTF-8 size of a JSON-safe value.
 *
 * The worker applies the result budget before a value can be transferred and
 * the host re-applies it to the received clone after the thread boundary. The
 * worker-side check is trusted-code best effort, not
 * hostile-code/pre-clone isolation: submitted code shares that realm and can
 * replace serialization intrinsics. The host's post-clone validation and
 * budget check are authoritative for the contract outcome.
 * @param value - Value already validated as JSON-safe.
 * @returns Size of the value's JSON serialization, in UTF-8 bytes.
 */
export function measureSerializedBytes(value: JsonValue): number {
  // A JSON-safe value always serializes; the fallback only satisfies the
  // `string | undefined` return type of `JSON.stringify`.
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Describe an unknown thrown value as raw diagnostic text.
 *
 * Only the error name and message are read; the stack and any provider-internal
 * properties are deliberately dropped. The result still needs
 * {@link sanitizeDiagnosticMessage} before it can reach a contract failure.
 *
 * Total by construction, and it has to be: every caller is already inside a
 * `catch`, describing something a submitted program chose to throw. JavaScript
 * lets that be a value with no string form at all — `Object.create(null)` has no
 * `toString`, so coercing it throws — and a property read can throw of its own
 * accord through a getter or a proxy trap. A throw from here would escape the
 * `catch` that called it and turn a precisely classified failure into an
 * unrelated provider fault, which is exactly the misreport this function exists
 * to produce a message for. The fallback names what could be established about
 * the value rather than pretending to quote it.
 * @param error - Value thrown or rejected by the inspected operation.
 * @returns Raw, unsanitized description of the thrown value.
 */
export function describeThrownValue(error: unknown): string {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  } catch {
    return `A value of type ${typeof error} with no string representation was thrown.`;
  }
}
