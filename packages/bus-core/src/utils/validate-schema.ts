import type { z } from 'zod';
import { ValidationError } from '../errors/index.js';

/**
 * Validates a payload against a Zod schema in development mode.
 * @param subject - Subject identifier for error messages
 * @param payload - Payload to validate
 * @param schema - Zod schema to validate against
 * @throws ValidationError If validation fails
 */
export function validateSchema(subject: string, payload: unknown, schema: z.ZodType): void {
  if (process.env.NODE_ENV !== 'production') {
    const result = schema.safeParse(payload);
    if (!result.success) {
      console.error(`Payload validation failed for subject "${subject}":`, JSON.stringify(payload));
      throw new ValidationError(subject, result.error);
    }
  }
}
