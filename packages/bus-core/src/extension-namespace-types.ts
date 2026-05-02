import type { BusNamespace } from './types/namespace.js';
import type {
  FilterablePayloadIntersection,
  SchemaRecord,
  SubjectRecord,
  SubjectRecordFromSchemaRecord,
} from '@makaio/core';

/**
 * Extension point for extension namespace extensions.
 *
 * Use declaration merging to add extension-specific metadata or capabilities:
 * @example
 * ```typescript
 * // In an extension package
 * declare module '@makaio/bus-core' {
 *   interface ExtensionNamespaceExtensions {
 *     customMetadata?: {
 *       version: string;
 *       author: string;
 *     };
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExtensionNamespaceExtensions {}

/**
 * Extension namespace combines bus namespace with extensible extension-specific properties.
 *
 * Wraps BusNamespace with:
 * - Automatic 'extension:' prefix for domain naming
 * - Extension point for extension metadata via declaration merging
 * @typeParam N - Extension name (without 'extension:' prefix)
 * @typeParam Subjects - Subject record type from schemas
 * @typeParam FilterPayload - Filter payload type for type-safe filtering
 * @typeParam Ext - Extension type preserving specific metadata types
 * @typeParam Schemas - Original schema record; drives narrow literal types on subjects.$meta
 */
export interface ExtensionNamespace<
  N extends string = string,
  Subjects extends SubjectRecord = SubjectRecord,
  FilterPayload = unknown,
  Ext extends ExtensionNamespaceExtensions = ExtensionNamespaceExtensions,
  Schemas extends SchemaRecord = SchemaRecord,
> extends BusNamespace<`extension:${N}`, Subjects, FilterPayload, Schemas> {
  /**
   * Extension name (without 'extension:' prefix).
   */
  readonly domain: N;

  /**
   * Extension properties added via declaration merging.
   * @see ExtensionNamespaceExtensions
   */
  readonly extensions: Ext;
}

/**
 * Configuration for creating an extension namespace.
 * @typeParam Schemas - Schema record type for bus subjects
 * @typeParam Ext - Extension type preserving specific metadata types
 */
export interface ExtensionNamespaceConfig<
  Schemas extends SchemaRecord,
  Ext extends ExtensionNamespaceExtensions = ExtensionNamespaceExtensions,
> {
  /**
   * Bus subject schemas for extension operations.
   * Can include both request-response and event schemas.
   */
  schemas: Schemas;

  /**
   * Extension properties (populated by declaration merging).
   * @see ExtensionNamespaceExtensions
   */
  extensions?: Ext;
}

/**
 * Infer the extension namespace type from config.
 * @typeParam N - Extension name without the `extension:` prefix
 * @typeParam Schemas - Schema record type for bus subjects
 * @typeParam Ext - Extension type preserving specific metadata types
 */
export type ExtensionNamespaceFromConfig<
  N extends string,
  Schemas extends SchemaRecord,
  Ext extends ExtensionNamespaceExtensions = ExtensionNamespaceExtensions,
> = ExtensionNamespace<
  N,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Ext,
  Schemas
>;
