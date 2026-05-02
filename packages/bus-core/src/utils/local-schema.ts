import type { EventSchema, LocalSubjectSchema, RequestSchema, SubjectSchema } from '@makaio/core';

/**
 * Check if a schema is wrapped as a local subject.
 * @param schema - The schema to check
 * @returns True if the schema is a LocalSubjectSchema wrapper
 */
export function isLocalSchema(schema: SubjectSchema): schema is LocalSubjectSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '__local' in schema &&
    schema.__local === true &&
    'schema' in schema
  );
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
 * import { localSubject } from '@makaio/bus-core';
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
