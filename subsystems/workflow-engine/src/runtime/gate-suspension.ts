import type { JsonValue } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { buildDeferred, type Deferred } from './deferred.js';

// ─────────────────────────────────────────────────────────────
// Internal gate suspension helpers
// ─────────────────────────────────────────────────────────────

/**
 * Result type from {@link raceGateSuspension}.
 */
export interface GateRaceResult {
  readonly action: 'approve' | 'reject';
  readonly resumeData: JsonValue;
  readonly timedOut: boolean;
  readonly wasCancelled: boolean;
  /** Human-readable rationale supplied by the responder; absent for timeout and cancellation paths. */
  readonly reason?: string;
  /** Call context of the `gate.respond` message; absent for timeout and cancellation paths. */
  readonly call?: CallContext;
}

/** User response payload accepted by the gate suspension race. */
export interface GateUserResponse {
  readonly action: 'approve' | 'reject';
  readonly resumeData: JsonValue;
  /** Human-readable rationale supplied by the responder. */
  readonly reason?: string;
  /** Call context of the `gate.respond` message that carried this response. */
  readonly call: CallContext;
}

export interface GatePersistenceOptions {
  readonly required?: boolean;
}

/** Resume payload produced when a gate timeout auto-approves. */
export const AUTO_APPROVE_TIMEOUT_RESUME_DATA = { action: 'approve', source: 'timeout' } as const satisfies JsonValue;

/**
 * Return `{ reason }` when `reason` is defined, or an empty object otherwise.
 *
 * Used for conditional spreading so callers keep a flat object literal without
 * introducing an inline ternary that would inflate cyclomatic complexity.
 * @param reason - Optional rationale string.
 * @returns An object with a `reason` key, or an empty object.
 */
export function maybeReason(reason: string | undefined): { reason: string } | Record<never, never> {
  if (reason !== undefined) return { reason };
  return {};
}

/**
 * Race the gate resume promise against an optional timeout and abort signal.
 *
 * Sets up the abort handler and optional timeout, races the promises, and
 * returns the settled result so the caller can apply the correct gate outcome
 * without duplicating the try-catch / cleanup pattern.
 * @param deferred - The resume deferred promise to race.
 * @param pending - Mutable at-most-once flag shared with the respond handler.
 * @param signal - Cancellation signal.
 * @param timeoutMs - Optional timeout in milliseconds (`null` means no timeout).
 * @returns Settled race result indicating resume data, timeout, or cancellation.
 */
export async function raceGateSuspension(
  deferred: Deferred<GateUserResponse>,
  pending: { value: boolean },
  signal: AbortSignal,
  timeoutMs: number | null,
): Promise<GateRaceResult> {
  const abortHandler = (): void => {
    if (!pending.value) return;
    pending.value = false;
    deferred.reject('cancelled');
  };
  signal.addEventListener('abort', abortHandler, { once: true });
  if (signal.aborted) {
    abortHandler();
  }

  const racePromises: Promise<GateUserResponse>[] = [deferred.promise];
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs !== null) {
    const timeoutDeferred = buildDeferred<GateUserResponse>();
    timeoutHandle = setTimeout(() => {
      if (!pending.value) return;
      pending.value = false;
      signal.removeEventListener('abort', abortHandler);
      timeoutDeferred.reject('timed-out');
    }, timeoutMs);
    racePromises.push(timeoutDeferred.promise);
  }

  try {
    const response = await Promise.race(racePromises);
    signal.removeEventListener('abort', abortHandler);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    return {
      action: response.action,
      resumeData: response.resumeData,
      timedOut: false,
      wasCancelled: false,
      reason: response.reason,
      call: response.call,
    };
  } catch (raceError) {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', abortHandler);
    if (raceError === 'timed-out') {
      return { action: 'reject', resumeData: null, timedOut: true, wasCancelled: false };
    }
    return { action: 'reject', resumeData: null, timedOut: false, wasCancelled: true };
  }
}
