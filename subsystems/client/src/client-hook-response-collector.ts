/**
 * Concurrent deterministic contribution collector.
 *
 * Captures a registry snapshot (passed as input) and starts every eligible
 * contributor callback concurrently. Each callback receives a per-contributor
 * abort signal derived from the minimum of the request deadline and the
 * callback's own timeout. Results are categorised into runtime outcomes and,
 * when a `closed` failure occurs, the deterministic-first contributor (by
 * snapshot order, which is priority-then-ordinal) wins and all effects are
 * discarded.
 * @packageDocumentation
 */

import type {
  CanonicalEffect,
  ContributorCallbackContext,
  ContributorDefinition,
  ContributorResponse,
  FailurePolicy,
  ProviderContractCatalogEntry,
  ProviderContributionEnvelope,
  RuntimeOutcomeCode,
} from '@makaio/contracts/client';
import { DEFAULT_FAILURE_POLICY } from '@makaio/contracts/client';
import { validateContributorResponse } from './client-hook-response-validation.js';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/**
 * Severity level for a collection diagnostic.
 */
export type DiagnosticSeverity = 'warning' | 'error';

/**
 * Diagnostic recorded during contribution collection.
 *
 * Captures per-contributor failure details (timeouts, rejections,
 * validation failures) without blocking the collection pipeline.
 */
export interface CollectionDiagnostic {
  /** Contributor that produced this diagnostic. */
  readonly contributorId: string;
  /** Severity level. */
  readonly severity: DiagnosticSeverity;
  /** Human-readable diagnostic message. */
  readonly message: string;
  /** Root cause error, when available. */
  readonly cause?: unknown;
}

/**
 * Outcome record for a single contributor within a collection run.
 */
export interface ContributorOutcome {
  /** Contributor that produced this outcome. */
  readonly contributorId: string;
  /** Runtime outcome code. */
  readonly outcome: RuntimeOutcomeCode;
  /** Duration of the callback execution in milliseconds. */
  readonly durationMs: number;
  /**
   * Effects produced by the contributor, present only on `'success'`
   * outcomes.
   */
  readonly effects?: ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>;
}

/**
 * Result returned when the first `closed` failure (by snapshot order) is
 * detected.
 */
export interface ClosedFailureResult {
  /** Contributor ID of the first closed-failure contributor. */
  readonly contributorId: string;
  /** Human-readable detail. */
  readonly detail: string;
}

/**
 * Aggregate result of a contribution collection run.
 */
export interface CollectionResult {
  /** Per-contributor outcomes in snapshot order. */
  readonly outcomes: ReadonlyArray<ContributorOutcome>;
  /** Diagnostics recorded during collection. */
  readonly diagnostics: ReadonlyArray<CollectionDiagnostic>;
  /**
   * Present when at least one `closed`-policy contributor failed; contains
   * the deterministic first closed failure (by snapshot order).
   */
  readonly closedFailure?: ClosedFailureResult;
}

// ---------------------------------------------------------------------------
// Input type — decoupled from Task 3.1's registry
// ---------------------------------------------------------------------------

/**
 * Minimal registered contributor shape consumed by the collector.
 *
 * This is intentionally decoupled from the registry implementation so the
 * collector can be developed and tested independently.
 */
export interface RegisteredContributor {
  /** The contributor definition as declared by the extension. */
  readonly definition: ContributorDefinition;
  /**
   * Globally unique contributor identifier, namespaced by extension.
   *
   * When present, used in outcome and diagnostic records instead of
   * the local `definition.id`. Optional for backward compatibility
   * with tests that construct minimal registered contributors.
   */
  readonly namespacedId?: string;
}

// ---------------------------------------------------------------------------
// Sentinel for timeout races
// ---------------------------------------------------------------------------

const TIMEOUT_SENTINEL = Symbol('contributor-timeout');

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Discriminated union for a settled contributor callback result.
 */
type SettledResult =
  | { tag: 'ok'; response: ContributorResponse | undefined }
  | { tag: 'timeout' }
  | { tag: 'rejected'; error: unknown };

/**
 * Tracks a contributor callback in flight: its identity, timing, abort
 * controller, and the promise that settles to a {@link SettledResult}.
 */
interface PendingCallback {
  readonly contributorId: string;
  readonly definition: ContributorDefinition;
  readonly startMs: number;
  readonly abort: AbortController;
  readonly settled: Promise<SettledResult>;
}

/**
 * Classified result for a single contributor callback.
 *
 * Contains the outcome record and an optional diagnostic when the
 * contributor failed (timeout, rejection, or validation error).
 */
