import type { StorageNamespace, StorageNamespaceConfig, StorageNamespaceExtensions } from './types.js';
import { createStorageNamespace } from './create-storage-namespace.js';
import type { FilterablePayloadIntersection, SchemaRecord, SubjectRecordFromSchemaRecord } from '@makaio/core';

type Whitespace =
  | ' '
  | '\n'
  | '\r'
  | '\t'
  | '\v'
  | '\f'
  | '\u00A0'
  | '\u1680'
  | '\u2000'
  | '\u2001'
  | '\u2002'
  | '\u2003'
  | '\u2004'
  | '\u2005'
  | '\u2006'
  | '\u2007'
  | '\u2008'
  | '\u2009'
  | '\u200A'
  | '\u2028'
  | '\u2029'
  | '\u202F'
  | '\u205F'
  | '\u3000'
  | '\uFEFF';
type TrimLeft<T extends string> = T extends `${Whitespace}${infer Rest}` ? TrimLeft<Rest> : T;
type TrimRight<T extends string> = T extends `${infer Rest}${Whitespace}` ? TrimRight<Rest> : T;
type Trim<T extends string> = string extends T ? string : TrimLeft<TrimRight<T>>;

/**
 * Creates a storage namespace for an extension with typed subject definitions.
 *
 * Thin wrapper around createStorageNamespace that:
 * - Automatically prepends 'extension:' to the extension name before creating storage namespace
 * - Results in namespaces like 'storage:extension:terminal'
 * - Preserves all storage namespace capabilities (ORM extensions, type-safe filtering)
 * @param extensionName - Extension name (e.g., 'terminal' becomes 'storage:extension:terminal')
 * @param config - Storage namespace configuration with schemas and optional extensions
 * @returns Storage namespace with typed subjects and extensions
 * @example
 * ```typescript
 * // Basic usage
 * const TerminalStorage = createExtensionStorageNamespace('terminal', {
 *   schemas: {
 *     get: { request: z.object({ id: z.string() }), response: z.object({ data: DataSchema }) },
 *     set: { request: z.object({ id: z.string(), data: DataSchema }), response: z.object({ success: z.boolean() }) },
 *   },
 * });
 *
 * // With drizzle extension (after importing @makaio/storage-drizzle)
 * const TerminalStorage = createExtensionStorageNamespace('terminal', {
 *   schemas: { ... },
 *   extensions: {
 *     drizzle: { terminals: terminalsTable },
 *   },
 * });
 * ```
 */
export function createExtensionStorageNamespace<
  N extends string,
  Schemas extends SchemaRecord,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
>(
  extensionName: N,
  config: StorageNamespaceConfig<Schemas, Ext>,
): StorageNamespace<
  `extension:${Trim<N>}`,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Ext,
  Schemas
> {
  const normalizedExtensionName = extensionName.trim();
  if (normalizedExtensionName.length === 0 || normalizedExtensionName.startsWith('extension:')) {
    throw new Error('Invalid extensionName: expected a non-empty extension name without the "extension:" prefix.');
  }

  return createStorageNamespace(`extension:${normalizedExtensionName}` as `extension:${Trim<N>}`, config);
}
