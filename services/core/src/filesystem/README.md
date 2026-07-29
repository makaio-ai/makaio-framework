# @makaio/services/filesystem

Directory browsing service providing filesystem navigation via bus requests.

## What This Is

- Bus-native service for browsing filesystem contents
- Multi-node architecture supporting local and remote filesystem sources
- Cross-platform path handling with breadcrumb navigation
- Git repository detection for directory entries
- Partial results with graceful error handling for inaccessible entries

## Quick Start

```typescript
import { MakaioBus } from '@makaio/bus-core';
import { FileSystemSubjects } from '@makaio/services/filesystem/namespace';
import { FileSystemService } from '@makaio/services/filesystem';

// Initialize the service with a unique machine identifier
const fsService = new FileSystemService(MakaioBus, 'local-node', 'Local');
await fsService.init();

// Discover available filesystem sources
const { sources } = await MakaioBus.request(FileSystemSubjects.listSources, {});
// sources: [{ machineId: 'local-node', label: 'Local' }]

// Get home directory
const { path: homePath } = await MakaioBus.request(FileSystemSubjects.getHomeDir, {
  machineId: 'local-node',
});

// List directory contents
const listing = await MakaioBus.request(FileSystemSubjects.listDirectory, {
  machineId: 'local-node',
  path: homePath,
  options: { includeHidden: false },
});

// Cleanup
await fsService.destroy();
```

## Architecture Principles

### Multi-Node Design

The service identifies itself via `machineId`, enabling multiple filesystem sources (local, containers, remote) to coexist. Requests are routed to the correct handler via `machineId` matching.

```
┌─────────────────┐     listSources      ┌──────────────────────┐
│   UI/Consumer   │ ───────────────────► │  FileSystemService   │
│                 │                      │  (machineId: 'local')│
│                 │ ◄─────────────────── │                      │
└─────────────────┘   { sources: [...] } └──────────────────────┘
        │
        │ listDirectory { machineId: 'local', path: homePath }
        │
        ▼
┌─────────────────┐
│  Directory      │
│  Listing        │
│  { entries, ... }│
└─────────────────┘
```

### Partial Results

Directory listings return partial results when individual entries fail (permission errors, broken symlinks). The `errors` array captures failures without blocking the entire listing.

## Key Exports

### Class

| Export | Description |
|--------|-------------|
| `FileSystemService` | Main service class handling bus requests |

### Types (from @makaio/services/filesystem/schemas)

| Export | Description |
|--------|-------------|
| `FileEntry` | Single file or directory entry |
| `ListDirectoryOptions` | Filtering options (hidden files, excludes) |
| `ListDirectoryResponse` | Full directory listing with navigation metadata |
| `FileSystemSource` | Machine identifier with human-readable label |
| `BreadcrumbEntry` | Path segment with full path for navigation |
| `DirectoryEntryError` | Error details for failed entries |

## Design Philosophy

### Faithful Filesystem View

The service provides a faithful view of the filesystem. Filtering decisions (hidden files, excluded directories) are controlled by the caller via options, not hardcoded policies.

### Default Noise Reduction

By default, common noise directories are excluded:
- `node_modules`, `.git`, `dist`, `build`
- `.next`, `coverage`, `.turbo`, `.cache`

Override via `options.excludeNames: []` to see everything.

### Cross-Platform Navigation

The `breadcrumbs` array provides full paths for each segment, enabling reliable navigation on both POSIX and Windows systems without path manipulation in the UI.

---

*Part of the Makaio platform*
