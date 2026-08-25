import type { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  boundCodeExecutionFailureMessage,
  CODE_EXECUTION_CAPABILITY_ID,
  codeExecutionAbortOutcomeForReason,
  CodeExecutionOutcomeSchema,
  CodeExecutionRequestSchema,
  CodeExecutionSubjects,
  type CodeExecutionFailedOutcomeCode,
  type CodeExecutionOutcome,
  type CodeExecutionRequest,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { CapabilityService } from '../capability/capability-service.js';
import { createEffectiveExecutionSignal, type EffectiveExecutionSignal } from './execution-signal.js';
import {
  selectCodeExecutionProvider,
  type CodeExecutionProviderSelected,
  type CodeExecutionSelectionFailureCode,
} from './provider-selection.js';

/** Log prefix for the router's local diagnostics. */
const LOG_PREFIX = '[CodeExecutionService]';

/** Stable, non-secret summaries for every failure this router produces itself. */
const FAILURE_MESSAGES: Readonly<Record<CodeExecutionSelectionFailureCode, string>> = {
  provider_unavailable: 'No registered code-execution provider satisfies the request requirements',
  invalid_provider: 'A registered code-execution provider does not satisfy the provider contract',
};

/**
 * Outcome of one contained parse at a router boundary.
 * @typeParam TValue - Contract type the boundary schema produces.
 */
type BoundaryParse<TValue> =
  | {
      /** Discriminant: the value satisfies the contract schema. */
      readonly ok: true;
      /** The value, narrowed to its contract type. */
      readonly value: TValue;
    }
  | {
      /** Discriminant: the value was rejected. */
      readonly ok: false;
      /** Validation error, or the exception the value itself raised. */
      readonly cause: unknown;
    };

/**
 * Validate one untrusted value against a contract schema without letting the
 * validation itself throw.
 *
 * `safeParse` contains schema violations but not exceptions raised by the
 * value under inspection: reading a property off an object with a throwing
 * accessor or a hostile proxy trap propagates out of the parse. Both of this
 * router's trust boundaries receive objects produced elsewhere — a handler
 * chain upstream, a provider downstream — so a value that cannot even be read
 * is classified as a rejection like any other rather than escaping to reject
 * the bus handler.
 * @param schema - Contract schema the value must satisfy.
 * @param value - Untrusted value delivered at a router boundary.
 * @typeParam TValue - Contract type the schema produces.
 * @returns The narrowed value, or the cause of its rejection.
 */
function parseAtBoundary<TValue>(schema: z.ZodType<TValue>, value: unknown): BoundaryParse<TValue> {
  try {
    const result = schema.safeParse(value);
    return result.success ? { ok: true, value: result.data } : { ok: false, cause: result.error };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * Build a `failed` outcome with a bounded summary.
 *
 * Summaries interpolate host-controlled provider identifiers of unbounded
 * length, so every one of them goes through the contract's own bounding helper
 * rather than being trusted to stay short.
 *
 * Naming the faulting provider in a bus-visible summary is deliberate: a
 * provider id is registry metadata the host itself composed, not
 * provider-internal error content and not user data, and it is the only thing
 * that makes a composition fault actionable for whoever wired the host up.
 * @param code - Failure classification for the outcome.
 * @param message - Short, non-secret summary of what went wrong.
 * @returns The normalized `failed` outcome.
 */
function failed(code: CodeExecutionFailedOutcomeCode, message: string): CodeExecutionOutcome {
  return { status: 'failed', error: { code, message: boundCodeExecutionFailureMessage(message) } };
}

/**
 * Start one admitted provider's execution and hand back only its promise.
 *
 * Synchronous by construction, and that is the whole reason it exists as its own
 * function: it never suspends, so it retains nothing after it returns, and the
 * router's `invoke` — which *does* suspend, possibly forever — can therefore be
 * given the settlement instead of the request that produced it.
 * A provider that throws synchronously is turned into a rejection so that both
 * failure shapes reach the same normalization.
 *
 * The live registration is never *read* here beyond being handed on as a `this`
 * binding, and the entry point is invoked through `Reflect.apply` rather than
 * through its own `.call`. Every part of that matters, because the registration
 * is an object an extension composed and no schema validated:
 *
 * - `execute.call` is a property lookup *on the submitted function*, which a
 *   hostile registration is free to define as an own throwing getter or as a
 *   different callable. `Reflect.apply` uses the intrinsic, so what runs is the
 *   function selection admitted, invoked the way selection promised.
 * - The callable and the identifier come from the selection result, never from a
 *   later read of `provider`. Re-reading `provider.execute` would invoke whatever
 *   the registration answers *now*, so a stateful getter could pass validation
 *   with a real handler and then hand back something else — or throw — leaving
 *   the router to run what selection never admitted. Re-reading `provider.id`
 *   would put an untrusted property access on the very path that exists to
 *   normalize an untrusted provider's failure.
 * - The registration itself is still passed as the `this` binding, because a
 *   class-based provider relies on it.
 * @param selected - Selection result carrying the admitted provider, its id, and its entry point.
 * @param request - Prepared, JSON-safe invocation to execute.
 * @param signal - Effective cancellation and deadline ownership for this execution.
 * @returns The provider's settlement; a synchronous throw is returned as a rejection.
 */
function callProvider(
  selected: CodeExecutionProviderSelected,
  request: CodeExecutionRequest,
  signal: EffectiveExecutionSignal,
): Promise<unknown> {
  try {
    return Promise.resolve(Reflect.apply(selected.execute, selected.provider, [request, signal.context]));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Framework router for the `code-execution.execute` subject.
 *
 * Routes one prepared, JSON-safe invocation to exactly one locally registered
 * provider and returns one normalized terminal outcome. The service owns
 * three things and nothing else:
 *
 * - **Selection.** Providers live in the capability registry's
 *   `code-execution` bucket as live objects; this service never keeps a
 *   second registry and re-reads the bucket for every invocation, so
 *   registrations that arrive or disappear between invocations are honored.
 * - **Budget.** One effective signal combines the request budget, the
 *   inherited request deadline, and caller cancellation, and is what the
 *   provider observes.
 * - **Normalization.** Every path — missing provider, malformed
 *   registration, provider throw, non-conforming outcome, timeout,
 *   cancellation — resolves to a schema-valid outcome. The handler does not
 *   reject.
 *
 * There is deliberately **no fallback after admission**: once a provider has
 * been handed the invocation, its failure is normalized, never retried
 * against a second provider. Retrying would run submitted code twice under a
 * different trust level than the one selection admitted.
 */
export class CodeExecutionService extends BaseService {
  /**
   * @param bus - Bus instance the execute handler is registered on.
   * @param capabilities - Live capability registry holding the provider bucket.
   */
  public constructor(
    bus: IMakaioBus,
    private readonly capabilities: CapabilityService,
  ) {
    super(bus);
  }

  protected onInit(): void {
    this.registerHandler(CodeExecutionSubjects.execute, async (ctx) => {
      ctx.setResult(await this.dispatch(ctx.payload, ctx.signal, ctx.deadline));
    });
  }

  /**
   * Validate the delivered payload, then route it.
   *
   * The caller-facing input already carries typed JSON fields, but parsing
   * remains the router's own runtime trust boundary: a handler chain can
   * replace a payload after the bus validated it, and a subject that executes
   * submitted code must not hand an unvalidated program to a provider on that
   * basis.
   * @param payload - Payload as delivered to this handler.
   * @param callerSignal - Caller cancellation signal; present only for local dispatch.
   * @param requestDeadlineEpochMs - Absolute deadline inherited from the request, when any.
   * @returns Exactly one normalized terminal outcome.
   */
  private async dispatch(
    payload: unknown,
    callerSignal: AbortSignal | undefined,
    requestDeadlineEpochMs: number | undefined,
  ): Promise<CodeExecutionOutcome> {
    const validated = parseAtBoundary(CodeExecutionRequestSchema, payload);
    if (!validated.ok) {
      console.error(`${LOG_PREFIX} rejected an invocation that failed request validation:`, validated.cause);
      return failed('invalid_program', 'The invocation failed request contract validation');
    }
    return this.route(validated.value, callerSignal, requestDeadlineEpochMs);
  }

  /**
   * Route one invocation to a single provider and normalize its outcome.
   *
   * Budget ownership is established *before* selection, and deliberately so.
   * An invocation whose caller already went away, or whose inherited deadline
   * had already passed, was never going to run no matter what the registry
   * holds; reporting `provider_unavailable` or `invalid_provider` for it would
   * name a local composition fault as the cause of something the caller
   * decided. The signal is released on every path, including selection
   * failure.
   * @param request - Prepared, JSON-safe invocation to execute.
   * @param callerSignal - Caller cancellation signal; present only for local dispatch.
   * @param requestDeadlineEpochMs - Absolute deadline inherited from the request, when any.
   * @returns Exactly one normalized terminal outcome.
   */
  private async route(
    request: CodeExecutionRequest,
    callerSignal: AbortSignal | undefined,
    requestDeadlineEpochMs: number | undefined,
  ): Promise<CodeExecutionOutcome> {
    const signal = createEffectiveExecutionSignal({
      timeoutMs: request.timeoutMs,
      requestDeadlineEpochMs,
      callerSignal,
    });
    try {
      // Already settled before anything was selected — an abandoned caller or
      // an inherited deadline that had passed.
      if (signal.abortReason !== undefined) return codeExecutionAbortOutcomeForReason(signal.abortReason);

      const selection = selectCodeExecutionProvider(
        this.capabilities.getProviders(CODE_EXECUTION_CAPABILITY_ID),
        request.requirements,
      );
      if (!selection.admitted) return failed(selection.code, FAILURE_MESSAGES[selection.code]);

      // A provider receives the live request object and can synchronously
      // mutate it before returning its settlement. Everything the router needs
      // after entering provider code must therefore be copied first: reading a
      // now-hostile accessor while constructing `invoke` would reject the bus
      // handler and leave an already-rejected provider settlement unobserved.
      const invocationId = request.invocationId;
      const settlement = callProvider(selection, request, signal);
      const invocation = this.invoke(settlement, selection.id, invocationId, signal);

      // The race is what bounds a provider that never settles: `invoke` alone
      // would wait forever on one. A provider settlement that lands after the
      // signal won is discarded, which is why `invoke` never rejects.
      //
      // The provider call is started *here*, synchronously, and only its promise
      // is handed on. That is what keeps a provider which never settles from
      // pinning the request: see {@link invoke} for the invariant, which this
      // split exists to make possible. The abort arm captures nothing but the
      // signal, so it is bounded whichever way the race goes.
      return await Promise.race([invocation, signal.aborted.then(codeExecutionAbortOutcomeForReason)]);
    } finally {
      signal.release();
    }
  }

  /**
   * Validate what one admitted provider produced.
   *
   * Never rejects: a provider throw and a non-conforming outcome both
   * normalize here, so the caller's race only ever sees terminal outcomes.
   * A settlement observed after the effective signal aborted is reported as
   * that abort rather than as a provider fault — the provider was stopped, it
   * did not fail.
   *
   * INVARIANT: nothing this function holds while suspended may be proportional
   * to the request. A provider is free to ignore its abort signal and never
   * settle, in which case the race in {@link route} answers the caller and *this*
   * frame stays suspended for the life of the process — a suspended async
   * function retains its parameters, so a `CodeExecutionRequest` parameter would
   * pin that invocation's whole program and arguments, megabytes apiece, once per
   * timed-out call. It therefore receives the two bounded strings the post-await
   * code actually needs instead of the request they came from, and the provider
   * call itself is started by {@link callProvider} in the caller so that neither
   * the request nor the selection result is a parameter here. `settlement` is the
   * provider's own promise: whatever *it* retains is the provider's to answer for,
   * and is what the abort signal exists to cut short.
   * @param settlement - Promise the admitted entry point produced, already started.
   * @param providerId - Identifier selection snapshotted for the admitted provider.
   * @param invocationId - Correlation identifier, for local diagnostics only.
   * @param signal - Effective cancellation and deadline ownership for this execution.
   * @returns The provider's validated outcome, or its normalized failure.
   */
  private async invoke(
    settlement: Promise<unknown>,
    providerId: string,
    invocationId: string,
    signal: EffectiveExecutionSignal,
  ): Promise<CodeExecutionOutcome> {
    let produced: unknown;
    try {
      produced = await settlement;
    } catch (error) {
      if (signal.abortReason !== undefined) return codeExecutionAbortOutcomeForReason(signal.abortReason);
      this.logDiagnostic(invocationId, providerId, 'execute() rejected', error);
      return failed('provider_failed', `Provider '${providerId}' failed while executing the invocation`);
    }

    // Deliberately not re-checked against the wall clock. A provider that
    // blocked the event loop past the deadline settles `completed` here,
    // because the expired timer's macrotask has not run yet when this
    // microtask continuation does. That is the intended semantics: the
    // execution finished and its side effects already happened, so reporting
    // `timed_out` would misreport work that is done. The budget is a liveness
    // bound enforced through the abort signal, not a wall-clock invalidation of
    // finished work. What this check *does* cover is the honest case — a signal
    // that had already aborted before the provider settled.
    if (signal.abortReason !== undefined) return codeExecutionAbortOutcomeForReason(signal.abortReason);

    const validated = parseAtBoundary(CodeExecutionOutcomeSchema, produced);
    if (!validated.ok) {
      this.logDiagnostic(invocationId, providerId, 'returned a non-conforming outcome', validated.cause);
      return failed('invalid_provider', `Provider '${providerId}' returned a value that is not a terminal outcome`);
    }
    return validated.value;
  }

  /**
   * Record the detailed cause of a provider fault locally.
   *
   * Causes stay here on purpose: the outcome that crosses the bus carries a
   * bounded summary, so stack traces, paths, and provider-internal error
   * objects never leave the host that observed them.
   * @param invocationId - Correlation identifier of the invocation whose provider faulted.
   * @param providerId - Identifier the selector snapshotted for the faulting provider.
   * @param summary - What the provider did wrong.
   * @param cause - Original thrown value or validation error, retained only in the log.
   */
  private logDiagnostic(invocationId: string, providerId: string, summary: string, cause: unknown): void {
    console.error(`${LOG_PREFIX} provider '${providerId}' ${summary} for invocation '${invocationId}':`, cause);
  }
}
