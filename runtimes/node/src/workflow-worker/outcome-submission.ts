import type { IMakaioBus } from '@makaio/bus-core';
import { WorkerSubjects, type OutcomeAckDecision, type WorkflowRunResult } from '@makaio/contracts';

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

/**
 * Build the stable error reported when the overall delivery budget expires.
 * @param result - The immutable workflow result that could not be delivered.
 * @returns Deadline-expiry delivery error.
 */
function createDeadlineExceededError(result: WorkflowRunResult): OutcomeDeliveryError {
  return new OutcomeDeliveryError('deadline-exceeded', result, 'deadline-exceeded');
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
  options?: {
    readonly retry?: OutcomeSubmitRetryConfig;
    readonly reconnect?: OutcomeReconnect;
  },
): Promise<OutcomeAckDecision> {
  const config = resolveRetryConfig(options?.retry);
  const reconnect = options?.reconnect;
  const deadline = Date.now() + config.deadlineMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw createDeadlineExceededError(payload.result);
    }

    if (attempt > 0) {
      const canRetry = await waitAndReconnect(attempt, config, deadline, reconnect);
      if (!canRetry) {
        throw createDeadlineExceededError(payload.result);
      }
    }

    try {
      const requestTimeout = deadline - Date.now();
      if (requestTimeout <= 0) {
        throw createDeadlineExceededError(payload.result);
      }
      const { decision } = await bus.request(
        WorkerSubjects.control.outcome.submit,
        {
          executionAttemptId: payload.executionAttemptId,
          executionId: payload.executionId,
          result: payload.result,
        },
        { timeout: requestTimeout },
      );
      if (DELIVERED_DECISIONS.has(decision)) {
        return decision;
      }
      // Non-transient infrastructure rejection — no retry.
      throw new OutcomeDeliveryError(decision, payload.result);
    } catch (error) {
      if (error instanceof OutcomeDeliveryError) {
        throw error;
      }
      lastError = error;
      if (Date.now() >= deadline) {
        throw createDeadlineExceededError(payload.result);
      }
    }
  }

  throw lastError ?? createDeadlineExceededError(payload.result);
}
