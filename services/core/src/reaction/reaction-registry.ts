import type { ReactionCatalogEntries, ReactionCatalogEntry } from '@makaio/contracts/rules';
import { zodSchemaToJsonRecord } from '@makaio/contracts/shared';
import type { ReactionCause } from '@makaio/contracts/reaction';
import type { IMakaioBus } from '@makaio/bus-core';
import type {
  ExtensionIdentity,
  FrameworkReactionFailureCode,
  ReactionDefinition,
  ReactionDescriptor,
  ReactionExecutionContext,
  ReactionInvocationId,
  ReactionOutcome,
} from '@makaio/contracts';
import { FrameworkReactionFailureCodeSchema, ReactionDescriptorSchema, ReactionOutcomeSchema } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { BaseService } from '@makaio/service-base';
import { getErrorString } from '@makaio/utils';
import { uncertainReactionOutcome } from './uncertain-outcome.js';
import { ContributionRegistryCore } from '../contribution-registry/index.js';

/**
 * Host-supplied input for a single Reaction invocation.
 *
 * The host has already evaluated its rules (`makaio.rules`) and resolved raw
 * parameters before calling {@link ReactionRegistry.invoke}; this input
 * carries everything the runtime needs to build the frozen
 * {@link ReactionExecutionContext} envelope for the handler. `call` and
 * `cause` remain host-owned references; hosts must detach them before
 * invocation when they need deeper isolation.
 */
export interface ReactionInvocationInput {
  /**
   * Context of the call: caller `makaio.rules`, principal and attesting
   * party of the occasion. Passed through verbatim as the handler's first
   * parameter.
   */
  readonly call: CallContext;
  /**
   * Key of the part this invocation runs:
   * `(ruleId, occasion, location of the element)`. A reaction may refine it.
   */
  readonly key: string;
  /** Key guarantee recorded for a durable effect. An absent registration is retryable for that effect. */
  readonly expectedKeyed?: boolean;
  /** What caused this invocation to run. */
  readonly cause: ReactionCause;
  /** Bus correlation identifier from the triggering message, when one exists. */
  readonly correlationId?: string;
  /**
   * Absolute deadline for this invocation as epoch milliseconds. An
   * invocation already past its deadline never enters handler code; a
   * deadline reached mid-flight aborts the signal and bounds the wait. Deadlines
   * beyond the platform timer cap (~24.8 days) are honored via rescheduling.
   * Non-finite values (`NaN`, `±Infinity`) are deterministically treated as
   * "no deadline"; the value is still passed through verbatim on the
   * execution context.
   */
  readonly deadlineEpochMs?: number;
  /**
   * Optional host-owned cancellation signal (e.g. an extension-wide shutdown
   * signal) layered UNDER the runtime-controlled per-invocation signal: its
   * abort propagates into the per-invocation signal, but the handler only
   * ever observes the per-invocation signal, so aborting one invocation can
   * never affect another sharing the same host signal.
   */
  readonly hostSignal?: AbortSignal;
}

/**
 * Largest delay `setTimeout` honors (2^31 - 1 ms, ~24.8 days); larger delays
 * are clamped to ~1ms by the platform, so deadline timers beyond the cap must
 * reschedule instead.
 */
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/** Per-invocation cancellation wiring that must be released after settle. */
interface InvocationCancellation {
  /** Runtime-owned controller backing the per-invocation signal. */
  readonly controller: AbortController;
  /** @param work - Current invocation phase.
   * @returns The phase result or a rejection at the deadline.
   */
  wait<T>(work: Promise<T>): Promise<T>;
  /** Releases the host-signal listener and deadline timer. */
  readonly release: () => void;
}

/**
 * Stable executable Reaction entries and their validated discovery snapshot.
 *
 * Live definitions remain extension-owned objects. Registration captures the
 * executable values once so later mutation of that object cannot change a
 * registered Reaction between validation and invocation.
 */
