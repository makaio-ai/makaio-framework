import { createBusNamespace } from '@makaio/core';
import type { BusNamespaceDefinition, SchemaRecord } from '@makaio/core';
import type { StorageNamespaceConfig, StorageNamespaceExtensions } from './types.js';

/**
 * A declarative storage namespace definition.
 *
 * Created by {@link createStorageNamespaceDefinition}. Extends
 * {@link BusNamespaceDefinition} with storage-specific fields (`domain`,
 * `extensions`) and carries typed subject tokens for immediate use in bus
 * operations. Registration is deferred until
 * `createStorageNamespace(definition)` is called at a composition root.
 * @typeParam N - Storage domain name without the `'storage:'` prefix
 * @typeParam Schemas - Schema record mapping subject keys to Zod schemas
 * @typeParam Ext - Extension type preserving specific ORM table types
 */
export interface StorageNamespaceDefinition<
  N extends string = string,
  Schemas extends SchemaRecord = SchemaRecord,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
> extends BusNamespaceDefinition<`storage:${N}`, Schemas> {
  /**
   * Storage domain name without the `'storage:'` prefix (e.g., `'session'`).
   */
  readonly domain: N;

  /**
   * Extension properties added via declaration merging.
   * @see StorageNamespaceExtensions
   */
  readonly extensions: Ext;
}

/**
 * Creates a storage namespace definition with typed subject tokens.
 *
 * Pure function — no side-effects, no bus singleton mutation. The returned
 * definition can be used immediately for bus operations (`bus.on()`,
 * `bus.emit()`, etc.) and registered later at a composition root via
 * `createStorageNamespace(definition)`.
 * @param domain - Storage domain name without the `'storage:'` prefix
 *   (e.g., `'session'` becomes `'storage:session'`)
 * @param config - Namespace configuration with schemas and optional extensions
 * @returns Storage namespace definition with typed subject tokens and carried
 *   schemas
 * @example
 * ```typescript
 * import { createStorageNamespaceDefinition } from '@makaio/storage-core';
 * import { z } from 'zod';
 *
 * export const SessionStorageDefinition = createStorageNamespaceDefinition('session', {
 *   schemas: {
 *     get: { request: z.object({ sessionId: z.string() }), response: SessionSchema },
 *     set: { request: z.object({ sessionId: z.string(), session: SessionSchema }), response: SuccessSchema },
 *   },
 * });
 *
 * // Subjects are immediately available without registration:
 * bus.on(SessionStorageDefinition.subjects.get, handler);
 * ```
 */
export function createStorageNamespaceDefinition<
  N extends string,
  Schemas extends SchemaRecord,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
>(domain: N, config: StorageNamespaceConfig<Schemas, Ext>): StorageNamespaceDefinition<N, Schemas, Ext> {
  const fullDomain = `storage:${domain}` as const;
  const busDefinition = createBusNamespace(fullDomain, config.schemas);

  return {
    ...busDefinition,
    domain,
    extensions: (config.extensions ?? {}) as Ext,
  };
}
