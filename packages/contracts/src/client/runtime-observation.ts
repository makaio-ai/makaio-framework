/**
 * Runtime observation schemas for the client domain.
 *
 * Covers source-layer classification, source descriptors, shared evidence
 * fields, the `client.runtime.observe` request–response pair, and the
 * `client.runtime.started` event payload.
 * @packageDocumentation
 */

import { z } from 'zod';
import { EpochMillisecondsSchema, NonEmptyStringSchema } from './primitives.js';

/**
 * Source layer classification for a runtime observation.
 *
 * Identifies the component that produced the observation signal:
 * - `'supervisor'` — the Makaio supervisor process directly detected the runtime
 * - `'adapter'` — a client adapter emitted the signal from the adapter layer
 * - `'client-hook'` — a native client hook (e.g. PostToolUse) produced the signal
 * - `'statusline'` — a statusline / process-watcher scraper detected the runtime
 * - `'cli-wrapper'` — a thin CLI shim wrapping the client binary reported the signal
 */
export const ClientRuntimeSourceLayerSchema = z.enum([
  'supervisor',
  'adapter',
  'client-hook',
  'statusline',
  'cli-wrapper',
]);

export type ClientRuntimeSourceLayer = z.infer<typeof ClientRuntimeSourceLayerSchema>;

/**
 * Source descriptor identifying what produced a runtime observation.
 *
 * - `layer` — high-level component classification (see {@link ClientRuntimeSourceLayerSchema}).
 * - `producer` — stable producer identifier within that layer (e.g. `'claude-code-adapter'`).
 */
export const ClientRuntimeSourceSchema = z.object({
  /** High-level component classification. */
  layer: ClientRuntimeSourceLayerSchema,
  /** Stable producer identifier within the layer (e.g. `'claude-code-adapter'`). */
  producer: NonEmptyStringSchema,
});

export type ClientRuntimeSource = z.infer<typeof ClientRuntimeSourceSchema>;

/**
 * Shared runtime evidence fields that appear in both the `client.runtime.observe`
 * request and the `client.runtime.started` event.
 *
 * At least one of `supervisorSessionId`, `pid`, or `adapterSessionId` must be
 * present ("hard evidence" invariant). This constraint is enforced via `.refine()`
 * on the terminal request schema, not on this base, so the base stays composable.
 *
 * Fields:
 * - `supervisorSessionId` — supervisor-assigned session ID, when available.
 * - `pid` — OS process ID of the client binary.
 * - `parentPid` — OS process ID of the parent process.
 * - `adapterSessionId` — raw session ID from the client runtime.
 * - `sessionId` — framework session ID, if already resolved.
 * - `cwd` — working directory of the client process.
 * - `argv` — argv of the client process.
 * - `metadata` — arbitrary pass-through data from the producer.
 */
export const ClientRuntimeEvidenceBaseSchema = z.object({
  /** Supervisor-assigned session ID, when the supervisor detected the runtime. */
  supervisorSessionId: NonEmptyStringSchema.optional(),
  /** OS process ID of the client binary. */
  pid: z.number().int().positive().optional(),
  /** OS process ID of the parent process. */
  parentPid: z.number().int().positive().optional(),
  /** Raw session identifier from the client runtime. */
  adapterSessionId: NonEmptyStringSchema.optional(),
  /** Framework session ID, if already resolved at observation time. */
  sessionId: NonEmptyStringSchema.optional(),
  /** Working directory of the client process. */
  cwd: z.string().optional(),
  /** Full argv of the client process. */
  argv: z.array(z.string()).optional(),
  /** Arbitrary pass-through data from the producer. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ClientRuntimeEvidenceBase = z.infer<typeof ClientRuntimeEvidenceBaseSchema>;

/**
 * Request and response schemas for `client.runtime.observe`.
 *
 * Callers send this request when they detect that a client runtime has started.
 * The handler upserts a `ClientRuntime` record and returns a stable
 * `clientRuntimeId` together with flags indicating whether the record was
 * created or promoted to a richer state.
 *
 * Hard-evidence invariant: at least one of `supervisorSessionId`, `pid`, or
 * `adapterSessionId` must be present. Enforced via `.refine()` on the request
 * schema (not on the shared evidence base, which stays composable).
 */
export const ClientRuntimeObserveSchema = {
  request: z
    .object({
      /** Stable client ID (e.g. `'claude-code'`). */
      clientId: NonEmptyStringSchema,
      /** Source descriptor identifying what produced this observation. */
      source: ClientRuntimeSourceSchema,
      /** Unix epoch timestamp in milliseconds when the signal was captured. */
      observedAt: EpochMillisecondsSchema,
    })
    .merge(ClientRuntimeEvidenceBaseSchema)
    .refine((v) => v.supervisorSessionId !== undefined || v.pid !== undefined || v.adapterSessionId !== undefined, {
      message: 'At least one hard-evidence field is required (supervisorSessionId, pid, or adapterSessionId)',
    }),
  response: z.object({
    /** Stable runtime record ID assigned by the registry. */
    clientRuntimeId: NonEmptyStringSchema,
    /** `true` when this observation created a new runtime record. */
    created: z.boolean(),
    /** `true` when this observation promoted an existing record to a richer state. */
    promoted: z.boolean(),
  }),
};

export type ClientRuntimeObserveRequest = z.infer<typeof ClientRuntimeObserveSchema.request>;
export type ClientRuntimeObserveResponse = z.infer<typeof ClientRuntimeObserveSchema.response>;

/**
 * Payload for `client.runtime.started`.
 *
 * Emitted by the runtime-observe service after a `client.runtime.observe` request
 * has been handled and a runtime record has been created or confirmed. Listeners
 * can react to this event without coupling to the observe handler.
 *
 * Hard-evidence invariant: at least one of `supervisorSessionId`, `pid`, or
 * `adapterSessionId` is present (guaranteed by the observe handler before emit).
 */
export const ClientRuntimeStartedSchema = ClientRuntimeEvidenceBaseSchema.extend({
  /** Stable runtime record ID assigned by the registry. */
  clientRuntimeId: NonEmptyStringSchema,
  /** Stable client ID (e.g. `'claude-code'`). */
  clientId: NonEmptyStringSchema,
  /**
   * Lifecycle status of the runtime record at the time of emission.
   * - `'observed'` — the runtime was first seen; evidence is being collected.
   * - `'started'` — the runtime is confirmed started with sufficient evidence.
   */
  status: z.enum(['observed', 'started']),
  /** Source descriptor identifying what produced the originating observation. */
  source: ClientRuntimeSourceSchema,
  /** Unix epoch timestamp in milliseconds when the signal was captured. */
  observedAt: EpochMillisecondsSchema,
});

export type ClientRuntimeStarted = z.infer<typeof ClientRuntimeStartedSchema>;
