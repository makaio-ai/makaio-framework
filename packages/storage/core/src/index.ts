/**
 * \@makaio/storage-core
 *
 * Core storage namespace factory for bus-based storage services.
 *
 * Provides:
 * - `createStorageNamespaceDefinition` — pure factory for declaring storage
 *   namespaces without touching the bus singleton
 * - `createStorageNamespace` — registers a definition on the bus at a
 *   composition root and returns a full `StorageNamespace` with `scopedBus()`
 * - `createExtensionStorageNamespace` — convenience wrapper for extension
 *   storage namespaces
 * - `StorageNamespaceDefinition` — type for the declarative definition object
 * - `StorageNamespace` — type for the registered runtime namespace
 * - `StorageNamespaceExtensions` — declaration merging interface for ORM
 *   extensions
 * @example
 * ```typescript
 * import { createStorageNamespaceDefinition, createStorageNamespace } from '@makaio/storage-core';
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
 * // At composition root (registers on the bus):
 * const SessionStorage = createStorageNamespace(SessionStorageDefinition);
 * await bus.request(SessionStorage.subjects.get, { sessionId: '123' });
 * ```
 * @packageDocumentation
 */

export { createStorageNamespace } from './create-storage-namespace.js';
export { createExtensionStorageNamespace } from './create-extension-storage-namespace.js';
export { createStorageNamespaceDefinition } from './create-storage-namespace-definition.js';
export type { StorageNamespaceDefinition } from './create-storage-namespace-definition.js';
export type {
  StorageNamespace,
  StorageNamespaceConfig,
  StorageNamespaceExtensions,
  StorageNamespaceFromConfig,
} from './types.js';
