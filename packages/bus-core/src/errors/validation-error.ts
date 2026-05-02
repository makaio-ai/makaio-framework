import { z } from 'zod';
import { BusError } from './bus-error.js';

/**
 * Error thrown when payload validation fails.
 */
export class ValidationError extends BusError {
  /**
   * @param subject - Fully-qualified subject name for which validation failed
   * @param zodError - Zod validation error containing the individual issue details
   */
  public constructor(
    subject: string,
    public readonly zodError: z.ZodError,
  ) {
    const issues = zodError.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    super(`Validation failed for subject "${subject}":\n${issues.join('\n')}`, subject);
  }
}
