import type { IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptSubjects,
  WorkerSubjects,
  type ExecutionAttemptOutcome,
  type OutcomeAckDecision,
  type WorkflowRunResult,
} from '@makaio/contracts';

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
  readonly executionAttemptId: string;
  readonly executionId: string;
  readonly result: WorkflowRunResult;
}

/** Payload for the generic terminal Attempt outcome ingress. */
export interface AttemptOutcomeSubmitPayload {
  /** Authority-created Attempt identity. */
  readonly executionAttemptId: string;
  /** Runtime generation accepted during registration. */
  readonly runtimeGeneration: number;
  /** Admitted operation for non-startup outcomes. */
  readonly operationId?: string;
  /** Technical failure or opaque workload result. */
  readonly outcome: ExecutionAttemptOutcome;
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
export const DELIVERED_DECISIONS = new Set<OutcomeAckDecision>(['accepted', 'duplicate']);

/**
 * Reason an outcome could not be delivered.
 */
export type OutcomeDeliveryFailureReason = 'authority-rejected' | 'deadline-exceeded';

/**
 * Error thrown when the Authority rejects an outcome with a non-transient
 * decision (`conflict` or `fenced`), or when its overall delivery deadline
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

/** Error from delivery through the generic Attempt outcome ingress. */
export class AttemptOutcomeDeliveryError extends Error {
  /**
   * @param decision - Authority rejection decision or deadline marker.
   * @param payload - Immutable Attempt outcome that could not be acknowledged.
   * @param reason - Stable delivery failure classification.
   */
  public constructor(
    public readonly decision: OutcomeAckDecision | 'deadline-exceeded',
    public readonly payload: AttemptOutcomeSubmitPayload,
    public readonly reason: OutcomeDeliveryFailureReason = 'authority-rejected',
  ) {
    super(
      `Attempt outcome delivery ${reason === 'deadline-exceeded' ? 'deadline exceeded' : 'rejected by Authority'} ` +
        `(decision=${decision}, executionAttemptId=${payload.executionAttemptId}, outcome=${payload.outcome.kind})`,
    );
    this.name = 'AttemptOutcomeDeliveryError';
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
 * Implementations should trigger a bus reconnect (e.g.
 * `bus.reconnect()`) and return once the attempt has been initiated.
 * Failures from the reconnect attempt are non-fatal; the next retry
 * will naturally fail again if the transport is still down.
 */
export type OutcomeReconnect = () => Promise<void>;

/** Common retry options for either legacy workflow or generic Attempt outcome delivery. */
export interface OutcomeSubmitOptions {
  readonly retry?: OutcomeSubmitRetryConfig;
  readonly reconnect?: OutcomeReconnect;
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
 * Wait with exponential back-off and attempt reconnect before a retry.
 * @param attempt - Current retry attempt number (1-based).
 * @param config - Validated retry timing and limit configuration.
 * @param deadline - Absolute time when delivery must stop.
 * @param reconnect - Optional reconnect callback.
 * @returns Whether time remains for the retry request.
 */
async function waitAndReconnect(
  attempt: number,
  config: ResolvedRetryConfig,
  deadline: number,
  reconnect: OutcomeReconnect | undefined,
): Promise<boolean> {
  const rawDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
  const remainingBeforeSleep = deadline - Date.now();
  const delay = Math.min(rawDelay, config.maxDelayMs, remainingBeforeSleep);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));

  const remainingBeforeReconnect = deadline - Date.now();
  if (remainingBeforeReconnect <= 0) {
    return false;
  }

  if (reconnect !== undefined) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reconnect(),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, remainingBeforeReconnect);
        }),
      ]);
    } catch {
      // Reconnect failure is non-fatal; the retry will fail
      // again if the transport is still down.
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
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
 * @param options - Retry and reconnect behavior.
 * @param isTerminalError - Identifies a received, non-retryable failure.
 * @returns The first response that completes before the deadline.
 */
async function retryAuthorityRequest<TResponse>(
  request: (timeout: number) => Promise<TResponse>,
  createDeadlineError: () => Error,
  options: OutcomeSubmitOptions | undefined,
  isTerminalError: (error: unknown) => boolean,
): Promise<TResponse> {
  const config = resolveRetryConfig(options?.retry);
  const reconnect = options?.reconnect;
  const deadline = Date.now() + config.deadlineMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw createDeadlineError();
    if (attempt > 0) {
      const canRetry = await waitAndReconnect(attempt, config, deadline, reconnect);
      if (!canRetry) throw createDeadlineError();
    }
    try {
      const requestTimeout = deadline - Date.now();
      if (requestTimeout <= 0) throw createDeadlineError();
      return await request(requestTimeout);
    } catch (error) {
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
 * @param request - Authority request using the remaining deadline.
 * @param options - Retry and reconnect behavior.
 * @returns The first received Authority response.
 */
export async function requestAuthorityWithRetry<TResponse>(
  request: (timeout: number) => Promise<TResponse>,
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
 * @param request - Bounded terminal-outcome request.
 * @param createError - Builds the outcome-specific terminal delivery error.
 * @param options - Retry and reconnect behavior.
 * @returns Durable acknowledgement decision.
 */
async function submitWithAck(
  request: (timeout: number) => Promise<OutcomeAckDecision>,
  createError: (decision: OutcomeAckDecision | 'deadline-exceeded', reason?: OutcomeDeliveryFailureReason) => Error,
  options: OutcomeSubmitOptions | undefined,
): Promise<OutcomeAckDecision> {
  return await retryAuthorityRequest(
    async (timeout) => {
      const decision = await request(timeout);
      if (DELIVERED_DECISIONS.has(decision)) return decision;
      throw createError(decision);
    },
    () => createError('deadline-exceeded', 'deadline-exceeded'),
    options,
    (error) => error instanceof OutcomeDeliveryError || error instanceof AttemptOutcomeDeliveryError,
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
 * @param bus - Worker-local bus connected to the Authority.
 * @param payload - Attempt identity and terminal result.
 * @param options - Optional retry configuration and reconnect callback.
 * @returns Durable ACK decision (`accepted` or `duplicate`).
 * @throws {@link OutcomeDeliveryError} On non-transient rejection or deadline expiry.
 */
export async function submitOutcomeWithAck(
  bus: IMakaioBus,
  payload: OutcomeSubmitPayload,
  options?: OutcomeSubmitOptions,
): Promise<OutcomeAckDecision> {
  return await submitWithAck(
    async (timeout) => {
      const response = await bus.request(
        WorkerSubjects.control.outcome.submit,
        {
          executionAttemptId: payload.executionAttemptId,
          executionId: payload.executionId,
          result: payload.result,
        },
        { timeout },
      );
      return response.decision;
    },
    (decision, reason) =>
      reason === undefined
        ? new OutcomeDeliveryError(decision, payload.result)
        : new OutcomeDeliveryError(decision, payload.result, reason),
    options,
  );
}

/**
 * Submit a generic Attempt terminal outcome with the same bounded retry policy
 * as legacy workflow results.
 * @param bus - Runtime bus authenticated as the Attempt peer.
 * @param payload - Fenced Attempt result and optional admitted operation.
 * @param options - Retry and reconnect behavior.
 * @returns Durable Authority acknowledgement.
 */
export async function submitAttemptOutcomeWithAck(
  bus: IMakaioBus,
  payload: AttemptOutcomeSubmitPayload,
  options?: OutcomeSubmitOptions,
): Promise<OutcomeAckDecision> {
  return await submitWithAck(
    async (timeout) => {
      const response = await bus.request(ExecutionAttemptSubjects.outcome.submit, payload, { timeout });
      return response.decision;
    },
    (decision, reason) =>
      reason === undefined
        ? new AttemptOutcomeDeliveryError(decision, payload)
        : new AttemptOutcomeDeliveryError(decision, payload, reason),
    options,
  );
}
