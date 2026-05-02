import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * External provider session established.
 *
 * Subject: `adapter.session.created`
 * Type: Event (fire-and-forget)
 * Emitted when: SDK session is created (Anthropic, OpenAI, etc.)
 */
export const SessionCreatedSchema = BaseAdapterEventSchema.extend({
  adapterSessionId: z.string(),
  sessionId: z.string(),
  model: z.string(),
});

export type SessionCreated = z.infer<typeof SessionCreatedSchema>;
