/**
 * Minimal cursor type consumed by {@link LogFileWatcher.seedFromCursors}.
 *
 * Contains only the fields the watcher actually reads. The full
 * `ImportCursorPosition` declared in `@makaio/ai-adapters-core` is a structural
 * superset of this interface, so callers passing `ImportCursorPosition[]` remain
 * type-safe without any changes.
 */
export interface FileWatcherCursor {
  /** Absolute path to the log file being tracked */
  filePath: string;

  /** Number of bytes successfully read and processed */
  bytesRead: number;

  /** ISO 8601 timestamp of file's last modification when cursor was saved */
  lastModified: string;
}
