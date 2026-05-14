import { z } from 'zod';
import type { RequestSchema, SubjectSchema } from '../types/index.js';

/**
 * Type guard to check if a schema is a request schema.
 * @param schema - The schema to check
 * @returns True if the schema is a RequestSchema, false otherwise
 */
export function isRequestSchema(schema: SubjectSchema): schema is RequestSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    'request' in schema &&
    'response' in schema &&
    schema.request instanceof z.ZodType &&
    schema.response instanceof z.ZodType
  );
}