interface RegisteredReaction {
  /** Live parameter schema captured when this Reaction was registered. */
  readonly parameterSchema: ReactionDefinition['parameterSchema'];
  /** Executable handler captured when this Reaction was registered. */
  readonly handler: ReactionDefinition['handler'];
  /** Custom rule check captured when this Reaction was registered. */
  readonly validate: ReactionDefinition['validate'];
  /** Detached descriptor used only for discovery. */
  readonly descriptor: ReactionDescriptor;
  /** Result schema derived from the contributed definition. */
  readonly resultSchema: ReactionCatalogEntry['result'];
  /** Whether the handler is idempotent per key. */
  readonly keyed: boolean;
}

/** Contribution and discovery API made available to extension contexts. */
export type ReactionRegistryView = Pick<ReactionRegistry, 'listCatalog' | 'listDescriptors'> & {
  /** @param reactions - The requesting extension's complete reaction batch. */
  register(reactions: readonly ReactionDefinition[]): void;
  /** Removes the requesting extension's reactions. */
  deregister(): void;
};

/**
 * Owner-aware registry and in-process dispatcher for Reactions contributed by
 * extensions.
 *
 * Registration is keyed by the owning extension: every Reaction kind must
 * carry the canonical `<extensionName>.` prefix, kinds are globally unique,
 * and a registration batch is atomic — executable definitions and their
 * serializable descriptors are validated in full before either index changes,
 * so a failing batch leaves no partial registration.
 *
 * Dispatch is a plain in-process call ({@link invoke}): the host resolves
 * parameters itself and receives a normalized {@link ReactionOutcome}.
 * Invocations are independent — no queuing, no ordering, no shared
 * runtime-owned mutable invocation state, and one invocation's failure never
 * suppresses another. Host-owned context references may intentionally be
 * shared. A handler closure captured by an in-flight invocation completes
 * normally even if its extension deregisters mid-flight; deregistration only
 * prevents NEW dispatches from resolving the kind.
 *
 * This service intentionally exposes NO bus subjects in this phase: Reactions
 * are scoped to in-process host invocation. Bus-based discovery (a
 * `list`/`changed` surface like the workflow-block registry's) is a
 * deliberate later seam, not an omission.
 */
export class ReactionRegistry extends BaseService {
  /**
   * Binds registry mutations to the requesting extension's live activation.
   * @param identity - Identity supplied by the kernel.
   * @param lifetime - Requesting extension's activation signal.
   * @returns Registration and discovery operations for the requesting extension.
   */
  public extensionServiceView(identity: ExtensionIdentity, lifetime: AbortSignal): ReactionRegistryView {
    const owner = identity.extensionName;
    const view: ReactionRegistryView = {
      register: (reactions) => {
        lifetime.throwIfAborted();
        this.register(owner, reactions);
      },
      deregister: () => {
        lifetime.throwIfAborted();
        this.deregister(owner);
      },
      listCatalog: this.listCatalog.bind(this),
      listDescriptors: this.listDescriptors.bind(this),
    };
    return Object.freeze(view);
  }

  /** Generic owner-aware name index, owner check, and batch lifecycle. */
  private readonly core = new ContributionRegistryCore<RegisteredReaction>({
    label: 'Reaction',
    nameOf: (reaction) => reaction.descriptor.kind,
  });

  /**
   * @param bus - Bus instance used for the service lifecycle.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Initialize the service.
   *
   * Registers no bus handlers by design — Reaction dispatch is an in-process
   * host call in this phase (see class docs).
   */
  protected onInit(): void {
    // Intentionally empty: no bus subjects in this phase.
  }

  /**
   * Clears all in-memory registrations so handler closure references are
   * released on teardown.
   */
  protected override onDestroy(): void {
    this.core.clear();
  }

