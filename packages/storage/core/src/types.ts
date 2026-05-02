import type { BusNamespace } from '@makaio/bus-core';
import type {
  FilterablePayloadIntersection,
  SchemaRecord,
  SubjectRecord,
  SubjectRecordFromSchemaRecord,
} from '@makaio/core';

/**
 * Extension point for storage namespace extensions.
 *
 * Use declaration merging to add ORM-specific properties:
 * @example
 * ```typescript
 * // In @makaio/storage-drizzle
 * declare module '@makaio/storage-core' {
 *   interface StorageNamespaceExtensions {
 *     drizzle?: Record<string, Table>;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StorageNamespaceExtensions {}

/**
 * Storage namespace combines bus namespace with extensible storage-specific properties.
 *
 * Wraps BusNamespace with:
 * - Automatic 'storage:' prefix for domain naming
 * - Extension point for ORM schemas via declaration merging
 * @typeParam N - Storage domain name (without 'storage:' prefix)
 * @typeParam Subjects - Subject record type from schemas
 * @typeParam FilterPayload - Filter payload type for type-safe filtering
 * @typeParam Ext - Extension type preserving specific table types
 * @typeParam Schemas - Original schema record; drives narrow literal types on subjects.$meta
 */
export interface StorageNamespace<
  N extends string = string,
  Subjects extends SubjectRecord = SubjectRecord,
  FilterPayload = unknown,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
  Schemas extends SchemaRecord = SchemaRecord,
> extends BusNamespace<`storage:${N}`, Subjects, FilterPayload, Schemas> {
  /**
   * Storage domain name (without 'storage:' prefix).
   */
  readonly domain: N;

  /**
   * Extension properties added via declaration merging.
   * @see StorageNamespaceExtensions
   */
  readonly extensions: Ext;
}

/**
 * Configuration for creating a storage namespace.
 * @typeParam Schemas - Schema record type for bus subjects
 * @typeParam Ext - Extension type preserving specific table types
 */
export interface StorageNamespaceConfig<
  Schemas extends SchemaRecord,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
> {
  /**
   * Bus subject schemas for storage operations.
   * Typically includes get, set, delete, list operations.
   */
  schemas: Schemas;

  /**
   * Extension properties (populated by declaration merging).
   * @see StorageNamespaceExtensions
   */
  extensions?: Ext;
}

/**
 * Infer the storage namespace type from config.
 */
export type StorageNamespaceFromConfig<N extends string, Schemas extends SchemaRecord> = StorageNamespace<
  N,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  StorageNamespaceExtensions,
  Schemas
>;
