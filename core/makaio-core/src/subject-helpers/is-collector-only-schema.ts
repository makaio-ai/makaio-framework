import type { CollectorOnlySubjectSchema, EventSchema, JournalOrSelf, SubjectSchema } from '../types/index.js';
import { inspectSubjectSchema } from './inspect-subject-schema.js';

/**
 * Check if a schema is wrapped as a collector-only subject, directly or
 * underneath a journal wrapper.
 *
 * A journal wrapper around a collector-only subject narrows to the whole outer
 * schema: it is never claimed to be a bare {@link CollectorOnlySubjectSchema}.
 * @param schema - The schema to check.
 * @returns True if the schema is a CollectorOnlySubjectSchema wrapper, or a
 *   journal wrapper around one.
 */
export function isCollectorOnlySchema(schema: SubjectSchema): schema is JournalOrSelf<CollectorOnlySubjectSchema> {
  return inspectSubjectSchema(schema).marks.collectorOnly;
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
