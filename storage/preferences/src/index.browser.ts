/**
 * Browser-safe entry for `@makaio/preferences`.
 *
 * Re-exports the browser storage handler used by the web layer.
 * Excludes drizzle handler, hybrid handler, storage coordinator, and schema
 * that pull in Node-only / drizzle dependencies.
 * @packageDocumentation
 */

export { registerBrowserPreferencesStorage } from './storage/browser-handler.js';
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
