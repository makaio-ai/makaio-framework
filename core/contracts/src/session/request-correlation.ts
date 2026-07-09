import { z } from 'zod';

/**
 * Content-free identifiers that may accompany an outbound provider request.
 *
 * This context is deliberately separate from `turnContext`: adapters must use
 * it for transport correlation only and must never materialize it into model
 * input. Runtime-owned identifiers (for example the actual message ID) take
 * precedence over caller-supplied values before a request is sent.
 */
export const RequestCorrelationContextSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(512).optional(),
    turnId: z.string().trim().min(1).max(512).optional(),
    messageId: z.string().trim().min(1).max(512).optional(),
    executionId: z.string().trim().min(1).max(512).optional(),
    frameId: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export type RequestCorrelationContext = z.infer<typeof RequestCorrelationContextSchema>;
