/**
 * Public API for \@makaio/file-watcher.
 * @packageDocumentation
 */

export { LogFileWatcher } from './file-watcher.js';
export type {
  FileWatcherOptions,
  FileChangeEvent,
  FileChangeType,
  FileDeletedEvent,
  FileWatcherPolledEvent,
  FileWatcherEvents,
  FileWatcherTrackedFileState,
} from './file-watcher.js';

export type { FileWatcherCursor } from './types.js';
