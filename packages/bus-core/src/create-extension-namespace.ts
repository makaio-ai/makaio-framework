import { createBusNamespace } from '@makaio/core';
import type {
  ExtensionNamespace,
  ExtensionNamespaceConfig,
  ExtensionNamespaceExtensions,
} from './extension-namespace-types.js';
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
 * Creates an extension namespace with typed subject definitions.
 *
 * Pure wrapper around {@link createBusNamespace} that:
 * - Automatically prepends 'extension:' to the domain name
 * - Provides extension point for extension-specific metadata via declaration merging
 * - Preserves type-safe filtering capabilities
 * @param extensionName - Extension name (e.g., 'terminal' becomes 'extension:terminal')
 * @param config - Namespace configuration with schemas and optional extensions
 * @returns Extension namespace with typed subjects and extensions
 * @example
 * ```typescript
 * // Basic usage (bus-only)
 * const TerminalExtension = createExtensionNamespace('terminal', {
 *   schemas: {
 *     spawn: { request: z.object({ cwd: z.string() }), response: z.object({ terminalId: z.string() }) },
 *     output: z.object({ terminalId: z.string(), data: z.string() }),
 *   },
 * });
 *
 * // With custom extension (after importing extension package)
 * const MyExtension = createExtensionNamespace('my-extension', {
 *   schemas: { ... },
 *   extensions: {
 *     customMetadata: { version: '1.0.0' },
 *   },
 * });
 * ```
 */
export function createExtensionNamespace<
  N extends string,
  Schemas extends SchemaRecord,
  Ext extends ExtensionNamespaceExtensions = ExtensionNamespaceExtensions,
>(
  extensionName: N,
  config: ExtensionNamespaceConfig<Schemas, Ext>,
): ExtensionNamespace<
  Trim<N>,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Ext,
  Schemas
> {
  const normalizedExtensionName = extensionName.trim();
  if (normalizedExtensionName.length === 0 || normalizedExtensionName.startsWith('extension:')) {
    throw new Error('Invalid extensionName: expected a non-empty extension name without the "extension:" prefix.');
  }

  const normalizedName = normalizedExtensionName as Trim<N>;
  const fullDomain = `extension:${normalizedName}` as const;

  const busNamespace = createBusNamespace(fullDomain, config.schemas);

  return {
    ...busNamespace,
    domain: normalizedName,
    extensions: (config.extensions ?? {}) as Ext,
  } as ExtensionNamespace<
    Trim<N>,
    SubjectRecordFromSchemaRecord<Schemas>,
    FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
    Ext,
    Schemas
  >;
}
