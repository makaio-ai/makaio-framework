// services/filesystem/src/queries.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  BreadcrumbEntry,
  DirectoryEntryError,
  FileEntry,
  ListDirectoryOptions,
  ListDirectoryResponse,
} from './schemas.js';

/**
 * Default directories to exclude (noise reduction).
 * Caller can override via options.excludeNames.
 */
const DEFAULT_EXCLUDE_NAMES = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache'];

/**
 * Parse path into segments for breadcrumb navigation.
 * Works cross-platform using path.sep.
 * @param dirPath - Absolute path to parse
 * @returns Array of path segments (excluding empty strings from root)
 */
function getPathSegments(dirPath: string): string[] {
  return dirPath.split(path.sep).filter(Boolean);
}

/**
 * Get parent directory path.
 * Returns null if at filesystem root.
 * @param dirPath - Current directory path
 * @returns Parent path or null at root
 */
function getParentPath(dirPath: string): string | null {
  const parent = path.dirname(dirPath);
  // At root, dirname returns the same path (or '/' on POSIX, 'C:\' on Windows)
  return parent === dirPath ? null : parent;
}

/**
 * Build breadcrumb entries with full paths for cross-platform navigation.
 * @param dirPath - Absolute path to build breadcrumbs for
 * @returns Array of breadcrumb entries with name and full path
 */
function getBreadcrumbs(dirPath: string): BreadcrumbEntry[] {
  const segments = getPathSegments(dirPath);
  const breadcrumbs: BreadcrumbEntry[] = [];

  // Build paths incrementally using path.join for cross-platform support
  let currentPath = path.parse(dirPath).root; // Start from root (e.g., '/' or 'C:\')

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    breadcrumbs.push({ name: segment, path: currentPath });
  }

  return breadcrumbs;
}

/**
 * List contents of a directory.
 *
 * Returns partial results with errors array if individual entries fail.
 * Filtering is controlled by options - service is a faithful view of filesystem.
 * @param dirPath - Directory path to list
 * @param options - Filtering options (includeHidden, excludeNames)
 * @returns Directory listing with entries, errors, and navigation metadata
 */
export async function listDirectory(
  dirPath: string,
  options?: Partial<ListDirectoryOptions>,
): Promise<ListDirectoryResponse> {
  const resolved = path.resolve(dirPath);
  const dirents = await fs.readdir(resolved, { withFileTypes: true });

  const includeHidden = options?.includeHidden ?? false;
  const excludeNames = new Set(options?.excludeNames ?? DEFAULT_EXCLUDE_NAMES);

  const entries: FileEntry[] = [];
  const errors: DirectoryEntryError[] = [];

  for (const dirent of dirents) {
    const isHidden = dirent.name.startsWith('.');

    // Apply filtering based on options
    if (isHidden && !includeHidden) continue;
    if (excludeNames.has(dirent.name)) continue;

    const fullPath = path.join(resolved, dirent.name);
    const isDir = dirent.isDirectory();

    try {
      let isGitRepo = false;
      if (isDir) {
        try {
          await fs.access(path.join(fullPath, '.git'));
          isGitRepo = true;
        } catch {
          // Not a git repo
        }
      }

      const stat = await fs.stat(fullPath);

      entries.push({
        name: dirent.name,
        path: fullPath,
        type: isDir ? 'directory' : 'file',
        isGitRepo: isDir ? isGitRepo : undefined,
        size: isDir ? undefined : stat.size,
        modified: stat.mtimeMs,
      });
    } catch (err) {
      // Collect error for partial results instead of failing entire listing
      const error = err as NodeJS.ErrnoException;
      errors.push({
        name: dirent.name,
        code: error.code ?? 'UNKNOWN',
        message: error.message,
      });
    }
  }

  // Sort: directories first, then alphabetically
  entries.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });

  // Check if current directory is a git repo
  let isGitRepo = false;
  try {
    await fs.access(path.join(resolved, '.git'));
    isGitRepo = true;
  } catch {
    // Not a git repo
  }

  return {
    entries,
    isGitRepo,
    path: resolved,
    parentPath: getParentPath(resolved),
    segments: getPathSegments(resolved),
    breadcrumbs: getBreadcrumbs(resolved),
    errors: errors.length > 0 ? errors : undefined,
  };
}