interface ClassifiedResult {
  /** The contributor's outcome record. */
  readonly outcome: ContributorOutcome;
  /** Diagnostic for the failure, absent on success. */
  readonly diagnostic?: CollectionDiagnostic;
}

// ---------------------------------------------------------------------------
// Internals — pure helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective failure policy for a contributor, falling back to
 * the default when none is declared.
 * @param def - Contributor definition.
 * @returns The effective failure policy.
 */
function effectivePolicy(def: ContributorDefinition): FailurePolicy {
  return def.failurePolicy ?? DEFAULT_FAILURE_POLICY;
}

/**
 * Resolve the contributor ID from a registered contributor entry.
 * @param entry - Registered contributor entry.
 * @returns The namespaced ID when present, otherwise the definition ID.
 */
function resolveContributorId(entry: RegisteredContributor): string {
  return entry.namespacedId ?? entry.definition.id;
}

/**
 * Map a failure policy to the appropriate failure outcome code.
 * @param policy - The contributor's effective failure policy.
 * @param openCode - Code to use for open-policy failures.
 * @returns `'closed-failure'` for closed policy, `openCode` otherwise.
 */
function failureOutcomeCode(policy: FailurePolicy, openCode: RuntimeOutcomeCode): RuntimeOutcomeCode {
  return policy === 'closed' ? 'closed-failure' : openCode;
}

/**
 * Build the effects array from a validated contributor response.
 * @param response - The contributor's response.
 * @returns A flat array of canonical effects and provider envelopes, or
 *   `undefined` when the response produced nothing.
 */
function extractEffects(
  response: ContributorResponse | undefined,
): ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope> | undefined {
  if (!response) return undefined;

  const parts: Array<CanonicalEffect | ProviderContributionEnvelope> = [];

  if (response.canonicalEffects) {
    parts.push(...response.canonicalEffects);
  }
  if (response.providerEnvelope) {
    parts.push(response.providerEnvelope);
  }

  return parts.length > 0 ? parts : undefined;
}

/**
 * Race a contributor's callback promise against a timeout.
 *
 * Returns the contributor response on success, or the
 * {@link TIMEOUT_SENTINEL} when the cutoff expires first. The provided
 * `abort` controller is signalled on timeout so the callback can
 * cooperatively cancel.
 * @param promise - The contributor callback promise.
 * @param deadline - Absolute callback deadline in epoch milliseconds.
 * @param abort - AbortController to signal on timeout.
 * @returns The callback response or the timeout sentinel.
 */
