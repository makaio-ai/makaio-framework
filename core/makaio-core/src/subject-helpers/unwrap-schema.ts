import type { EventSchema, RequestSchema, SubjectSchema } from '../types/index.js';
import { inspectSubjectSchema } from './inspect-subject-schema.js';

/**
 * Unwrap any subject schema wrapper, including a journal wrapper and the
 * routing wrapper it may contain, to get the innermost bare schema.
 * Returns the schema as-is if not wrapped.
 * @param schema - The schema to unwrap
 * @returns The inner EventSchema or RequestSchema
 */
export function unwrapSchema(schema: SubjectSchema): EventSchema | RequestSchema {
  return inspectSubjectSchema(schema).schema;
}