  /**
   * Atomically registers the complete Reaction batch contributed by an extension.
   *
   * Each call replaces that extension's previous batch. The whole incoming
   * batch, including every descriptor snapshot, is validated before either
   * registry index changes, so a failure preserves the prior batch. Kinds
   * owned by another extension still collide; an empty batch removes this
   * extension's current registrations.
   * @param extensionName - The extension contributing the complete batch.
   * @param reactions - Complete Reaction definitions to register.
   * @throws If a kind is not namespaced by `<extensionName>.`, has an empty
   *   local name, duplicates another incoming kind, or belongs to another owner.
   */
  public register(extensionName: string, reactions: readonly ReactionDefinition[]): void {
    const registeredBatch = this.buildBatch(extensionName, reactions);
    this.core.commitBatch(extensionName, registeredBatch);
  }

  /**
   * Deregisters all Reactions contributed by an extension.
   *
   * Idempotent — a no-op when the extension has no registered Reactions.
   * In-flight invocations already dispatched keep their captured handler
   * closures and complete independently; only new dispatches stop resolving.
   * @param extensionName - The extension to remove.
   */
  public deregister(extensionName: string): void {
    if (this.core.ownerBatch(extensionName) === undefined) return;
    this.register(extensionName, []);
  }

  /**
   * Reads validation metadata for a registered reaction.
   * @param kind - Reaction kind.
   * @returns The runtime metadata, when available.
   */
  public ruleDefinition(kind: string) {
    const owned = this.core.listOwned().find(({ entry }) => entry.descriptor.kind === kind);
    if (!owned) return undefined;
    const { parameterSchema, keyed, validate } = owned.entry;
    return { extension: owned.extension, parameterSchema, keyed, validate };
  }

  /**
   * Returns detached serializable descriptors for all registered Reactions.
   *
   * Descriptor factories run only during successful batch validation; listing
   * cannot execute extension code or mutate the stored discovery snapshot.
   * @returns Detached discovery metadata for every registered Reaction.
   */
  public listCatalog(): ReactionCatalogEntries {
    return this.core.listOwned().map(({ extension, entry }) => ({
      extension,
      kind: entry.descriptor.kind,
      description: entry.descriptor.description,
      params: structuredClone(entry.descriptor.parameterSchema),
      result: structuredClone(entry.resultSchema),
      keyed: entry.keyed,
    }));
  }

  /** @returns Detached serializable descriptors for all registered reactions. */
  public listDescriptors(): ReactionDescriptor[] {
    return this.core.list().map(({ descriptor }) => structuredClone(descriptor));
  }

  /**
   * Finds the custom rule check declared by a registered Reaction.
   * @param kind - Canonical Reaction kind.
   * @returns The rule check, when one was declared for that kind.
   */
  public getValidator(kind: string): ReactionDefinition['validate'] {
    return this.core.get(kind)?.validate;
  }

