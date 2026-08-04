import type { IMakaioBus } from '@makaio/bus-core';
import type {
  ReactionDefinition,
  ReactionDescriptor,
  ReactionExecutionContext,
  ReactionInvocationId,
  ReactionOutcome,
  ReactionRuleRef,
} from '@makaio/contracts';
import { ReactionDescriptorSchema } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { getErrorString } from '@makaio/utils';

/**
 * Host-supplied input for a single Reaction invocation.
 *
 * The host has already evaluated its (consumer-owned) rule system and
 * resolved raw parameters before calling {@link ReactionRegistry.invoke};
 * this input carries everything the runtime needs to build the frozen
 * {@link ReactionExecutionContext} envelope for the handler. Its
 * `eventPayload`, `hostContext`, and `ruleRef` remain host-owned references;
 * hosts must detach them before invocation when they need deeper isolation.
 */
export interface ReactionInvocationInput {
  /** Event kind string the host evaluated when deciding to dispatch. */
  readonly eventKind: string;
  /** Event payload the host evaluated, passed through verbatim. */
  readonly eventPayload: unknown;
  /** Host-composed context, passed through verbatim. */
  readonly hostContext: unknown;
  /**
   * Opaque host-supplied reference to the rule that caused this dispatch, or
   * `undefined` when the host dispatched without a rule system.
   */
  readonly ruleRef?: ReactionRuleRef;
  /** Bus correlation identifier from the triggering message, when one exists. */
  readonly correlationId?: string;
  /**
   * Absolute deadline for this invocation as epoch milliseconds. An
   * invocation already past its deadline never enters handler code; a
   * deadline reached mid-flight aborts the per-invocation signal. Deadlines
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
  /** Detached descriptor used only for discovery. */
  readonly descriptor: ReactionDescriptor;
}

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
  /** Registered definitions grouped by owning extension. */
  private definitionsByExtension = new Map<string, readonly RegisteredReaction[]>();
  /** Global kind index for collision checks and dispatch lookup. */
  private definitionsByKind = new Map<string, RegisteredReaction>();

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
    this.definitionsByExtension.clear();
    this.definitionsByKind.clear();
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
    const registeredBatch = this.validateBatch(extensionName, reactions);

    const nextDefinitionsByExtension = new Map(this.definitionsByExtension);
    if (registeredBatch.length === 0) {
      nextDefinitionsByExtension.delete(extensionName);
    } else {
      nextDefinitionsByExtension.set(extensionName, registeredBatch);
    }

    const nextDefinitionsByKind = new Map<string, RegisteredReaction>();
    for (const definitions of nextDefinitionsByExtension.values()) {
      for (const definition of definitions) {
        nextDefinitionsByKind.set(definition.descriptor.kind, definition);
      }
    }
    this.definitionsByExtension = nextDefinitionsByExtension;
    this.definitionsByKind = nextDefinitionsByKind;
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
    if (!this.definitionsByExtension.has(extensionName)) return;
    this.register(extensionName, []);
  }

  /**
   * Returns detached serializable descriptors for all registered Reactions.
   *
   * Descriptor factories run only during successful batch validation; listing
   * cannot execute extension code or mutate the stored discovery snapshot.
   * @returns Detached discovery metadata for every registered Reaction.
   */
  public listDescriptors(): ReactionDescriptor[] {
    return Array.from(this.definitionsByKind.values(), ({ descriptor }) => structuredClone(descriptor));
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
   * - An already-aborted host signal or an already-past deadline fails the
   *   invocation without entering the handler; these cheap gates run BEFORE
   *   parameter validation, so an already-dead dispatch never pays for it.
   * - Parameters are validated against the Reaction's live Zod schema BEFORE
   *   handler entry; invalid parameters — and schema code that itself throws
   *   (e.g. a throwing transform) — never reach the handler and normalize to
   *   a failure outcome.
   * - Each invocation gets its own runtime-owned {@link AbortSignal}; the
   *   optional host signal and deadline propagate into it from parameter
   *   validation through handler settlement (listeners and timers are
   *   released after settle), and aborting one invocation never affects
   *   another. Cancellation is cooperative after handler entry: a mid-flight
   *   abort only signals the handler, and a handler that resolves anyway still
   *   yields a success outcome. A cancellation observed before handler entry
   *   always yields a failure outcome.
   * - The handler receives a frozen top-level invocation envelope.
   *   `eventPayload`, `hostContext`, and `ruleRef` are host-owned values passed
   *   through verbatim, not deep-cloned or frozen. Hosts detach those values
   *   before invocation when they need deeper isolation.
   * - Any thrown value (including non-`Error`) is caught, logged with the
   *   kind, invocation id, and correlation id, and normalized to a failure
   *   outcome.
   * @param kind - Canonical Reaction kind to invoke.
   * @param parameters - Host-resolved, not-yet-validated invocation parameters.
   * @param input - Host-supplied invocation input (event, context, controls).
   * @returns Normalized outcome of this invocation.
   */
  public async invoke(kind: string, parameters: unknown, input: ReactionInvocationInput): Promise<ReactionOutcome> {
    const invocationId: ReactionInvocationId = crypto.randomUUID();

    const registered = this.definitionsByKind.get(kind);
    if (!registered) {
      return this.failure(kind, invocationId, input.correlationId, `Reaction kind '${kind}' is not registered`);
    }
    // Cheapest gates first: an already-dead dispatch must not pay for full
    // async schema validation.
    if (input.hostSignal?.aborted) {
      return this.failure(kind, invocationId, input.correlationId, `Reaction '${kind}' host signal already aborted`);
    }
    const deadlineEpochMs = normalizeDeadline(input.deadlineEpochMs);
    if (deadlineEpochMs !== undefined && deadlineEpochMs <= Date.now()) {
      return this.failure(kind, invocationId, input.correlationId, `Reaction '${kind}' deadline already passed`);
    }

    // Cancellation ownership begins before the first async boundary, so a
    // host abort or deadline reached during async validation cannot race into
    // handler entry. The finally below releases this wiring after validation
    // failures as well as after handler settlement.
    const cancellation = createInvocationCancellation(input.hostSignal, deadlineEpochMs);
    // Capture every handler-visible top-level input field before the first
    // async boundary. The opaque host values intentionally remain shared by
    // reference, but subsequent reassignment on the input envelope cannot
    // change this invocation's context or post-validation log correlation.
    const context = freezeExecutionContext(invocationId, cancellation.controller.signal, input);
    try {
      // safeParseAsync supports async refinements (sync safeParse throws on
      // them), and the try/catch normalizes schema code that itself throws
      // (e.g. a throwing transform) — invalid or throwing validation must
      // never enter handler code, and invoke() must never reject.
      let parsed: Awaited<ReturnType<typeof registered.parameterSchema.safeParseAsync>>;
      try {
        parsed = await registered.parameterSchema.safeParseAsync(parameters);
      } catch (error) {
        return this.failure(
          kind,
          invocationId,
          context.correlationId,
          `Parameter validation for Reaction '${kind}' threw: ${getErrorString(error)}`,
          error,
        );
      }
      if (!parsed.success) {
        return this.failure(
          kind,
          invocationId,
          context.correlationId,
          `Invalid parameters for Reaction '${kind}': ${parsed.error.message}`,
        );
      }

      // Timers run only when the event loop regains control. Synchronous or
      // CPU-heavy schema validation can therefore carry an invocation past its
      // deadline before its timer callback runs. Re-check the authoritative
      // deadline immediately before handler entry.
      if (deadlineEpochMs !== undefined) {
        abortWhenDeadlineReached(cancellation.controller, deadlineEpochMs);
      }
      if (cancellation.controller.signal.aborted) {
        return this.failure(
          kind,
          invocationId,
          context.correlationId,
          `Reaction '${kind}' cancelled before handler entry: ${getErrorString(cancellation.controller.signal.reason)}`,
          cancellation.controller.signal.reason,
        );
      }

      await registered.handler(parsed.data, context);
      return { success: true };
    } catch (error) {
      // The outcome carries the extracted message; the log line names only the
      // failure site and lets the rendered error carry that message, avoiding
      // printing it twice in one console.error call.
      this.logFailure(kind, invocationId, context.correlationId, `Reaction '${kind}' handler threw`, error);
      return { success: false, error: { message: getErrorString(error) } };
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
   * @param message - Normalized failure message for the log line and outcome.
   * @param cause - Original thrown value, retained only in the log.
   * @returns Normalized failure outcome carrying `message`.
   */
  private failure(
    kind: string,
    invocationId: ReactionInvocationId,
    correlationId: string | undefined,
    message: string,
    cause?: unknown,
  ): ReactionOutcome {
    this.logFailure(kind, invocationId, correlationId, message, cause);
    return { success: false, error: { message } };
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
   * Validates a complete registration batch without mutating registry state.
   * @param extensionName - Owner of the proposed definitions.
   * @param reactions - Definitions to validate.
   * @returns Registered definitions paired with validated descriptor snapshots.
   * @throws If namespace, descriptor, or kind-uniqueness invariants are violated.
   */
  private validateBatch(
    extensionName: string,
    reactions: readonly ReactionDefinition[],
  ): readonly RegisteredReaction[] {
    const prefix = `${extensionName}.`;
    const pendingKinds = new Set<string>();
    const ownedKinds = new Set(
      this.definitionsByExtension.get(extensionName)?.map((reaction) => reaction.descriptor.kind),
    );
    const registered: RegisteredReaction[] = [];
    for (const reaction of reactions) {
      if (!reaction.kind.startsWith(prefix) || reaction.kind.length === prefix.length) {
        throw new Error(`Reaction '${reaction.kind}' must be namespaced by extension '${prefix}'`);
      }
      if (pendingKinds.has(reaction.kind)) {
        throw new Error(`Reaction kind collision: '${reaction.kind}' appears twice in batch from '${extensionName}'`);
      }
      if (this.definitionsByKind.has(reaction.kind) && !ownedKinds.has(reaction.kind)) {
        throw new Error(`Reaction kind collision: '${reaction.kind}' is already registered`);
      }
      pendingKinds.add(reaction.kind);
      const descriptor = ReactionDescriptorSchema.parse(reaction.toDescriptor());
      if (descriptor.kind !== reaction.kind) {
        throw new Error(
          `Reaction descriptor kind '${descriptor.kind}' does not match definition kind '${reaction.kind}'`,
        );
      }
      registered.push({ parameterSchema: reaction.parameterSchema, handler: reaction.handler, descriptor });
    }
    return registered;
  }
}

/** Shared release for invocations with no host signal and no deadline wired. */
const NOOP_RELEASE = (): void => {
  // Intentionally empty: nothing was wired, so nothing needs releasing.
};

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
 * @returns The controller and its release function.
 */
function createInvocationCancellation(
  hostSignal: AbortSignal | undefined,
  deadlineEpochMs: number | undefined,
): InvocationCancellation {
  const controller = new AbortController();
  if (hostSignal === undefined && deadlineEpochMs === undefined) {
    return { controller, release: NOOP_RELEASE };
  }
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

  if (deadlineEpochMs !== undefined) {
    // Mutable slot: `schedule` replaces the handle on every reschedule and
    // the release closure always clears the CURRENT handle.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (abortWhenDeadlineReached(controller, deadlineEpochMs)) {
        timer = undefined;
        return;
      }
      const remaining = deadlineEpochMs - Date.now();
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
 * `eventPayload`, `hostContext`, and `ruleRef` are opaque host-owned values
 * passed through verbatim rather than deep-cloned or frozen. Hosts detach
 * those values before invocation when they need deeper isolation.
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
    ruleRef: input.ruleRef,
    eventKind: input.eventKind,
    eventPayload: input.eventPayload,
    hostContext: input.hostContext,
    correlationId: input.correlationId,
    signal,
    deadlineEpochMs: input.deadlineEpochMs,
  });
}
