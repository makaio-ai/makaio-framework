import type { EventSchema, JournalOrSelf, LocalSubjectSchema, RequestSchema, SubjectSchema } from '../types/index.js';
import { inspectSubjectSchema } from './inspect-subject-schema.js';

/**
 * Check if a schema is wrapped as a local subject, directly or underneath a
 * journal wrapper.
 *
 * A journal wrapper around a local subject narrows to the whole outer schema:
 * it is never claimed to be a bare {@link LocalSubjectSchema}.
 * @param schema - The schema to check
 * @returns True if the schema is a LocalSubjectSchema wrapper, or a journal
 *   wrapper around one
 */
export function isLocalSchema(schema: SubjectSchema): schema is JournalOrSelf<LocalSubjectSchema> {
  return inspectSubjectSchema(schema).marks.local;
}

/**
 * Create a local-only subject schema wrapper.
 *
 * Local subjects are never sent to transports (SharedWorker, WebSocket, etc.).
 * Use this for subjects whose payloads contain non-serializable data like
 * React components or functions.
 * @param schema - The event or request schema to mark as local
 * @returns A LocalSubjectSchema wrapper
 * @example
 * ```typescript
 * import { localSubject } from '@makaio/core';
 *
 * const WidgetSchemas = {
 *   // Local event - contains React component, can't be serialized
 *   register: localSubject(widgetDefinitionSchema),
 *
 *   // Local request - response contains functions
 *   getRenderer: localSubject({
 *     request: z.object({ widgetId: z.string() }),
 *     response: z.object({ render: z.function() }),
 *   }),
 * };
 * ```
 */
export function localSubject<T extends EventSchema | RequestSchema>(schema: T): LocalSubjectSchema<T> {
  return { __local: true, schema } as const;
}