  /**
   * Invokes a registered Reaction with host-resolved parameters.
   *
   * Every failure mode is a normalized {@link ReactionOutcome} rather than a
   * throw — including an unknown kind. A host may dispatch from a persisted
   * rule that races extension deregistration, so "kind not registered" is an
   * invocation-level failure of that dispatch, not a programming error at the
   * call site; keeping the outcome surface uniform means hosts handle exactly
   * one shape.
   *
   * Guarantees:
   * - An already-aborted host signal or an already-past deadline interrupts
   *   the invocation without entering the handler; these gates run BEFORE
   *   parameter validation, so an already-dead dispatch never pays for it.
   * - Parameters are validated against the Reaction's live Zod schema BEFORE
   *   handler entry; invalid parameters — and schema code that itself throws
   *   (e.g. a throwing transform) — never reach the handler and normalize to
   *   a failure outcome.
   * - Each invocation gets its own runtime-owned {@link AbortSignal}; the
   *   optional host signal and deadline propagate into it from parameter
   *   validation through handler settlement (listeners and timers are
   *   released after settle), and aborting one invocation never affects
   *   another. Host cancellation is cooperative after handler entry, so the
   *   handler may still return its own outcome before the deadline.
   *   Before handler entry, cancellation always yields `'retry'`. After entry,
   *   cancellation without a handler outcome yields `'retry'` for a keyed
   *   Reaction and `'failed'` with `'outcome-unknown'` otherwise.
   * - The handler receives a frozen top-level invocation envelope. `cause` is
   *   a host-owned value passed through verbatim, not deep-cloned or frozen.
   *   Hosts detach it before invocation when they need deeper isolation.
   * - Invalid return values and thrown values (including non-`Error`) are
   *   logged with the kind, invocation id, and correlation id, and normalized
   *   to an outcome.
   * @param kind - Canonical Reaction kind to invoke.
   * @param parameters - Host-resolved, not-yet-validated invocation parameters.
   * @param input - Host-supplied invocation input (event, context, controls).
   * @returns Normalized outcome of this invocation.
   */
  public async invoke(kind: string, parameters: unknown, input: ReactionInvocationInput): Promise<ReactionOutcome> {
    const invocationId: ReactionInvocationId = crypto.randomUUID();

    const registered = this.core.get(kind);
    if (!registered) {
      if (input.expectedKeyed !== undefined) return { state: 'retry', reason: 'contribution-unavailable' };
      return this.failure(
        kind,
        invocationId,
        input.correlationId,
        'unknown-reaction',
        `Reaction kind '${kind}' is not registered`,
      );
    }
    const deadlineEpochMs = normalizeDeadline(input.deadlineEpochMs);
    const preValidationCancellation = this.preflightOutcome(kind, input, deadlineEpochMs, registered.keyed);
    if (preValidationCancellation) return preValidationCancellation;

    // Cancellation ownership begins before the first async boundary, so a
    // host abort or deadline reached during async validation cannot race into
    // handler entry. The finally below releases this wiring after validation
    // failures as well as after handler settlement.
    const cancellation = createInvocationCancellation(input.hostSignal, deadlineEpochMs);
    // Capture every handler-visible top-level input field before the first
    // async boundary. The opaque host values intentionally remain shared by
    // reference, but subsequent reassignment on the input envelope cannot
    // change this invocation's context or post-validation log correlation.
    const call = input.call;
    const context = freezeExecutionContext(invocationId, cancellation.controller.signal, input);
    try {
      // safeParseAsync supports async refinements (sync safeParse throws on
      // them), and the try/catch normalizes schema code that itself throws
      // (e.g. a throwing transform) — invalid or throwing validation must
      // never enter handler code, and invoke() must never reject.
      let parsed: Awaited<ReturnType<typeof registered.parameterSchema.safeParseAsync>>;
      try {
        parsed = await cancellation.wait(registered.parameterSchema.safeParseAsync(parameters));
      } catch (error) {
        const interrupted = this.cancelledAfterValidation(kind, context, cancellation, deadlineEpochMs);
        if (interrupted) return interrupted;
        return this.failure(
          kind,
          invocationId,
          context.correlationId,
          'invalid-parameters',
          `Parameter validation for Reaction '${kind}' threw: ${getErrorString(error)}`,
          error,
        );
      }
      const interrupted = this.cancelledAfterValidation(kind, context, cancellation, deadlineEpochMs);
      if (interrupted) return interrupted;
      if (!parsed.success) {
        return this.failure(
          kind,
          invocationId,
          context.correlationId,
          'invalid-parameters',
          `Invalid parameters for Reaction '${kind}': ${parsed.error.message}`,
        );
      }

      const outcome = await cancellation.wait(registered.handler(call, parsed.data, context));
      return ReactionOutcomeSchema.parse(outcome);
    } catch (error) {
      if (deadlineEpochMs !== undefined) abortWhenDeadlineReached(cancellation.controller, deadlineEpochMs);
      if (context.signal.aborted) {
        return this.cancellationOutcome(
          kind,
          invocationId,
          context.correlationId,
          registered.keyed,
          getErrorString(context.signal.reason),
          error,
        );
      }
      // The outcome carries the extracted reason; the log line names only the
      // failure site and lets the rendered error carry that reason, avoiding
      // printing it twice in one console.error call.
      this.logFailure(kind, invocationId, context.correlationId, `Reaction '${kind}' handler failed`, error);
      return {
        state: 'failed',
        code: FrameworkReactionFailureCodeSchema.enum['handler-failed'],
        reason: getErrorString(error),
      };
    } finally {
      cancellation.release();
    }
  }

