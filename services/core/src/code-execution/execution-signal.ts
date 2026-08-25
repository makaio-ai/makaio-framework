import type { CodeExecutionAbortReason, CodeExecutionProviderContext } from '@makaio/contracts';

/**
 * Largest delay `setTimeout` accepts before silently clamping to ~1ms.
 *
 * A budget beyond this must wake at the cap and re-check rather than fire
 * immediately, which would report a spurious timeout for a far deadline.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Inputs from which one effective execution signal is derived. */
export interface EffectiveExecutionSignalOptions {
  /**
   * Wall-clock execution budget declared by the request, in milliseconds.
   *
   * Must be finite and non-negative; a budget of zero is an already-exhausted
   * one and settles as a timeout immediately.
   */
  readonly timeoutMs: number;
  /** Absolute deadline inherited from the dispatching request, when it carried one. */
  readonly requestDeadlineEpochMs?: number;
  /** Caller cancellation signal; present only for local dispatch. */
  readonly callerSignal?: AbortSignal;
}

/**
 * One execution's effective cancellation and deadline ownership.
 *
 * Combines the request budget, the inherited request deadline, and caller
 * cancellation into the single authoritative signal the provider observes,
 * and records which of them settled it.
 */
export interface EffectiveExecutionSignal {
  /** Provider-facing context carrying the effective signal and deadline. */
  readonly context: CodeExecutionProviderContext;
  /** Reason the signal aborted, or `undefined` while the execution is live. */
  readonly abortReason: CodeExecutionAbortReason | undefined;
  /**
   * Resolves with the abort reason once the signal aborts; never rejects.
   *
   * Stays pending forever when the execution settles first, so callers race
   * it against the provider rather than awaiting it.
   */
  readonly aborted: Promise<CodeExecutionAbortReason>;
  /**
   * Detach the caller listener and clear the deadline timer.
   *
   * Idempotent, and safe to call on every settlement path — including after
   * the signal already aborted.
   */
  release(): void;
}

/**
 * Resolve the effective deadline for one execution.
 *
 * The budget is always binding; an inherited request deadline can only pull
 * it earlier, never extend it. A non-finite inherited deadline is treated as
 * absent so a malformed value cannot shorten or erase the budget.
 *
 * The budget itself cannot be treated that leniently: it is the only source of
 * a deadline, so an unusable one yields no deadline at all. A `NaN` budget in
 * particular produces a `NaN` deadline, which never compares as elapsed and
 * makes the timer re-arm at the platform minimum forever, so it is rejected at
 * the boundary instead of becoming an execution that silently never times out.
 * @param timeoutMs - Wall-clock execution budget declared by the request.
 * @param requestDeadlineEpochMs - Absolute deadline inherited from the request, when any.
 * @returns The earliest binding deadline as a Unix epoch timestamp in milliseconds.
 * @throws {@link TypeError} When the budget is not a finite, non-negative number.
 */
function resolveDeadline(timeoutMs: number, requestDeadlineEpochMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError(`Execution budget "timeoutMs" must be a finite, non-negative number, received ${timeoutMs}.`);
  }
  const budgetDeadlineEpochMs = Date.now() + timeoutMs;
  if (requestDeadlineEpochMs === undefined || !Number.isFinite(requestDeadlineEpochMs)) {
    return budgetDeadlineEpochMs;
  }
  return Math.min(budgetDeadlineEpochMs, requestDeadlineEpochMs);
}

/**
 * Create the effective cancellation and deadline ownership for one execution.
 *
 * The returned signal aborts at the earliest of the request budget, the
 * inherited request deadline, and caller cancellation. Caller cancellation
 * is checked before the deadline so an already-abandoned invocation reports
 * `cancellation` rather than a timeout it never got the chance to exceed.
 *
 * Every listener and timer this installs is removed by
 * {@link EffectiveExecutionSignal.release}, which the caller must invoke on
 * every settlement path.
 *
 * The budget is validated before anything is armed. The bus path already
 * rejects an unusable one through the request schema, but this factory is
 * exported for direct composition too, and there is no signal to hand back for
 * a budget that yields no deadline.
 * @param options - Request budget, inherited deadline, and caller signal.
 * @returns The provider-facing context, the settling reason, and its release.
 * @throws {@link TypeError} When `timeoutMs` is not a finite, non-negative number.
 */
export function createEffectiveExecutionSignal(options: EffectiveExecutionSignalOptions): EffectiveExecutionSignal {
  const { timeoutMs, requestDeadlineEpochMs, callerSignal } = options;
  const deadlineEpochMs = resolveDeadline(timeoutMs, requestDeadlineEpochMs);
  const controller = new AbortController();

  let abortReason: CodeExecutionAbortReason | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveAborted: (reason: CodeExecutionAbortReason) => void = () => undefined;
  const aborted = new Promise<CodeExecutionAbortReason>((resolve) => {
    resolveAborted = resolve;
  });

  const onCallerAbort = (): void => {
    settle('cancellation');
  };

  /** Remove the caller listener and clear the deadline timer. Idempotent. */
  function release(): void {
    clearTimeout(timer);
    timer = undefined;
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }

  /**
   * Record the settling reason once and abort the effective signal.
   *
   * The reason is placed on the signal itself rather than wrapped in an error
   * message: this factory is the only party that knows whether the budget ran
   * out or the caller went away, and a provider that had to re-derive it by
   * comparing its clock to the deadline would race the very settlement it is
   * classifying.
   * @param reason - Reason this execution settled.
   */
  function settle(reason: CodeExecutionAbortReason): void {
    if (abortReason !== undefined) return;
    abortReason = reason;
    // Detached before aborting so no wiring can observe its own settlement.
    release();
    controller.abort(reason);
    resolveAborted(reason);
  }

  /**
   * Arm the deadline, waking at the platform timer cap for far deadlines.
   *
   * `setTimeout` clamps delays above the cap to ~1ms, which would abort a far
   * deadline immediately; waking at the cap and re-checking keeps the
   * absolute deadline authoritative.
   */
  function armDeadline(): void {
    const remainingMs = deadlineEpochMs - Date.now();
    if (remainingMs <= 0) {
      settle('timeout');
      return;
    }
    timer = setTimeout(armDeadline, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
    // An execution budget must not be the only thing keeping a host alive.
    timer.unref?.();
  }

  if (callerSignal?.aborted === true) {
    settle('cancellation');
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    armDeadline();
  }

  return {
    context: { signal: controller.signal, deadlineEpochMs },
    get abortReason(): CodeExecutionAbortReason | undefined {
      return abortReason;
    },
    aborted,
    release,
  };
}
