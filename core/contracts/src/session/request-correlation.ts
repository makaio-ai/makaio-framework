import { z } from 'zod';

const HEADER_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

/** Content-free identifier safe to copy into an HTTP header value. */
const HeaderSafeCorrelationIdSchema = z
  .string()
  .refine((value) => !HEADER_CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'Correlation identifiers must not contain control characters',
  })
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(512));

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
    sessionId: HeaderSafeCorrelationIdSchema.optional(),
    turnId: HeaderSafeCorrelationIdSchema.optional(),
    messageId: HeaderSafeCorrelationIdSchema.optional(),
    executionId: HeaderSafeCorrelationIdSchema.optional(),
    frameId: HeaderSafeCorrelationIdSchema.optional(),
  })
  .strict();

export type RequestCorrelationContext = z.infer<typeof RequestCorrelationContextSchema>;