  /**
   * Logs an invocation failure with correlation metadata and returns the
   * normalized failure outcome carrying the same message.
   * @param kind - Reaction kind that failed to invoke.
   * @param invocationId - Runtime-minted identifier of the failed invocation.
   * @param correlationId - Bus correlation identifier, when one exists.
   * @param code - Stable machine-readable classification of the failure.
   * @param reason - Normalized failure reason for the log line and outcome.
   * @param cause - Original thrown value, retained only in the log.
   * @returns Normalized `'failed'` outcome carrying `reason`.
   */
  private failure(
    kind: string,
    invocationId: ReactionInvocationId,
    correlationId: string | undefined,
    code: FrameworkReactionFailureCode,
    reason: string,
    cause?: unknown,
  ): ReactionOutcome {
    this.logFailure(kind, invocationId, correlationId, reason, cause);
    return { state: 'failed', code, reason };
  }

  /**
   * Classifies cancellation by whether it is safe to dispatch the same key again.
   * @param kind - Reaction kind that was cancelled.
   * @param invocationId - Runtime-minted identifier of the cancelled invocation.
   * @param correlationId - Bus correlation identifier, when one exists.
   * @param keyed - Whether the Reaction is idempotent per key.
   * @param reason - Human-readable cancellation reason.
   * @param cause - Original thrown value, retained only in the log.
   * @returns A retry for keyed Reactions or a terminal outcome for unkeyed Reactions.
   */
  private cancellationOutcome(
    kind: string,
    invocationId: ReactionInvocationId,
    correlationId: string | undefined,
    keyed: boolean,
    reason: string,
    cause?: unknown,
  ): ReactionOutcome {
    this.logFailure(kind, invocationId, correlationId, reason, cause);
    return uncertainReactionOutcome(keyed, reason);
  }

  /**
   * Checks the pinned key guarantee and cancellation before validation starts.
   * @param kind - Reaction kind that was cancelled.
   * @param input - Host-supplied input for the invocation.
   * @param deadlineEpochMs - Normalized invocation deadline, when one exists.
   * @param keyed - Whether the Reaction is idempotent per key.
   * @returns A normalized cancellation outcome, or `undefined` when validation may proceed.
   */
  private preflightOutcome(
    kind: string,
    input: ReactionInvocationInput,
    deadlineEpochMs: number | undefined,
    keyed: boolean,
  ): ReactionOutcome | undefined {
    if (input.expectedKeyed !== undefined && input.expectedKeyed !== keyed) {
      return { state: 'retry', reason: 'reaction-key-guarantee-changed' };
    }
    if (input.hostSignal?.aborted) {
      return { state: 'retry', reason: `Reaction '${kind}' host signal already aborted` };
    }
    if (deadlineEpochMs !== undefined && deadlineEpochMs <= Date.now()) {
      return { state: 'retry', reason: `Reaction '${kind}' deadline already passed` };
    }
    return undefined;
  }

