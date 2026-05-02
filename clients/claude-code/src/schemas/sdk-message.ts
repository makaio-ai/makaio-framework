import { z } from 'zod';
import { SDKUserMessageSchema } from './user-message.js';
import { SDKAssistantMessageSchema } from './assistant-message.js';
import { SDKResultMessageSchema } from './result-message.js';
import { SDKSystemMessageSchema } from './system-message.js';
import { SDKStreamEventMessageSchema } from './stream-event.js';

/**
 * Union of all SDK message types.
 * Used for the catch-all sdk.event subject.
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

/**
 * Known SDK message type discriminators for pre-filtering.
 * Messages with types not in this set are silently dropped before bus emission
 * to avoid validation errors from newer CLI versions (e.g., `rate_limit_event`).
 */
export const KNOWN_SDK_MESSAGE_TYPES = new Set(['system', 'assistant', 'user', 'result', 'stream_event']);

/**
 * Known `system` message subtypes that match the {@link SDKSystemMessageSchema}
 * discriminated union. System messages with subtypes not in this set are
 * silently dropped before bus emission — same pattern as {@link KNOWN_SDK_MESSAGE_TYPES}
 * for top-level types. This keeps the schema's discriminated union precise
 * (full TypeScript narrowing) while staying resilient to new subtypes the SDK
 * adds frequently (e.g., `hook_started`, `status`, `session_state_changed`).
 */
export const KNOWN_SYSTEM_SUBTYPES = new Set(['init', 'compact_boundary']);

/** Inferred type for any SDK message. */
export type SDKMessage = z.infer<typeof SDKMessageSchema>;
