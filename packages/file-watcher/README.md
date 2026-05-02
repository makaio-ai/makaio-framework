# @makaio/file-watcher

Polling-based file watcher for log and data files. Uses `mtime` + size
comparison to detect creation, modification, and log rotation without relying
on `fs.watch` or OS-level inotify, making it reliable across network
filesystems and all supported platforms.

## Usage

```typescript
import { LogFileWatcher } from '@makaio/file-watcher';

const watcher = new LogFileWatcher({
  directory: '/home/user/.makaio/sessions',
  pattern: '*.jsonl',
  pollIntervalMs: 5000,
});

watcher.on('change', ({ filePath, changeType, stat }) => {
  if (changeType === 'rotated') {
    // Re-read from the beginning
  } else {
    // Read from cursor position
  }
});

watcher.on('deleted', ({ filePath }) => {
  // Clean up cursor state
});

watcher.on('polled', ({ trackedFilePaths }) => {
  // Called after every complete poll cycle
});

// Seed from persisted cursors to avoid re-emitting already-processed content:
watcher.seedFromCursors(savedCursors);

await watcher.start();

// Trigger an immediate single-file check (e.g. on active session writes):
watcher.triggerImmediatePoll(filePath);

// Stop polling while preserving tracked state:
watcher.stop();

// Full cleanup:
watcher.dispose();
```

## API Overview

| Export | Description |
|--------|-------------|
| `LogFileWatcher` | Polling file watcher with `on`, `once`, `start`, `stop`, `dispose`, `seedFromCursors`, `triggerImmediatePoll`, `getTrackedFiles` |
| `type FileWatcherOptions` | `directory`, `pattern`, `pollIntervalMs` |
| `type FileChangeEvent` | `filePath`, `stat`, `changeType` |
| `type FileChangeType` | `'created'` \| `'modified'` \| `'rotated'` |
| `type FileDeletedEvent` | `filePath` |
| `type FileWatcherPolledEvent` | `trackedFilePaths` set after each poll cycle |
| `type FileWatcherEvents` | Typed event map: `change`, `deleted`, `error`, `polled` |
| `type FileWatcherTrackedFileState` | `size` and `mtimeMs` per tracked file |
| `type FileWatcherCursor` | Cursor shape expected by `seedFromCursors` |

## Key Concepts

- **Rotation detection**: a file is `'rotated'` when its mtime changes but its
  size is smaller than previously observed — the canonical indicator of log rotation.
- **Cursor seeding**: call `seedFromCursors()` before `start()` to initialize
  tracked state from persisted byte offsets. Prevents spurious `'created'`
  events when the watcher restarts.
- **In-flight gating**: the same per-file lock prevents concurrent checks from
  both the regular poll loop and `triggerImmediatePoll`.

## Installation

`@makaio/file-watcher` is a private workspace package:

```json
{ "@makaio/file-watcher": "workspace:*" }
```

---

*Part of the [Makaio AI Framework](../../README.md)*
