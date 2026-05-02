# @makaio/tools-filesystem

Filesystem toolset for Makaio Framework. Cross-platform file operations with path validation and constraints support.

## Quick Start

```typescript
import { ToolRegistry } from '@makaio/services-core/tools';
import { filesystemToolset } from '@makaio/tools-filesystem';
import { createMakaioContext } from '@makaio/core';

const registry = new ToolRegistry();
await registry.register(filesystemToolset);

const contextOverrides = createMakaioContext({ cwd: '/path/to/project' });

// Read a file
const result = await registry.execute('read_file', {
  path: './package.json'
}, { contextOverrides });

if (result.success) {
  console.log(result.data.content);
}
```

## Available Tools

### read_file

Reads text content from a file with optional line offset/limit.

```typescript
// Input
{
  path: string;              // Absolute or relative to cwd
  encoding?: 'utf-8' | 'base64';  // Default: 'utf-8'
  offset?: number;           // Line offset (0-indexed)
  limit?: number;            // Max lines to read
}

// Output
{
  content: string;
  path: string;              // Resolved absolute path
  size: number;              // File size in bytes
  totalLines?: number;       // Total lines (if text)
  truncated: boolean;        // True if limit applied
}

// Annotations: { readOnly: true }
```

### write_file

Writes content to a file with optional directory creation.

```typescript
// Input
{
  path: string;              // Absolute or relative to cwd
  content: string;           // Content to write
  createDirectories?: boolean; // Create parent dirs if missing
  append?: boolean;          // Append instead of overwrite
}

// Output
{
  path: string;              // Resolved absolute path
  bytesWritten: number;
  created: boolean;          // True if file was created (not overwritten)
}

// Annotations: { destructive: true }
```

### list_directory

Lists directory contents with optional recursion.

```typescript
// Input
{
  path: string;              // Directory path
  recursive?: boolean;       // Recurse into subdirectories
  includeHidden?: boolean;   // Include dotfiles
  pattern?: string;          // Glob pattern to filter entries (*, ?)
}

// Output
{
  path: string;              // Resolved absolute path
  entries: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size?: number;           // For files only
  }>;
  totalCount: number;
}

// Annotations: { readOnly: true }
```

When `recursive` is false, `pattern` filters the entries returned from the requested directory. When `recursive` is
true, directories are still included and traversed even if they do not match `pattern`; the pattern is applied to
non-directory entries.

### delete_file

Deletes a regular file. Directories and symlinks are rejected.

```typescript
// Input
{
  path: string;              // Absolute or relative to cwd
}

// Output
{
  path: string;              // Resolved absolute path of the deleted file
}

// Annotations: { destructive: true }
```

## Path Resolution

All paths are resolved relative to `context.cwd`:

```typescript
import { createMakaioContext } from '@makaio/core';

const context = createMakaioContext({ cwd: '/home/user/project' });

// './src/index.ts' resolves to '/home/user/project/src/index.ts'
// '/etc/passwd' stays as '/etc/passwd' (absolute)
```

## Constraints

Use `context.constraints.allowedDirectories` to restrict access:

```typescript
const contextOverrides = createMakaioContext({
  cwd: '/home/user/project',
  constraints: {
    allowedDirectories: ['/home/user/project', '/tmp'],
  },
});

// Paths outside allowed directories return PERMISSION_DENIED error
```

## Direct Tool Access

```typescript
import { createMakaioContext } from '@makaio/core';
import { filesystemToolset } from '@makaio/tools-filesystem';

const readFileTool = filesystemToolset.tools.read_file;
const result = await readFileTool.execute({ path: './file.txt' }, createMakaioContext({ cwd: process.cwd() }));
```

The package root exports the toolset and file-access helpers. Individual tool definitions are not
root exports; use `filesystemToolset.tools` when a test or adapter needs direct access without a
registry.

## Cross-Platform Notes

- Path separators handled automatically by `node:path`
- Hidden files detected by `.` prefix (works on all platforms)
- Line endings preserved as-is (no normalization)

## File Index

| File | Purpose |
|------|---------|
| `src/toolset.ts` | Toolset definition with all tools |
| `src/tools/read-file.ts` | read_file implementation |
| `src/tools/write-file.ts` | write_file implementation |
| `src/tools/list-directory.ts` | list_directory implementation |
| `src/tools/delete-file.ts` | delete_file implementation |
| `src/utils/path-utils.ts` | Path resolution and validation |
| `src/utils/platform.ts` | Cross-platform helpers |
