import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * The agent's provider-native session identity moved.
 *
 * Subject: `agent.adapterSession.moved`
 * Type: Event (fire-and-forget)
 *
 * This is the single seam every provider-session movement converges on. The
 * session row's origin `adapterSessionId` is write-once import provenance, so
 * consumers that need to know *which provider session is resumable right now*
 * must track this event rather than re-reading the origin identity.
 *
 * Producers:
 * - **Provider confirmation** — the connector confirmed a session ID that
 *   differs from the last one this agent reported (`confirmed: true`).
 * - **Connector swap** — the replacement connector confirmed its own session
 *   (`confirmed: true`).
 * - **Pre-confirmation rotation** — the caller disabled native resume before
 *   the provider confirmed anything, so the pending resume target was
 *   discarded and the identity rotated (`confirmed: false`).
 * - **Cold rehydration** — a restart-time rehydrate minted or confirmed a
 *   different provider session than the persisted one (`confirmed: true`).
 *
 * `agent.started` is deliberately *not* used as the movement signal: cold
 * rehydration moves the provider session without dispatching a turn, so a
 * turn-scoped event cannot observe it.
 */
export const AdapterSessionMovedSchema = BaseAgentEventSchema.extend({
  /** Stable machine identity of the emitting adapter runtime. */
  machineId: z.string(),
  /** Exact ownership-authority incarnation that emitted the movement. */
  ownerInstanceId: z.string(),
  /**
   * Whether `adapterSessionId` is provider-confirmed.
   *
   * `true` — `adapterSessionId` is present and is the new resume currency.
   * `false` — the identity moved but no replacement is confirmed yet;
   * `adapterSessionId` is omitted and native resume is impossible until a
   * later confirmation arrives.
   */
  confirmed: z.boolean(),
}).superRefine((value, ctx) => {
  // The flag and the ID are one value. A confirmed movement without an ID
  // advertises currency it cannot name; an unconfirmed one carrying an ID
  // advertises a successor the provider never acknowledged.
  //
  // This refinement is TypeScript-side only: the exported protocol manifest
  // (`framework/sdks/manifest/makaio-bus-protocol.json`) is generated from this
  // schema through `z.toJSONSchema`, which drops refinements because JSON Schema
  // cannot express them. The manifest therefore shows `adapterSessionId` as a
  // plain optional string. Hand-editing it to add the discriminant is not an
  // option — `yarn validate` runs the codegen in `--check` mode, so any manual
  // deviation is reported as drift and reverted on the next `yarn generate:sdk`.
  // Expressing the pairing in the manifest requires modeling it in a form the
  // exporter can emit (e.g. a discriminated union of two object variants) and
  // teaching the Python/Rust payload generators about that shape.
  if (value.confirmed === (value.adapterSessionId !== undefined)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['adapterSessionId'],
    message: 'adapterSessionId must be present exactly when confirmed is true',
  });
});

export type AdapterSessionMoved = z.infer<typeof AdapterSessionMovedSchema>;
