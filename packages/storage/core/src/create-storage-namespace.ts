import { MakaioBus } from '@makaio/bus-core';
import type { FilterablePayloadIntersection, SchemaRecord, SubjectRecordFromSchemaRecord } from '@makaio/core';
import type { StorageNamespace, StorageNamespaceExtensions } from './types.js';
import type { StorageNamespaceDefinition } from './create-storage-namespace-definition.js';

/**
 * Registers a storage namespace definition on the bus singleton.
 *
 * Accepts a {@link StorageNamespaceDefinition} created by
 * {@link createStorageNamespaceDefinition} and registers it with
 * `MakaioBus.registerNamespace()`. Returns a {@link StorageNamespace} that
 * additionally exposes `scopedBus()` for scoped bus operations.
 *
 * Call this function at composition roots (app entry-points, service
 * constructors) — never in module scope where the bus singleton may not yet
 * be ready.
 * @param definition - Storage namespace definition created by
 *   `createStorageNamespaceDefinition()`
 * @returns Storage namespace with typed subjects, `scopedBus()`, and
 *   extensions
 * @example
 * ```typescript
 * // At module level (pure, no side-effects):
 * export const SessionStorageDefinition = createStorageNamespaceDefinition('session', {
 *   schemas: {
 *     get: { request: z.object({ id: z.string() }), response: z.object({ data: DataSchema }) },
 *     set: { request: z.object({ id: z.string(), data: DataSchema }), response: z.object({ success: z.boolean() }) },
 *   },
 * });
 *
 * // At composition root (registers on the bus):
 * const SessionStorage = createStorageNamespace(SessionStorageDefinition);
 * await bus.request(SessionStorage.subjects.get, { id: '123' });
 * ```
 */
export function createStorageNamespace<
  N extends string,
  Schemas extends SchemaRecord,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
>(
  definition: StorageNamespaceDefinition<N, Schemas, Ext>,
): StorageNamespace<
  N,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Ext,
  Schemas
> {
  const busNamespace = MakaioBus.registerNamespace(definition);

  return {
    ...busNamespace,
    domain: definition.domain,
    extensions: definition.extensions,
  } as StorageNamespace<
    N,
    SubjectRecordFromSchemaRecord<Schemas>,
    FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
    Ext,
    Schemas
  >;
}
