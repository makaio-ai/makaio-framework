/**
 * `@makaio/services-core/harness`
 *
 * Harness storage surface: bus namespace, entity types, and the Drizzle-backed
 * handler registration for persisting harness entities.
 */

// Bus namespace and subjects for harness storage
export { HarnessStorageNamespace, HarnessStorageSubjects } from './storage/namespace.js';
export type { Harness, HarnessInput, HarnessListQuery } from './storage/namespace.js';

// Drizzle-backed harness storage handlers (registered by the storage host)
export { registerDrizzleHarnessStorage } from './storage/handler.js';
