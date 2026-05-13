import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes, errorToToolResult } from '@makaio/tools-core';
import { getFileAccessRules, resolveAndValidatePath } from '../utils/index.js';
import { isHiddenName } from '../utils/platform.js';
import type { MakaioContext } from '@makaio/core';
import type { FileAccessRules } from '../types.js';

/**
 * Entry type enumeration for directory listing.
 */
const EntryTypeSchema = z.enum(['file', 'directory', 'symlink', 'other']);
export type EntryType = z.infer<typeof EntryTypeSchema>;

/**
 * Directory entry schema.
 */
const DirectoryEntrySchema = z.object({
  name: z.string().describe('Entry name'),
  path: z.string().describe('Full path'),
  type: EntryTypeSchema.describe('Entry type'),
  size: z.number().optional().describe('Size in bytes (files only)'),
});

export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

/**
 * Input schema for the list_directory tool.
 */
export const ListDirectoryInputSchema = z.object({
  path: z.string().describe('Directory path'),
  recursive: z.boolean().default(false).optional().describe('List directories recursively'),
  includeHidden: z.boolean().default(false).optional().describe('Include hidden files and directories'),
  pattern: z.string().optional().describe('Glob pattern to filter entries'),
});

/**
 * Output schema for the list_directory tool.
 */
export const ListDirectoryOutputSchema = z.object({
  path: z.string().describe('Resolved absolute path'),
  entries: z.array(DirectoryEntrySchema).describe('Directory entries'),
  totalCount: z.number().describe('Total number of entries'),
});

export type ListDirectoryInput = z.infer<typeof ListDirectoryInputSchema>;
export type ListDirectoryOutput = z.infer<typeof ListDirectoryOutputSchema>;

/**
 * Determines the entry type from a Dirent or Stats object.
 * @param entry - Dirent object from readdir
 * @returns Entry type classification
 */
function getEntryType(entry: {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}): EntryType {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

/**
 * Build a DirectoryEntry from a dirent, including optional file size.
 * @param dirent - The directory entry from readdir
 * @param entryPath - Full resolved path of the entry
 * @returns DirectoryEntry with size populated for files
 */
async function buildEntry(
  dirent: { isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean; name: string },
  entryPath: string,
): Promise<DirectoryEntry> {
  const entryType = getEntryType(dirent);
  const entry: DirectoryEntry = {
    name: dirent.name,
    path: entryPath,
    type: entryType,
  };

  if (entryType === 'file') {
    try {
      const stats = await fs.stat(entryPath);
      entry.size = stats.size;
    } catch {
      // If we can't stat, skip size
    }
  }

  return entry;
}

/**
 * Simple glob pattern matcher.
 * Supports * (any characters) and ? (single character).
 * @param pattern - Glob pattern
 * @param name - Name to match
 * @returns True if name matches pattern
 */
function matchGlob(pattern: string, name: string): boolean {
  // Convert glob to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*') // * -> .*
    .replace(/\?/g, '.'); // ? -> .

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(name);
}

/**
 * Reads a single directory and returns entries.
 * @param dirPath - Directory path to read
 * @param context - Makaio context
 * @param includeHidden - Include hidden entries
 * @param pattern - Optional glob pattern
 * @param rules - Optional compiled file access rules for .makaioignore filtering
 * @returns Array of directory entries
 */
async function readDirectory(
  dirPath: string,
  context: MakaioContext,
  includeHidden: boolean,
  pattern: string | undefined,
  rules?: FileAccessRules,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });

  for (const dirent of dirents) {
    // Skip hidden files if not requested
    if (!includeHidden && isHiddenName(dirent.name, context)) {
      continue;
    }

    const entryPath = path.join(dirPath, dirent.name);

    // Skip entries denied by .makaioignore rules
    if (rules?.isDenied(entryPath)) {
      continue;
    }

    // Apply glob pattern filter
    if (pattern && !matchGlob(pattern, dirent.name)) {
      continue;
    }

    entries.push(await buildEntry(dirent, entryPath));
  }

  return entries;
}

