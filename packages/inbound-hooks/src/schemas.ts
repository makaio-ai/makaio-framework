import { z } from 'zod';

/**
 * Validates a hook source identifier.
 *
 * Source identifiers must be lowercase alphanumeric with hyphens only
 * (e.g., `'git'`, `'claude-code'`).
 */
export const InboundHookSourceSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'source must contain only lowercase letters, numbers, and hyphens');

/**
 * Canonical schema for the raw inbound hook payload delivered on
 * `hook:<source>.received`.
 *
 * Ingress bridges are intentionally dumb: they accept any native hook event
 * and publish it verbatim on this subject. Downstream translators are
 * responsible for interpreting `eventName` and mapping the `payload` to
 * structured observations.
 */
export const RawInboundHookPayloadSchema = z.object({
  /** Hook event name as reported by the native source. */
  eventName: z.string().min(1),
  /** Unix epoch milliseconds when the receiver accepted the event. */
  receivedAt: z.number().int().finite().nonnegative(),
  /** Hook argv after the event name. */
  argv: z.array(z.string()),
  /** Raw stdin text captured from the hook invocation. */
  stdinText: z.string(),
  /** Parsed source payload, or an empty object when there is no JSON payload. */
  payload: z.record(z.string(), z.unknown()),
  /** Optional pass-through metadata added by the receiver. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RawInboundHookPayload = z.infer<typeof RawInboundHookPayloadSchema>;
export type InboundHookSource = z.infer<typeof InboundHookSourceSchema>;
