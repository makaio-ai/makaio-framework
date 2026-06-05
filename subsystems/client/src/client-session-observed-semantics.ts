/**
 * Shared helpers for the client-native hook ingress layer.
 *
 * This module provides the canonical schema for raw catch-all hook events
 * emitted by client ingress bridges (`client:<id>.hook.received`), re-exports
 * the global `ClientSubjects`, and exposes shared adapter utilities for
 * constructing and emitting `client.session.*` observed-semantics payloads.
 *
 * **Domain invariant:** raw client-native payloads live only inside per-client
 * namespaces (`client:<id>.*`).  The global `client.*` namespace carries only
 * normalized, framework-level observations.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { EventMessagePayload, RequestMessagePayload, SubjectDefinition, SubjectRecord } from '@makaio/core';
export { ClientSubjects } from '@makaio/contracts/client';
import type { ClientSessionObservedBase } from '@makaio/contracts/client';

/**
 * Canonical schema for the raw catch-all hook payload delivered on
 * `client:<id>.hook.received`.
 *
 * Client ingress CLIs are dumb bridges: they accept any native hook event and
 * publish it verbatim on this subject.  Downstream normalizers are responsible
 * for interpreting `eventName` and mapping the `payload` to structured
 * `client.session.*` observations.
 *
 * Fields:
 * - `eventName`   — the hook event name as reported by the client CLI
 *   (e.g. `'PreToolUse'`, `'Stop'`).
 * - `receivedAt`  — Unix epoch timestamp in milliseconds when the bridge
 *   received the hook call.
 * - `payload`     — raw JSON object forwarded verbatim from the client CLI.
 * - `metadata`    — optional pass-through metadata added by the bridge (e.g.
 *   process PID, invocation arguments).
 */