function raceTimeout(
  promise: Promise<ContributorResponse | undefined>,
  deadline: number,
  abort: AbortController,
): Promise<ContributorResponse | undefined | typeof TIMEOUT_SENTINEL> {
  const cutoffMs = deadline - Date.now();
  if (cutoffMs <= 0 || abort.signal.aborted) {
    abort.abort(new Error('Contributor deadline expired'));
    return Promise.resolve(TIMEOUT_SENTINEL);
  }

  return new Promise<ContributorResponse | undefined | typeof TIMEOUT_SENTINEL>((resolve, reject) => {
    let settled = false;
    const finish = (result: ContributorResponse | undefined | typeof TIMEOUT_SENTINEL): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      abort.abort(new Error('Contributor timeout'));
      finish(TIMEOUT_SENTINEL);
    }, cutoffMs);
    const onAbort = () => finish(TIMEOUT_SENTINEL);
    abort.signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (result) => {
        // Guard against the race where the callback completes just
        // after the cutoff but before the timer fires — treat it as
        // a timeout to maintain deadline integrity.
        if (Date.now() >= deadline) {
          abort.abort(new Error('Contributor timeout'));
          finish(TIMEOUT_SENTINEL);
        } else {
          finish(result);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Internals — extracted phases
// ---------------------------------------------------------------------------

/**
 * Build the result for the expired-deadline fast path.
 *
 * All contributors are marked as timed out (or closed-failure for closed-
 * policy contributors) with zero duration.
 * @param snapshot - The contributor snapshot.
 * @returns A complete {@link CollectionResult} with no effects.
 */
function buildExpiredDeadlineResult(snapshot: ReadonlyArray<RegisteredContributor>): CollectionResult {
  const outcomes: ContributorOutcome[] = [];
  const diagnostics: CollectionDiagnostic[] = [];
  const detail = 'Request deadline already expired before collection started';

  for (const entry of snapshot) {
    const id = resolveContributorId(entry);
    const code = failureOutcomeCode(effectivePolicy(entry.definition), 'timeout');
    outcomes.push({ contributorId: id, outcome: code, durationMs: 0 });
    diagnostics.push({ contributorId: id, severity: 'error', message: detail });
  }

  const firstClosed = outcomes.find((o) => o.outcome === 'closed-failure');
  const closedFailure = firstClosed ? { contributorId: firstClosed.contributorId, detail } : undefined;

  return { outcomes, diagnostics, closedFailure };
}

/**
 * Compose a per-contributor abort controller with the request-level signal.
 *
 * When the request signal is already aborted, the contributor's controller
 * is aborted immediately. Otherwise, a listener is installed that forwards
 * the abort and cleans up when the contributor's own controller fires.
 * @param abort - Per-contributor abort controller.
 * @param requestSignal - The originating request's abort signal.
 */
function composeAbortSignal(abort: AbortController, requestSignal: AbortSignal): void {
  if (requestSignal.aborted) {
    abort.abort(requestSignal.reason);
    return;
  }

  const onRequestAbort = () => {
    abort.abort(requestSignal.reason);
  };
  requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  abort.signal.addEventListener(
    'abort',
    () => {
      requestSignal.removeEventListener('abort', onRequestAbort);
    },
    { once: true },
  );
}

/**
 * Start a single contributor callback and race it against its timeout.
 * @param entry - Registered contributor entry.
 * @param clientId - Client receiving the hook event.
 * @param requestDeadline - Absolute epoch-ms request deadline, or `undefined`.
 * @param requestSignal - The request-level abort signal, or `undefined`.
 * @param eventName - Hook event name.
 * @param eventPayload - Hook event payload.
 * @returns A {@link PendingCallback} tracking the in-flight callback.
 */
function startContributorCallback(
  entry: RegisteredContributor,
  clientId: string,
  requestDeadline: number | undefined,
  requestSignal: AbortSignal | undefined,
  eventName: string,
  eventPayload: unknown,
): PendingCallback {
  const { definition: def } = entry;
  const contributorId = resolveContributorId(entry);
  const startMs = Date.now();

  const callbackDeadline = startMs + def.timeoutMs;
  const effectiveDeadline =
    requestDeadline !== undefined ? Math.min(requestDeadline, callbackDeadline) : callbackDeadline;
  const cutoffMs = effectiveDeadline - startMs;

  const abort = new AbortController();
  if (requestSignal) {
    composeAbortSignal(abort, requestSignal);
  }

  const ctx: ContributorCallbackContext = {
    clientId,
    deadline: effectiveDeadline,
    remainingBudgetMs: cutoffMs,
    signal: abort.signal,
    eventName,
    eventPayload,
  };

  if (abort.signal.aborted) {
    return {
      contributorId,
      definition: def,
      startMs,
      abort,
      settled: Promise.resolve({ tag: 'timeout' }),
    };
  }

  let callbackPromise: Promise<ContributorResponse | undefined>;
  try {
    const maybePromise = def.respond(ctx);
    callbackPromise = maybePromise instanceof Promise ? maybePromise : Promise.resolve(maybePromise);
  } catch (syncError: unknown) {
    callbackPromise = Promise.reject(syncError);
  }

  const settled: Promise<SettledResult> = raceTimeout(callbackPromise, effectiveDeadline, abort).then(
    (result): SettledResult => {
      if (result === TIMEOUT_SENTINEL) {
        return { tag: 'timeout' };
      }
      return { tag: 'ok', response: result };
    },
    (error: unknown): SettledResult => {
      return { tag: 'rejected', error };
    },
  );

  return { contributorId, definition: def, startMs, abort, settled };
}

/**
 * Classify a single settled callback result into an outcome and optional
 * diagnostic.
 * @param pending - The pending callback record.
 * @param result - The settled result from the callback race.
 * @param clientId - Client receiving the hook event.
 * @param providerContract - Exact active provider contract for this request.
 * @param eventName - Hook event name.
 * @param eventPayload - Hook event payload.
 * @returns A tuple of the outcome and an optional diagnostic.
 */
function classifyResult(
  pending: PendingCallback,
  result: SettledResult,
  clientId: string,
  providerContract: ProviderContractCatalogEntry | undefined,
  eventName: string,
  eventPayload: unknown,
): ClassifiedResult {
  const { contributorId: cId, definition: def, startMs, abort } = pending;
  const durationMs = Date.now() - startMs;
  const policy = effectivePolicy(def);

  if (!abort.signal.aborted) {
    abort.abort(new Error('Collection complete'));
  }

  if (result.tag === 'timeout') {
    const message = `Contributor timed out after ${durationMs}ms`;
    return {
      outcome: {
        contributorId: cId,
        outcome: failureOutcomeCode(policy, 'timeout'),
        durationMs,
      },
      diagnostic: { contributorId: cId, severity: 'error', message },
    };
  }

  if (result.tag === 'rejected') {
    const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
    const message = `Contributor rejected: ${errorMessage}`;
    return {
      outcome: {
        contributorId: cId,
        outcome: failureOutcomeCode(policy, 'rejection'),
        durationMs,
      },
      diagnostic: {
        contributorId: cId,
        severity: 'error',
        message,
        cause: result.error,
      },
    };
  }

  // result.tag === 'ok' — validate the response
  const { response } = result;

  const validation = validateContributorResponse(response, def, clientId, providerContract, eventName, eventPayload);
  if (validation !== true) {
    const message = `Validation failed: ${validation}`;
    return {
      outcome: {
        contributorId: cId,
        outcome: failureOutcomeCode(policy, 'rejection'),
        durationMs,
      },
      diagnostic: { contributorId: cId, severity: 'error', message },
    };
  }

  return {
    outcome: {
      contributorId: cId,
      outcome: 'success',
      durationMs,
      effects: extractEffects(response),
    },
  };
}

/**
 * Apply the closed-failure policy to finalize the collection result.
 *
 * When at least one `closed`-policy contributor failed, all effects are
 * stripped from every outcome. The deterministic first closed failure (by
 * snapshot order) is returned.
 * @param outcomes - Mutable outcome array from the processing phase.
 * @param diagnostics - Diagnostic array from the processing phase.
 * @returns The finalized {@link CollectionResult}.
 */
function applyClosedFailurePolicy(
  outcomes: ContributorOutcome[],
  diagnostics: CollectionDiagnostic[],
): CollectionResult {
  const firstClosed = outcomes.find((o) => o.outcome === 'closed-failure');
  if (!firstClosed) {
    return { outcomes, diagnostics };
  }

  const closedFailure: ClosedFailureResult = {
    contributorId: firstClosed.contributorId,
    detail: diagnostics.find((d) => d.contributorId === firstClosed.contributorId)?.message ?? 'Closed failure',
  };

  const stripped = outcomes.map((o) => {
    if (o.effects) {
      const { effects: _effects, ...rest } = o;
      return rest;
    }
    return o;
  });

  return { outcomes: stripped, diagnostics, closedFailure };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect contributions from a snapshot of registered contributors
 * concurrently and deterministically.
 *
 * Every eligible callback is started before any result is awaited
 * (Promise.all-style concurrency). Each callback receives a per-contributor
 * abort signal derived from the minimum of the request deadline and the
 * callback's own timeout. Late results are ignored even when the callback
 * code ignores cancellation.
 *
 * Failure handling follows the contributor's declared failure policy:
 * - **open** — the contributor's result is omitted but siblings are
 *   retained.
 * - **closed** — all partial effects are discarded and the deterministic
 *   first closed failure (by snapshot order) is returned.
 * @param snapshot - Ordered array of registered contributors (priority-
 *   then-ordinal). The collector does not re-sort.
 * @param clientId - Client receiving the hook event.
 * @param requestDeadline - Absolute epoch-ms deadline for the overall
 *   request, or `undefined` for no request-level deadline.
 * @param requestSignal - The originating request's abort signal, or
 *   `undefined` when not available. Composed with per-contributor signals.
 * @param eventName - The hook event name that triggered collection.
 * @param eventPayload - The hook event payload, opaque at this layer.
 * @param providerContract - Exact active provider contract for this request.
 * @returns A promise resolving to the {@link CollectionResult}.
 */
export async function collectContributions(
  snapshot: ReadonlyArray<RegisteredContributor>,
  clientId: string,
  requestDeadline: number | undefined,
  requestSignal: AbortSignal | undefined,
  eventName: string,
  eventPayload: unknown,
  providerContract?: ProviderContractCatalogEntry,
): Promise<CollectionResult> {
  if (snapshot.length === 0) {
    return { outcomes: [], diagnostics: [] };
  }

  if (requestDeadline !== undefined && requestDeadline <= Date.now()) {
    return buildExpiredDeadlineResult(snapshot);
  }

  // Start all callbacks concurrently
  const pending = snapshot.map((entry) =>
    startContributorCallback(entry, clientId, requestDeadline, requestSignal, eventName, eventPayload),
  );

  // Await all results
  const rawResults = await Promise.all(pending.map((p) => p.settled));

  // Classify each result into outcomes and diagnostics
  const outcomes: ContributorOutcome[] = [];
  const diagnostics: CollectionDiagnostic[] = [];

  for (let i = 0; i < pending.length; i++) {
    const { outcome, diagnostic } = classifyResult(
      pending[i],
      rawResults[i],
      clientId,
      providerContract,
      eventName,
      eventPayload,
    );
    outcomes.push(outcome);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }

  return applyClosedFailurePolicy(outcomes, diagnostics);
}
