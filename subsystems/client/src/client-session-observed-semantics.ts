/**
 * Shared helpers for the client-native hook ingress layer.
 *
 * This module re-exports the global `ClientSubjects` and exposes shared
 * adapter utilities for constructing and emitting `client.session.*`
 * observed-semantics payloads.  The raw per-client hook subjects and schemas
 * live in `./hook-subjects.ts`, which also states the domain invariant that
 * separates raw per-client payloads from the normalized global namespace.
 * @packageDocumentation
 */

export { ClientSubjects } from '@makaio/contracts/client';
import type { ClientSessionObservedBase } from '@makaio/contracts/client';
import { pickNonEmptyStringValue } from './hook-subjects.js';

// ---------------------------------------------------------------------------
// Shared adapter helpers for client.session.* observed-semantics
// ---------------------------------------------------------------------------

// Maintainer exception to the "no compatibility re-exports" rule (FACT-391): the
// helper now lives in the light `hook-subjects` subpath so the CLI hook path can
// use it without loading this module; existing importers keep working.
export { pickNonEmptyStringValue } from './hook-subjects.js';

/**
 * Extract a non-empty string value from an unknown-typed hook payload object.
 *
 * Convenience helper used by client hook normalizers to pick a single key from
 * a raw JSON payload.  Returns `undefined` when the key is absent, not a
 * string, or an empty string — so callers can use the `?? undefined` pattern
 * or spread conditionally without additional checks.
 * @param payload - Raw hook payload object forwarded by the ingress bridge.
 * @param key - Property key to read.
 * @returns Non-empty string value, or `undefined` when absent or empty.
 */
export function pickNonEmptyString(payload: Record<string, unknown>, key: string): string | undefined {
  return pickNonEmptyStringValue(payload[key]);
}

/**
 * Options for constructing a {@link ClientSessionObservedBase} payload.
 */
export interface BuildClientSessionBaseOpts {
  /** Stable client identifier (e.g. `'codex'`, `'claude-code'`). */
  clientId: string;
  /** Framework session ID, if already resolved at emission time. */
  sessionId?: string;
  /** Raw session identifier from the client runtime, if available. */
  adapterSessionId?: string;
}

/**
 * Build a {@link ClientSessionObservedBase} payload for a `client.session.*`
 * observed-semantics event.
 *
 * Always stamps `source: 'adapter-derived'` and `observedAt: Date.now()`.
 * The optional `sessionId` and `adapterSessionId` fields are omitted when
 * undefined so Zod validation does not receive explicit `undefined` values.
 * @param opts - Client and session identifiers for the observation
 * @returns Base payload ready for emission or spread-extension
 */
export function buildClientSessionBase(opts: BuildClientSessionBaseOpts): ClientSessionObservedBase {
  return {
    clientId: opts.clientId,
    source: 'adapter-derived',
    observedAt: Date.now(),
    ...(opts.sessionId !== undefined && { sessionId: opts.sessionId }),
    ...(opts.adapterSessionId !== undefined && { adapterSessionId: opts.adapterSessionId }),
  };
}

/**
 * Execute an async emission thunk best-effort, swallowing any rejection.
 *
 * Adapters use this to emit `client.session.*` observed-semantics events
 * without risking disruption of the core adapter operation when no handler
 * is registered for the observed-semantics surface.
 * @param fn - Async emission thunk to execute fire-and-forget
 */
export function emitBestEffort(fn: () => Promise<void>): void {
  try {
    void fn().catch(logBestEffortEmissionFailure);
  } catch (error) {
    logBestEffortEmissionFailure(error);
  }
}

/**
 * Log a swallowed best-effort emission failure when debug output is enabled.
 * @param error - Error thrown or rejected by the best-effort emission thunk
 */
function logBestEffortEmissionFailure(error: unknown): void {
  // Best-effort observations are intentionally silent: adapters call this on
  // streaming/lifecycle paths where optional telemetry failures must not
  // surface as user-visible noise or alter adapter control flow. Debug envs
  // opt into visibility for diagnosing missing observed-semantics events.
  if (process.env.DEBUG || process.env.MAKAIO_DEBUG) {
    console.debug('[emitBestEffort] observed-semantics emission failed', error);
  }
}
