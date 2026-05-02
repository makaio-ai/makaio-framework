import { MakaioBus } from '@makaio/bus-core';
import type { StorageNamespace, StorageNamespaceConfig, StorageNamespaceExtensions } from './types.js';
import type { FilterablePayloadIntersection, SchemaRecord, SubjectRecordFromSchemaRecord } from '@makaio/core';

/**
 * Creates a storage namespace with typed subject definitions.
 *
 * Thin wrapper around MakaioBus.registerNamespace that:
 * - Automatically prepends 'storage:' to the domain name
 * - Provides extension point for ORM schemas via declaration merging
 * - Preserves type-safe filtering capabilities
 * @param domain - Storage domain name (e.g., 'session' becomes 'storage:session')
 * @param config - Namespace configuration with schemas and optional extensions
 * @returns Storage namespace with typed subjects and extensions
 * @example
 * ```typescript
 * // Basic usage (bus-only)
 * const SessionStorage = createStorageNamespace('session', {
 *   schemas: {
 *     get: { request: z.object({ id: z.string() }), response: z.object({ data: DataSchema }) },
 *     set: { request: z.object({ id: z.string(), data: DataSchema }), response: z.object({ success: z.boolean() }) },
 *   },
 * });
 *
 * // With drizzle extension (after importing @makaio/storage-drizzle)
 * const SessionStorage = createStorageNamespace('session', {
 *   schemas: { ... },
 *   extensions: {
 *     drizzle: { sessions: sessionsTable },
 *   },
 * });
 * ```
 */
export function createStorageNamespace<
  N extends string,
  Schemas extends SchemaRecord,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
>(
  domain: N,
  config: StorageNamespaceConfig<Schemas, Ext>,
): StorageNamespace<
  N,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Ext,
  Schemas
> {
  const fullDomain = `storage:${domain}` as const;

  // Register with bus
  const busNamespace = MakaioBus.registerNamespace(fullDomain, config.schemas);

  return {
    ...busNamespace,
    domain,
    extensions: (config.extensions ?? {}) as Ext,
  } as StorageNamespace<
    N,
    SubjectRecordFromSchemaRecord<Schemas>,
    FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
    Ext,
    Schemas
  >;
}