  /**
   * Returns the normalized outcome when cancellation wins after validation settles.
   *
   * A synchronous or CPU-heavy schema can cross a deadline before its timer
   * callback runs. This authoritative check therefore precedes both a parsed
   * validation failure and handler entry.
   * @param kind - Reaction kind that was cancelled.
   * @param context - Frozen invocation envelope.
   * @param cancellation - Runtime-owned cancellation wiring for the invocation.
   * @param deadlineEpochMs - Normalized invocation deadline, when one exists.
   * @returns A normalized cancellation outcome, or `undefined` when processing may continue.
   */
  private cancelledAfterValidation(
    kind: string,
    context: ReactionExecutionContext,
    cancellation: InvocationCancellation,
    deadlineEpochMs: number | undefined,
  ): ReactionOutcome | undefined {
    if (deadlineEpochMs !== undefined) {
      abortWhenDeadlineReached(cancellation.controller, deadlineEpochMs);
    }
    if (!context.signal.aborted) return undefined;
    const reason: unknown = context.signal.reason;
    return {
      state: 'retry',
      reason: `Reaction '${kind}' cancelled before handler entry: ${getErrorString(reason)}`,
    };
  }

  /**
   * Logs an invocation failure line with correlation metadata.
   * @param kind - Reaction kind that failed to invoke.
   * @param invocationId - Runtime-minted identifier of the failed invocation.
   * @param correlationId - Bus correlation identifier, when one exists.
   * @param logMessage - Failure-site message for the log line.
   * @param cause - Original thrown value rendered after the log line.
   */
  private logFailure(
    kind: string,
    invocationId: ReactionInvocationId,
    correlationId: string | undefined,
    logMessage: string,
    cause?: unknown,
  ): void {
    const correlation = correlationId !== undefined ? ` (correlationId: ${correlationId})` : '';
    console.error(
      `[ReactionRegistry] Reaction '${kind}' invocation '${invocationId}' failed${correlation}: ${logMessage}`,
      ...(cause !== undefined ? [cause] : []),
    );
  }

  /**
   * Validates a complete registration batch and derives its registered entries,
   * without mutating registry state.
   *
   * Namespace, duplicate-kind, and cross-owner collision checks are the
   * generic {@link ContributionRegistryCore.validateBatch}; this method adds
   * the kind-specific step of deriving and validating each descriptor.
   * @param extensionName - Owner of the proposed definitions.
   * @param reactions - Definitions to validate.
   * @returns Registered definitions paired with validated descriptor snapshots.
   * @throws If namespace, descriptor, or kind-uniqueness invariants are violated.
   */
  private buildBatch(extensionName: string, reactions: readonly ReactionDefinition[]): readonly RegisteredReaction[] {
    const registered: RegisteredReaction[] = reactions.map((reaction) => {
      const descriptor = ReactionDescriptorSchema.parse(reaction.toDescriptor());
      if (descriptor.kind !== reaction.kind) {
        throw new Error(
          `Reaction descriptor kind '${descriptor.kind}' does not match definition kind '${reaction.kind}'`,
        );
      }
      return {
        parameterSchema: reaction.parameterSchema,
        handler: reaction.handler,
        validate: reaction.validate?.bind(reaction),
        descriptor,
        resultSchema: reaction.resultSchema ? zodSchemaToJsonRecord(reaction.resultSchema) : null,
        keyed: reaction.keyed,
      };
    });
    this.core.validateBatch(extensionName, registered);
    return registered;
  }
}

/**
 * Normalizes a host-supplied deadline at the invocation boundary.
 *
 * Non-finite values (`NaN`, `±Infinity`) and `undefined` deterministically
 * mean "no deadline"; the raw input value still travels verbatim on the
 * execution context.
 * @param deadlineEpochMs - Raw host-supplied deadline, when one exists.
 * @returns A finite deadline in epoch milliseconds, or `undefined`.
 */
function normalizeDeadline(deadlineEpochMs: number | undefined): number | undefined {
  return deadlineEpochMs !== undefined && Number.isFinite(deadlineEpochMs) ? deadlineEpochMs : undefined;
}

