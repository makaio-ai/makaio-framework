import type { CollectorOnlySubjectSchema, EventSchema, SubjectSchema } from '../types/index.js';

/**
 * Check if a schema is wrapped as a collector-only subject.
 * @param schema - The schema to check.
 * @returns True if the schema is a CollectorOnlySubjectSchema wrapper.
 */
export function isCollectorOnlySchema(schema: SubjectSchema): schema is CollectorOnlySubjectSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '__collectorOnly' in schema &&
    schema.__collectorOnly === true &&
    'schema' in schema
  );
}

/**
 * Create a collector-only event schema wrapper.
 *
 * Collector-only events are transport-ingestable but not transport-relayable:
 * a collector bus can receive them from an upstream peer and handle them
 * locally without pushing them laterally to unrelated peers.
 * @param schema - The event schema to mark as collector-only.
 * @returns A CollectorOnlySubjectSchema wrapper.
 */
export function collectorOnlySubject<T extends EventSchema>(schema: T): CollectorOnlySubjectSchema<T> {
  return { __collectorOnly: true, schema } as const;
}