/**
 * Recursively reads directories.
 * @param dirPath - Starting directory path
 * @param context - Makaio context
 * @param includeHidden - Include hidden entries
 * @param pattern - Optional glob pattern (only applied to files, not directories)
 * @param signal - Optional abort signal
 * @param rules - Optional compiled file access rules for .makaioignore filtering
 * @returns Array of all entries recursively
 */
async function readDirectoryRecursive(
  dirPath: string,
  context: MakaioContext,
  includeHidden: boolean,
  pattern: string | undefined,
  signal?: AbortSignal,
  rules?: FileAccessRules,
): Promise<DirectoryEntry[]> {
  const allEntries: DirectoryEntry[] = [];

  /**
   * Recursively processes a directory path.
   * @param currentPath - Directory path to process
   */
  async function processDir(currentPath: string): Promise<void> {
    // Check for cancellation
    if (signal?.aborted) {
      return;
    }

    const dirents = await fs.readdir(currentPath, { withFileTypes: true });

    for (const dirent of dirents) {
      // Check for cancellation in inner loop
      if (signal?.aborted) {
        return;
      }

      // Skip hidden files if not requested
      if (!includeHidden && isHiddenName(dirent.name, context)) {
        continue;
      }

      const entryPath = path.join(currentPath, dirent.name);

      // Skip entries denied by .makaioignore rules — also prunes directory recursion
      if (rules?.isDenied(entryPath)) {
        continue;
      }

      const entryType = getEntryType(dirent);

      // For pattern matching on recursive: apply to files only
      // Directories are always included to enable traversal
      const shouldInclude = entryType === 'directory' || !pattern || matchGlob(pattern, dirent.name);

      if (shouldInclude) {
        allEntries.push(await buildEntry(dirent, entryPath));
      }

      // Recurse into directories
      if (entryType === 'directory') {
        try {
          await processDir(entryPath);
        } catch {
          // Skip directories we can't read (permission errors, etc.)
        }
      }
    }
  }

  await processDir(dirPath);
  return allEntries;
}

/**
 * List directory tool definition.
 * Lists contents of a directory with filtering options.
 */
export const listDirectoryTool = defineTool({
  name: 'list_directory',
  description:
    'Lists the contents of a directory. Supports recursive listing, ' +
    'hidden file filtering, and glob pattern matching.',
  annotations: { readOnly: true },
  inputSchema: ListDirectoryInputSchema,
  outputSchema: ListDirectoryOutputSchema,

  execute: async (input, context) => {
    // Resolve and validate path
    const pathResult = resolveAndValidatePath(input.path, context);
    if (!pathResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, pathResult.error);
    }
    const resolvedPath = pathResult.path;

    try {
      // Verify it's a directory
      const stats = await fs.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path '${resolvedPath}' is not a directory`);
      }

      const includeHidden = input.includeHidden ?? false;
      const pattern = input.pattern;
      const rules = getFileAccessRules(context);

      let entries: DirectoryEntry[];

      if (input.recursive) {
        entries = await readDirectoryRecursive(resolvedPath, context, includeHidden, pattern, context.signal, rules);
      } else {
        entries = await readDirectory(resolvedPath, context, includeHidden, pattern, rules);
      }

      // Sort entries: directories first, then alphabetically
      entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      return toolSuccess({
        path: resolvedPath,
        entries,
        totalCount: entries.length,
      });
    } catch (err) {
      // Handle specific error codes
      if (err instanceof Error && 'code' in err) {
        const code = (err as NodeJS.ErrnoException).code;

        if (code === 'ENOENT') {
          return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `Directory not found: ${resolvedPath}`);
        }

        if (code === 'EACCES' || code === 'EPERM') {
          return toolError(ToolErrorCodes.PERMISSION_DENIED, `Permission denied: ${resolvedPath}`);
        }

        if (code === 'ENOTDIR') {
          return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path is not a directory: ${resolvedPath}`);
        }
      }

      return errorToToolResult(err);
    }
  },
});