/**
 * Creates the runtime-owned per-invocation cancellation wiring.
 *
 * The returned controller backs the signal the handler observes. When the
 * host supplied a signal or deadline, their aborts propagate into the
 * controller; `release()` detaches the listener and clears the timer and
 * MUST be called after the invocation settles. Deadlines beyond the platform
 * timer cap use a self-rescheduling timer that wakes at the cap and
 * re-checks.
 * @param hostSignal - Optional host-owned cancellation signal.
 * @param deadlineEpochMs - Already-normalized finite deadline, or `undefined`.
 * @returns The controller, deadline rejection, and cleanup.
 */
function createInvocationCancellation(
  hostSignal: AbortSignal | undefined,
  deadlineEpochMs: number | undefined,
): InvocationCancellation {
  const controller = new AbortController();
  const deadline =
    deadlineEpochMs === undefined ? undefined : { at: deadlineEpochMs, ...Promise.withResolvers<void>() };
  const releases: Array<() => void> = [];

  if (hostSignal) {
    const onAbort = (): void => {
      controller.abort(hostSignal.reason);
    };
    hostSignal.addEventListener('abort', onAbort, { once: true });
    releases.push(() => {
      hostSignal.removeEventListener('abort', onAbort);
    });
  }

  if (deadline) {
    // Mutable slot: `schedule` replaces the handle on every reschedule and
    // the release closure always clears the CURRENT handle.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (abortWhenDeadlineReached(controller, deadline.at)) {
        timer = undefined;
        deadline.resolve();
        return;
      }
      const remaining = deadline.at - Date.now();
      // setTimeout clamps delays above the platform cap to ~1ms, which would
      // abort far-future deadlines immediately — wake up at the cap instead
      // and re-check the remaining time.
      timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_DELAY_MS));
      // A deadline must not be the only resource keeping a server process alive;
      // web-standard numeric timer handles simply expose no `unref` capability.
      timer.unref?.();
    };
    schedule();
    releases.push(() => {
      clearTimeout(timer);
    });
  }

  return {
    controller,
    wait: (work) =>
      deadline
        ? Promise.race([
            work,
            deadline.promise.then(() => {
              throw controller.signal.reason;
            }),
          ])
        : work,
    release: (): void => {
      for (const release of releases) release();
    },
  };
}

/**
 * Aborts an invocation when its finite deadline has elapsed.
 *
 * This is shared by timer wakeups and the pre-handler entry gate: a timer
 * cannot observe a deadline while the event loop is occupied validating
 * parameters, but handler code must never begin once that deadline passed.
 * @param controller - Runtime-owned controller for this invocation.
 * @param deadlineEpochMs - Finite deadline in epoch milliseconds.
 * @returns Whether the deadline had elapsed when checked.
 */
function abortWhenDeadlineReached(controller: AbortController, deadlineEpochMs: number): boolean {
  if (deadlineEpochMs > Date.now()) return false;
  controller.abort(new Error(`Reaction invocation deadline reached (deadlineEpochMs: ${deadlineEpochMs})`));
  return true;
}

/**
 * Builds the frozen {@link ReactionExecutionContext} envelope for one
 * invocation.
 *
 * The envelope is frozen so a handler cannot reassign its fields. Its
 * `cause` is an opaque host-owned value passed through verbatim rather than
 * deep-cloned or frozen. Hosts detach it before invocation when they need
 * deeper isolation.
 * @param invocationId - Runtime-minted identifier for this invocation.
 * @param signal - Per-invocation runtime-controlled cancellation signal.
 * @param input - Host-supplied invocation input.
 * @returns Frozen execution envelope for the handler.
 */
function freezeExecutionContext(
  invocationId: ReactionInvocationId,
  signal: AbortSignal,
  input: ReactionInvocationInput,
): ReactionExecutionContext {
  return Object.freeze({
    invocationId,
    key: input.key,
    cause: input.cause,
    correlationId: input.correlationId,
    signal,
    deadlineEpochMs: input.deadlineEpochMs,
  });
}
