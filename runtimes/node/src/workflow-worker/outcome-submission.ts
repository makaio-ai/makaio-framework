import {
  ConnectionLostError,
  getFullSubjectForSubjectDefinition,
  isNoHandlerErrorForSubject,
  TimeoutError,
  type IMakaioBus,
} from '@makaio/bus-core';
import { WebSocketConnectionError } from '@makaio/bus-transport-websocket';
import {
  JobRunOutcomeNamespace,
  OutcomeSubmitRequestSchema,
  OutcomeSubmitResponseSchema,
  WorkerSubjects,
  type OutcomeAckDecision,
  type OutcomeSubmitRequest,
  type OutcomeSubmitResponse,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { deepFreeze } from '@makaio/utils';
import type { CallContext } from '@makaio/core';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

/**
 * Tunable retry parameters for outcome submission.
 *
 * All fields are optional; the harness supplies sane defaults when
 * the caller omits them.
 */
export interface OutcomeSubmitRetryConfig {
  /**
   * Maximum number of retry attempts after the first submission
   * attempt fails (total attempts = maxRetries + 1).
   * Defaults to 7.
   */
  readonly maxRetries?: number;

  /**
   * Base delay in milliseconds for exponential back-off between
   * retry attempts. The actual delay for attempt N is
   * `baseDelayMs * 2^(N-1)`, capped at {@link maxDelayMs}.
   * Defaults to 1000.
   */
  readonly baseDelayMs?: number;

  /**
   * Maximum delay in milliseconds for any single back-off pause.
   * Defaults to 30000.
   */
  readonly maxDelayMs?: number;

  /**
   * Overall deadline in milliseconds from the first attempt.
   * The helper bounds every retry wait, reconnect, and request to
   * this deadline, even if maxRetries has not been reached.
   * Defaults to 120000.
   */
  readonly deadlineMs?: number;
}

const DEFAULT_MAX_RETRIES = 7;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_DEADLINE_MS = 120_000;

// ─────────────────────────────────────────────────────────────
// Outcome submission payload
// ─────────────────────────────────────────────────────────────

/**
 * Payload for an outcome submission request.
 */
export interface OutcomeSubmitPayload {
  readonly executionId: string;
  readonly result: WorkflowRunResult;
}

// ─────────────────────────────────────────────────────────────
// Outcome delivery error
// ─────────────────────────────────────────────────────────────

/**
 * Outcome ACK decisions that confirm durable delivery.
 *
 * Only `accepted` and `duplicate` mean the Authority has committed
 * (or already had) the canonical outcome.
 */
export const DELIVERED_DECISIONS: ReadonlySet<string> = new Set(['accepted', 'duplicate']);

/**
 * Reason an outcome could not be delivered.
 */
export type OutcomeDeliveryFailureReason = 'authority-rejected' | 'deadline-exceeded';

/**
 * Error thrown when the Authority rejects an outcome with a non-transient
 * decision (`conflict`), or when its overall delivery deadline
 * expires.
 */
export class OutcomeDeliveryError extends Error {
  /**
   * @param decision - The Authority's rejection decision or deadline marker.
   * @param result - The immutable workflow result that was rejected.
   * @param reason - Stable classification of the delivery failure.
   */
  public constructor(
    public readonly decision: OutcomeAckDecision | 'deadline-exceeded',
    public readonly result: WorkflowRunResult,
    public readonly reason: OutcomeDeliveryFailureReason = 'authority-rejected',
  ) {
    super(
      `Outcome delivery ${reason === 'deadline-exceeded' ? 'deadline exceeded' : 'rejected by Authority'} ` +
        `(decision=${decision}, ` +
        `executionId=${result.executionId}, status=${result.status})`,
    );
    this.name = 'OutcomeDeliveryError';
  }
}

/** Deadline failure for a non-terminal Authority request retried by the Runtime. */
export class AuthorityRequestDeliveryError extends Error {
  /**
   * @param reason - Stable reason the request could not complete.
   */
  public constructor(public readonly reason: 'deadline-exceeded' = 'deadline-exceeded') {
    super('Authority request delivery deadline exceeded');
    this.name = 'AuthorityRequestDeliveryError';
  }
}

// ─────────────────────────────────────────────────────────────
// Decision-aware submit helper
// ─────────────────────────────────────────────────────────────

/**
 * Optional reconnect callback invoked before each retry when the
 * previous attempt failed with a transport-level error.
 *
 * Implementations should trigger a bus reconnect (e.g. `bus.reconnect()`)
 * and return once the attempt has been initiated.
 * Failures from the reconnect attempt are non-fatal; the next retry
 * will naturally fail again if the transport is still down.
 */
export type OutcomeReconnect = () => Promise<void>;

/** Common retry options for outcome delivery. */
export interface OutcomeSubmitOptions {
  readonly retry?: OutcomeSubmitRetryConfig;
  readonly reconnect?: OutcomeReconnect;
  /**
   * Cancels a pending request, retry delay, or reconnect wait.
   * The reconnect itself remains owned by its host lifecycle.
   */
  readonly signal?: AbortSignal;
}

/**
 * Resolved retry configuration with all defaults applied.
 */
interface ResolvedRetryConfig {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly deadlineMs: number;
}

/**
 * Resolve caller-supplied retry config with defaults.
 * @param config - Optional partial config.
 * @returns Fully resolved config.
 */
function resolveRetryConfig(config: OutcomeSubmitRetryConfig | undefined): ResolvedRetryConfig {
  const resolved = {
    maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    deadlineMs: config?.deadlineMs ?? DEFAULT_DEADLINE_MS,
  };

  if (!Number.isSafeInteger(resolved.maxRetries) || resolved.maxRetries < 0) {
    throw new TypeError(
      `Outcome submission maxRetries must be a non-negative safe integer, got ${resolved.maxRetries}`,
    );
  }
  for (const [name, value] of Object.entries({
    baseDelayMs: resolved.baseDelayMs,
    maxDelayMs: resolved.maxDelayMs,
    deadlineMs: resolved.deadlineMs,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`Outcome submission ${name} must be a positive finite number, got ${value}`);
    }
  }

  return resolved;
}

/**
 * Wait for a retry delay that can be cancelled without leaving a timer behind.
 * @param delay - Retry delay in milliseconds.
 * @param signal - Optional caller-owned cancellation signal.
 */
async function waitForRetryDelay(delay: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return;
  }
  const abortSignal = signal;
  abortSignal.throwIfAborted();

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(finish, delay);
    const onAbort = (): void => finish(abortSignal.reason);

    /** @param reason - Abort reason when cancellation ends the wait. */
    function finish(reason?: unknown): void {
      clearTimeout(timeoutId);
      abortSignal.removeEventListener('abort', onAbort);
      if (reason === undefined) resolve();
      else reject(reason);
    }

    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for a reconnect without taking ownership of the reconnect operation.
 * @param reconnect - Host-owned reconnect operation.
 * @param timeout - Maximum time the delivery loop may wait.
 * @param signal - Optional caller-owned cancellation signal.
 */
async function waitForReconnect(
  reconnect: OutcomeReconnect,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const reconnecting = reconnect();

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(finish, timeout);
    const onAbort = (): void => finish(signal?.reason);

    /** @param reason - Abort reason when cancellation ends only this wait. */
    function finish(reason?: unknown): void {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      if (reason === undefined) resolve();
      else reject(reason);
    }

    // The handler consumes a late reconnect rejection after shutdown has
    // stopped waiting; connection shutdown remains the host's responsibility.
    void reconnecting.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Wait with exponential back-off and attempt reconnect before a retry.
 * @param attempt - Current retry attempt number (1-based).
 * @param config - Validated retry timing and limit configuration.
 * @param deadline - Absolute time when delivery must stop.
 * @param reconnect - Optional reconnect callback.
 * @param signal - Optional caller-owned cancellation signal.
 * @param isTerminalReconnect - Optional classification for a reconnect refusal.
 * @returns Whether time remains for the retry request.
 */
async function waitAndReconnect(
  attempt: number,
  config: ResolvedRetryConfig,
  deadline: number,
  reconnect: OutcomeReconnect | undefined,
  signal: AbortSignal | undefined,
  isTerminalReconnect?: (error: unknown) => boolean,
): Promise<boolean> {
  const rawDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
  const remainingBeforeSleep = deadline - Date.now();
  const delay = Math.min(rawDelay, config.maxDelayMs, remainingBeforeSleep);
  await waitForRetryDelay(delay, signal);

  const remainingBeforeReconnect = deadline - Date.now();
  if (remainingBeforeReconnect <= 0) {
    return false;
  }

  if (reconnect !== undefined) {
    try {
      await waitForReconnect(reconnect, remainingBeforeReconnect, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (isTerminalReconnect?.(error)) throw error;
      // Reconnect failure is non-fatal; the retry will fail again if the
      // transport is still down.
    }
  }

  return Date.now() < deadline;
}

/**
 * Run one Authority request through the common bounded retry loop.
 *
 * Both public submission functions differ only in their wire payload and
 * rejection error. Keeping this loop shared ensures a retry never gains a
 * second delivery policy merely because the outcome became generic.
 * @param request - One bounded bus request using the remaining deadline.
 * @param createDeadlineError - Builds the caller-specific deadline failure.
 * @param options - Retry, reconnect, and cancellation behavior.
 * @param isTerminalError - Identifies a received, non-retryable failure.
 * @param isTerminalReconnect - Optional classification for a reconnect refusal.
 * @returns The first response that completes before the deadline.
 */
async function retryAuthorityRequest<TResponse>(
  request: (timeout: number, signal: AbortSignal | undefined) => Promise<TResponse>,
  createDeadlineError: () => Error,
  options: OutcomeSubmitOptions | undefined,
  isTerminalError: (error: unknown) => boolean,
  isTerminalReconnect?: (error: unknown) => boolean,
): Promise<TResponse> {
  const config = resolveRetryConfig(options?.retry);
  const reconnect = options?.reconnect;
  const signal = options?.signal;
  const deadline = Date.now() + config.deadlineMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw createDeadlineError();
    if (attempt > 0) {
      const canRetry = await waitAndReconnect(attempt, config, deadline, reconnect, signal, isTerminalReconnect);
      if (!canRetry) throw createDeadlineError();
    }
    try {
      const requestTimeout = deadline - Date.now();
      if (requestTimeout <= 0) throw createDeadlineError();
      return await request(requestTimeout, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (isTerminalError(error)) throw error;
      lastError = error;
      if (Date.now() >= deadline) throw createDeadlineError();
    }
  }
  throw lastError ?? createDeadlineError();
}

/**
 * Retry a bounded Runtime-to-Authority request after transport failure.
 *
 * The request payload must be replay-safe. It does not turn an Authority
 * refusal into a retry: callers receive and interpret ordinary responses.
 * @param request - Authority request using the remaining deadline and cancellation signal.
 * @param options - Retry, reconnect, and cancellation behavior.
 * @returns The first received Authority response.
 */
export async function requestAuthorityWithRetry<TResponse>(
  request: (timeout: number, signal: AbortSignal | undefined) => Promise<TResponse>,
  options?: OutcomeSubmitOptions,
): Promise<TResponse> {
  return await retryAuthorityRequest(
    request,
    () => new AuthorityRequestDeliveryError(),
    options,
    () => false,
  );
}

/**
 * Submit an outcome through the common retry loop and reject non-ACK decisions.
 * @param request - Bounded terminal-outcome request and cancellation signal.
 * @param createError - Builds the outcome-specific terminal delivery error.
 * @param options - Retry, reconnect, and cancellation behavior.
 * @param classifyDeliveryFailure - Recognizes terminal errors in the caller's protocol.
 * @returns Durable acknowledgement decision.
 */
export async function submitWithAck<TDecision extends string>(
  request: (timeout: number, signal: AbortSignal | undefined) => Promise<TDecision>,
  createError: (decision: TDecision | 'deadline-exceeded', reason?: OutcomeDeliveryFailureReason) => Error,
  options: OutcomeSubmitOptions | undefined,
  classifyDeliveryFailure: (error: unknown) => OutcomeDeliveryFailureReason | undefined,
): Promise<TDecision> {
  return await retryAuthorityRequest(
    async (timeout, signal) => {
      const decision = await request(timeout, signal);
      if (DELIVERED_DECISIONS.has(decision)) return decision;
      throw createError(decision);
    },
    () => createError('deadline-exceeded', 'deadline-exceeded'),
    options,
    (error) => classifyDeliveryFailure(error) !== undefined,
  );
}

/**
 * Submit a workflow outcome for durable acknowledgement with
 * decision-aware, reconnect-capable retry.
 *
 * Sends the immutable outcome via `control.outcome.submit` and retries
 * with exponential back-off on transient failures. Only `accepted` and
 * `duplicate` decisions count as successful delivery. `conflict` and
 * `fenced` are non-transient infrastructure rejections that terminate
 * immediately without further retries.
 *
 * On transport-level failures the helper invokes the optional
 * reconnect callback before the next retry attempt, allowing the
 * caller to re-establish the bus connection.
 *
 * Bounded-ness: a worker cannot wait indefinitely for delivery; if
 * all retry attempts are exhausted, the helper throws the last transport
 * error. The overall deadline bounds every wait, reconnect, and in-flight
 * bus request; expiry throws a deterministic {@link OutcomeDeliveryError}.
 * @param call - Call that triggered the workflow provisioning.
 * @param bus - Worker-local bus connected to the Authority.
 * @param payload - Run identity and terminal result.
 * @param options - Optional retry configuration, reconnect callback, and cancellation signal.
 * @returns Durable ACK decision (`accepted` or `duplicate`).
 * @throws {@link OutcomeDeliveryError} On non-transient rejection or deadline expiry.
 */
export async function submitOutcomeWithAck(
  call: CallContext,
  bus: IMakaioBus,
  payload: OutcomeSubmitPayload,
  options?: OutcomeSubmitOptions,
): Promise<OutcomeAckDecision> {
  return await submitWithAck(
    async (timeout, signal) => {
      const response = await bus.request(
        call,
        WorkerSubjects.control.outcome.submit,
        {
          executionId: payload.executionId,
          result: payload.result,
        },
        signal === undefined ? { timeout } : { timeout, signal },
      );
      return response.decision;
    },
    (decision, reason) =>
      reason === undefined
        ? new OutcomeDeliveryError(decision, payload.result)
        : new OutcomeDeliveryError(decision, payload.result, reason),
    options,
    (error) => (error instanceof OutcomeDeliveryError ? error.reason : undefined),
  );
}

/** A typed refusal from the ordered job run's outcome authority. */
export class JobRunOutcomeDeliveryError extends Error {
  /** A refused proof leaves receipt delivery unconfirmed even if the run closed successfully. */
  public readonly reason: 'authority-rejected' | 'receipt-unconfirmed';

  /** @param refusal - Validated refusal received from the outcome authority. */
  public constructor(public readonly refusal: Extract<OutcomeSubmitResponse, { decision: 'refused' }>) {
    const unconfirmed = refusal.code === 'not-own-job-run';
    super(unconfirmed ? 'Job run outcome submitted, receipt unconfirmed' : `Job run outcome refused: ${refusal.code}`);
    this.reason = unconfirmed ? 'receipt-unconfirmed' : 'authority-rejected';
    this.name = 'JobRunOutcomeDeliveryError';
  }
}

/**
 * Distinguish retryable transport interruption from an explicit refusal or an unknown fault.
 * @param error - Error from sending or reconnecting.
 * @returns Whether delivery may be attempted again.
 */
function isOutcomeTransportInterruption(error: unknown): boolean {
  return (
    error instanceof ConnectionLostError ||
    error instanceof TimeoutError ||
    (error instanceof WebSocketConnectionError &&
      (error.code === 'WS_CONNECTION_UNAVAILABLE' ||
        error.code === 'WS_CONNECTION_TIMEOUT' ||
        error.code === 'WS_HANDSHAKE_TIMEOUT'))
  );
}

/**
 * Submit one ordered job run's immutable outcome over its authenticated connection.
 * @param call - Worker-local bus attribution.
 * @param bus - Worker bus connected to the outcome authority.
 * @param payload - Terminal result addressed to its booked job run.
 * @param options - Bounded delivery and reconnection policy.
 * @returns Durable acknowledgment, including the owner's first response.
 * @throws {@link JobRunOutcomeDeliveryError} On refusal. A refused run proof leaves the receipt unconfirmed.
 */
export async function submitJobRunOutcomeWithAck(
  call: CallContext,
  bus: IMakaioBus,
  payload: OutcomeSubmitRequest,
  options?: OutcomeSubmitOptions,
): Promise<Extract<OutcomeSubmitResponse, { decision: 'accepted' | 'duplicate' }>> {
  const subject = JobRunOutcomeNamespace.subjects.outcome.submit;
  const fullSubject = getFullSubjectForSubjectDefinition(subject);
  const snapshot = deepFreeze(OutcomeSubmitRequestSchema.parse(payload));
  return await retryAuthorityRequest(
    async (timeout, signal) => {
      const response = await bus.request(call, subject, snapshot, { timeout, signal });
      const decision = OutcomeSubmitResponseSchema.parse(response);
      if (decision.decision === 'refused') throw new JobRunOutcomeDeliveryError(decision);
      return decision;
    },
    () => new AuthorityRequestDeliveryError(),
    options,
    // A connected peer can still be waiting for the outcome receiver's advertisement during boot.
    (error) =>
      error instanceof JobRunOutcomeDeliveryError
        ? !error.refusal.retryable
        : !isOutcomeTransportInterruption(error) && !isNoHandlerErrorForSubject(error, fullSubject),
    (error) => !isOutcomeTransportInterruption(error),
  );
}
