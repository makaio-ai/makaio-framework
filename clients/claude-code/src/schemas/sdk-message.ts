import { z } from 'zod';
import { SDKUserMessageSchema } from './user-message.js';
import { SDKAssistantMessageSchema } from './assistant-message.js';
import { SDKResultMessageSchema } from './result-message.js';
import { SDKSystemMessageSchema } from './system-message.js';
import { SDKStreamEventMessageSchema } from './stream-event.js';

/**
 * Union of all SDK message types (raw shape — `agentId` optional).
 * Used for the catch-all `sdk.event` subject on the bus.
 *
 * Note: Uses z.union() instead of z.discriminatedUnion() because
 * SDKSystemMessageSchema and SDKResultMessageSchema are already
 * discriminated unions on 'subtype'.
 */
export const SDKMessageSchema = z.union([
  SDKSystemMessageSchema,
  SDKAssistantMessageSchema,
  SDKUserMessageSchema,
  SDKResultMessageSchema,
  SDKStreamEventMessageSchema,
]);

/** Raw SDK message type — `agentId` may be absent. */
export type SDKMessage = z.infer<typeof SDKMessageSchema>;

/**
 * Enriched SDK message union — guarantees `agentId` is present.
 *
 * Use this schema/type when consuming bus events that have already passed
 * through the connector `emit()` layer which injects identity metadata.
 */
export const EnrichedSDKMessageSchema = z.intersection(SDKMessageSchema, z.object({ agentId: z.string() }));

/** Enriched SDK message type — `agentId` guaranteed present. */
export type EnrichedSDKMessage = z.infer<typeof EnrichedSDKMessageSchema>;

/**
 * Known SDK message type discriminators for pre-filtering.
 *
 * Adapters should still emit unknown SDK payloads to their raw `sdk.event`
 * subject in lenient validation mode so protocol drift is reported.
 */
export const KNOWN_SDK_MESSAGE_TYPES = new Set(['system', 'assistant', 'user', 'result', 'stream_event']);

/**
 * Known `system` message subtypes that match the {@link SDKSystemMessageSchema}
 * discriminated union. System messages with subtypes not in this set are
 * classified as unsupported by schema-aware consumers. Adapters should still
 * emit unknown SDK payloads to their raw `sdk.event` subject in lenient
 * validation mode so protocol drift is reported.
 */
export const KNOWN_SYSTEM_SUBTYPES = new Set(['init', 'compact_boundary']);

/**
 * Check whether an SDK payload is safe for typed session-state routing.
 *
 * This is intentionally a lightweight discriminator guard, not a full schema
 * parse. Adapters emit every raw SDK payload to `sdk.event` first; this guard
 * only decides whether the internal turn-state machine should consume it.
 * Schema validation happens on the bus layer (lenient mode reports violations
 * without blocking routing).
 * @param message - Raw SDK payload
 * @returns True when the payload has a known top-level type and system subtype
 */
export function isKnownSdkMessageForRouting(message: unknown): message is SDKMessage {
  if (!message || typeof message !== 'object') return false;
  const discriminator = message as { type?: unknown; subtype?: unknown };
  if (typeof discriminator.type !== 'string' || !KNOWN_SDK_MESSAGE_TYPES.has(discriminator.type)) return false;
  // No safeParse here: routing must work on raw SDK payloads before connector
  // enrichment. Schema validation is the bus layer's job (lenient mode).
  return (
    discriminator.type !== 'system' ||
    (typeof discriminator.subtype === 'string' && KNOWN_SYSTEM_SUBTYPES.has(discriminator.subtype))
  );
}