export const RawClientHookPayloadSchema = z.object({
  /** Hook event name as reported by the client CLI (e.g. `'PreToolUse'`). */
  eventName: z.string(),
  /** Unix epoch timestamp in milliseconds when the bridge received the hook. */
  receivedAt: z.number().int().finite().nonnegative().describe('Unix epoch timestamp in milliseconds'),
  /** Raw JSON object forwarded verbatim from the client CLI. */
  payload: z.record(z.string(), z.unknown()),
  /** Optional pass-through metadata added by the ingress bridge. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RawClientHookPayload = z.infer<typeof RawClientHookPayloadSchema>;

const CLIENT_NAMESPACE_PREFIX = 'client:';
const CANONICAL_CLIENT_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Normalize user-provided client identifiers to the stable suffix used in
 * `client:<id>` namespaces.
 * @param clientId - Raw client identifier, optionally prefixed with `client:`
 * @param caller - Optional function name used in thrown error messages
 * @returns Canonical lowercase client identifier without the `client:` prefix
 */
export function canonicalizeClientId(clientId: string, caller = 'canonicalizeClientId'): string {
  const trimmedClientId = clientId.trim();
  const lowerClientId = trimmedClientId.toLowerCase();
  const canonicalClientId = lowerClientId.startsWith(CLIENT_NAMESPACE_PREFIX)
    ? lowerClientId.slice(CLIENT_NAMESPACE_PREFIX.length)
    : lowerClientId;

  if (canonicalClientId.length === 0) {
    throw new Error(`[${caller}] clientId must be a non-empty string`);
  }
  if (!CANONICAL_CLIENT_ID_PATTERN.test(canonicalClientId)) {
    throw new Error(
      `[${caller}] clientId must contain only lowercase letters, numbers, and hyphens after an optional client: prefix`,
    );
  }

  return canonicalClientId;
}

type RawClientHookSubjectRecord = SubjectRecord<'hook.received', EventMessagePayload<RawClientHookPayload>>;

/**
 * Subject definition for the raw catch-all hook event in a concrete
 * `client:<id>` namespace.
 */
export type RawClientHookReceivedSubject = SubjectDefinition<
  RawClientHookSubjectRecord,
  'hook.received',
  `client:${string}`
>;

/**
 * Build a non-owning subject definition for `client:<id>.hook.received`.
 *
 * This is intentionally not a namespace registration. Concrete client packages
 * own their full `client:<id>` namespace via {@link createClientNamespace}; the
 * generic CLI bridge only needs to emit the shared hook subject and must not
 * accidentally register a narrower namespace before the concrete owner loads.
 * When the concrete owner is loaded, normal bus schema validation applies. When
 * it is not loaded, the ad-hoc subject still allows the raw event to traverse
 * transports to a process that owns the namespace.
 * @param clientId - Stable client identifier, optionally prefixed with `client:`
 * @returns Non-owning subject definition for the client's raw hook ingress
 */
export function createRawClientHookReceivedSubject(clientId: string): RawClientHookReceivedSubject {
  const normalizedClientId = canonicalizeClientId(clientId, 'createRawClientHookReceivedSubject');

  // `payload` is a type-level phantom used only for inference — it is never
  // accessed at runtime. Cast the whole object rather than fabricating a
  // phantom value on the field itself (mirrors nestSubjectDefinitions).
  return {
    subject: 'hook.received',
    $meta: {
      namespace: `client:${normalizedClientId}`,
      isRequest: false,
      local: false,
      channel: false,
    },
  } as RawClientHookReceivedSubject;
}

// ---------------------------------------------------------------------------
// Hook handle (request/response) subject
// ---------------------------------------------------------------------------

/**
 * Default timeout in milliseconds for hook handle requests.
 *
 * Shared between the CLI schema default (client-hooks extension) and the
 * wiring descriptor trailing flags (claude-code client) so both always agree
 * on the configured wait budget without independent magic numbers.
 */
export const DEFAULT_HOOK_HANDLE_TIMEOUT_MS = 5000;

/**
 * Schema for the response payload returned by a `makaio hook handle` command.
 *
 * The client binary reads this from the command's stdout after the process
 * exits.  All fields default to safe zero-values so partial responses are
 * still valid.
 *
 * Fields:
 * - `exitCode` — process exit code the binary should use (0–255). Defaults to `0`.
 * - `stdout`   — text written to stdout, forwarded verbatim to the client.
 *   Defaults to `''`.
 * - `stderr`   — text written to stderr, forwarded verbatim to the client.
 *   Defaults to `''`.
 */
export const ClientHookHandleResponseSchema = z.object({
  /** Process exit code the binary should use (0–255). Defaults to `0`. */
  exitCode: z.number().int().min(0).max(255).default(0),
  /** Text to forward verbatim to the client's stdout. Defaults to `''`. */
  stdout: z.string().default(''),
  /** Text to forward verbatim to the client's stderr. Defaults to `''`. */
  stderr: z.string().default(''),
});

export type ClientHookHandleResponse = z.infer<typeof ClientHookHandleResponseSchema>;

type RawClientHookHandleSubjectRecord = SubjectRecord<
  'hook.handle',
  RequestMessagePayload<RawClientHookPayload, ClientHookHandleResponse>
>;

/**
 * Subject definition for the raw hook handle request/response subject in a
 * concrete `client:<id>` namespace.
 *
 * Carries `RequestMessagePayload<RawClientHookPayload, ClientHookHandleResponse>`
 * as a phantom type so `bus.requestOptional` infers the correct generics without
 * additional type annotations at the call site.
 */
export type RawClientHookHandleSubject = SubjectDefinition<
  RawClientHookHandleSubjectRecord,
  'hook.handle',
  `client:${string}`
>;

/**
 * Build a non-owning subject definition for `client:<id>.hook.handle`.
 *
 * The returned definition uses `isRequest: true` so the bus dispatches it
 * through the request/response pipeline.  Concrete client packages own their
 * full `client:<id>` namespace via {@link createClientNamespace}; this helper
 * is intentionally non-owning for the same reasons as
 * {@link createRawClientHookReceivedSubject} — see that function's doc for
 * the full rationale.
 * @param rawClientId - Stable client identifier, optionally prefixed with `client:`
 * @returns Non-owning subject definition for the client's raw hook handle ingress
 */
export function createRawClientHookHandleSubject(rawClientId: string): RawClientHookHandleSubject {
  const clientId = canonicalizeClientId(rawClientId, 'createRawClientHookHandleSubject');

  // `payload` is a type-level phantom used only for inference — it is never
  // accessed at runtime. Cast the whole object rather than fabricating a
  // phantom value on the field itself (mirrors nestSubjectDefinitions).
  return {
    subject: 'hook.handle',
    $meta: {
      namespace: `client:${clientId}`,
      isRequest: true,
      local: false,
      channel: false,
    },
  } as RawClientHookHandleSubject;
}

// ---------------------------------------------------------------------------
// Shared adapter helpers for client.session.* observed-semantics
// ---------------------------------------------------------------------------

/**
 * Trim and return a string value when non-empty, otherwise `undefined`.
 *
 * Primitive building block for normalizers that accept `unknown` values from
 * raw JSON payloads.  Returns `undefined` when the input is not a string, or
 * is a string that is empty or whitespace-only after trimming.
 * @param value - Unknown value to inspect.
 * @returns Trimmed non-empty string, or `undefined`.
 */
export function pickNonEmptyStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

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
