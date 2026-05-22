// Schema table export for drizzle-kit migration generation
export { preferences } from './storage/schema.js';
export type { PreferenceRow, NewPreferenceRow } from './storage/schema.js';

export { registerBrowserPreferencesStorage } from './storage/browser-handler.js';
export { registerDrizzlePreferencesStorage } from './storage/drizzle-handler.js';
export { registerHybridPreferencesStorage } from './storage/hybrid-handler.js';
export { StorageCoordinator } from './storage/storage-coordinator.js';
export type { StorageCoordinatorConfig } from './storage/storage-coordinator.js';
export { createConflictResolver, lastWriteWinsResolver } from './storage/conflict-resolvers.js';
export type { ConflictResolver } from './storage/conflict-resolvers.js';
export {
  getStorageKey,
  isStoredPreference,
  keyToRow,
  parseStorageKey,
  parseStoredPreference,
  rowToKey,
} from './storage/utils-common.js';
export type { RowKey } from './storage/utils-common.js';
export { buildPreferencePredicates, getPreferenceRow, queryPreferenceItems } from './storage/utils-drizzle.js';
