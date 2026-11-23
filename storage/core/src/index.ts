/**
 * \@makaio/storage-core
 *
 * Core storage namespace factory for bus-based storage services.
 *
 * Provides:
 * - `createStorageNamespaceDefinition` — pure factory for declaring storage
 *   namespaces without touching a bus
 * - `createExtensionStorageNamespace` — convenience wrapper for extension
 *   storage namespaces
 * - `StorageNamespaceDefinition` — type for the declarative definition object
 * - `StorageNamespace` — type for the registered runtime namespace
 * - `StorageNamespaceExtensions` — declaration merging interface for ORM
 *   extensions
 * @example
 * ```typescript
 * import { createBusInstance } from '@makaio/bus-core';
 * import { createStorageNamespaceDefinition } from '@makaio/storage-core';
 * import { z } from 'zod';
 *
 * // Pure declaration (no side-effects):
 * export const SessionStorageDefinition = createStorageNamespaceDefinition('session', {
 *   schemas: {
 *     get: { request: z.object({ sessionId: z.string() }), response: SessionSchema },
 *     set: { request: z.object({ sessionId: z.string(), session: SessionSchema }), response: SuccessSchema },
 *   },
 * });
 *
 * // At the host composition root:
 * const bus = createBusInstance();
 * bus.registerNamespace(SessionStorageDefinition);
 * ```
 * Extensions include static definitions in their manifest's `namespaces`
 * array or claim runtime definitions with `ctx.namespaces.lease(definition)`.
 * @packageDocumentation
 */

export { createExtensionStorageNamespace } from './create-extension-storage-namespace';
export { createStorageNamespaceDefinition } from './create-storage-namespace-definition';
export type { StorageNamespaceDefinition } from './create-storage-namespace-definition';
export type {
  StorageNamespace,
  StorageNamespaceConfig,
  StorageNamespaceExtensions,
  StorageNamespaceFromConfig,
} from './types';
