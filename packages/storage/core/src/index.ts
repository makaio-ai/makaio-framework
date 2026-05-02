/**
 * \@makaio/storage-core
 *
 * Core storage namespace factory for bus-based storage services.
 *
 * Provides:
 * - createStorageNamespace: Factory for creating storage namespaces
 * - StorageNamespace: Type for storage namespace with extensions
 * - StorageNamespaceExtensions: Declaration merging interface for ORM extensions
 * @example
 * ```typescript
 * import { createStorageNamespace } from '@makaio/storage-core';
 * import { z } from 'zod';
 *
 * const SessionStorage = createStorageNamespace('session', {
 *   schemas: {
 *     get: { request: z.object({ sessionId: z.string() }), response: SessionSchema },
 *     set: { request: z.object({ sessionId: z.string(), session: SessionSchema }), response: SuccessSchema },
 *   },
 * });
 *
 * // Use subjects
 * await bus.request(SessionStorage.subjects.get, { sessionId: '123' });
 * ```
 * @packageDocumentation
 */

export { createStorageNamespace } from './create-storage-namespace.js';
export { createExtensionStorageNamespace } from './create-extension-storage-namespace.js';
export type {
  StorageNamespace,
  StorageNamespaceConfig,
  StorageNamespaceExtensions,
  StorageNamespaceFromConfig,
} from './types.js';
