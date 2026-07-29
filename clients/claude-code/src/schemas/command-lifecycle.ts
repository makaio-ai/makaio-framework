import { z } from 'zod';
import { BaseSdkMessageSchema } from './base.js';

/**
 * Command lifecycle event emitted when a CLI command transitions between
 * lifecycle phases (started, completed, cancelled, and other subtypes).
 *
 * Diagnostic-only: the turn-state machine never consumes this message, so it
 * is deliberately absent from `KNOWN_SDK_MESSAGE_TYPES`. It participates in
 * the SDK message union solely so `sdk.event` observers see a valid payload
 * instead of a schema violation for traffic the client knowingly emits.
 * @remarks
 * The discriminator (`command_lifecycle`) and field names (`command_uuid`,
 * plus observed subtype values `started`, `completed`, `cancelled`) were
 * recovered from the Claude Code 2.1.219 CLI binary's string table. This type
 * is absent from the `@anthropic-ai/claude-agent-sdk` 0.2.131 typings, so the
 * payload is modeled permissively with `.passthrough()` rather than pinned to
 * a guessed closed shape. `subtype` is kept as an open `z.string()` because
 * the full closed set of lifecycle subtypes is unverified.
 */
export const SDKCommandLifecycleMessageSchema = BaseSdkMessageSchema.extend({
  type: z.literal('command_lifecycle'),

  /**
   * Lifecycle phase of the command.
   *
   * Observed values include `'started'`, `'completed'`, and `'cancelled'`,
   * but the full set is unverified — kept as open string on purpose.
   */
  subtype: z.string(),

  /** UUID of the command associated with this lifecycle event, if available. */
  command_uuid: z.string().optional(),
}).passthrough();

/** Command lifecycle event message type. */
export type SDKCommandLifecycleMessage = z.infer<typeof SDKCommandLifecycleMessageSchema>;
