import type { z } from 'zod';
import { ValidationError } from '../errors/index.js';
import type { BusValidationMode, SchemaViolationCallback } from '../registries/namespace-registry.js';

/**
 * Validates a payload against a Zod schema in development mode.
 *
 * Behavior depends on the validation mode:
 * - `strict` (default): throws ValidationError on schema mismatch
 * - `lenient`: invokes onViolation callback, then returns without throwing
 * - `skip`: no-op (handled by caller, but guarded here as safety net)
 * @param subject - Subject identifier for error messages
 * @param payload - Payload to validate
 * @param schema - Zod schema to validate against
 * @param mode - Validation mode (default: 'strict')
 * @param onViolation - Callback for lenient mode violations
 * @throws ValidationError If validation fails in strict mode
 */
export function validateSchema(
  subject: string,
  payload: unknown,
  schema: z.ZodType,
  mode: BusValidationMode = 'strict',
  onViolation?: SchemaViolationCallback,
): void {
  if (process.env.NODE_ENV === 'production' || mode === 'skip') return;

  const result = schema.safeParse(payload);
  if (result.success) return;

  if (mode === 'lenient') {
    if (onViolation) {
      try {
        onViolation({ subject, payload, issues: result.error.issues });
      } catch (callbackError) {
        console.error(`[BUS] onSchemaViolation callback threw for "${subject}":`, callbackError);
      }
    }
    return;
  }

  console.error(`Payload validation failed for subject "${subject}":`, JSON.stringify(payload));
  throw new ValidationError(subject, result.error);
}
