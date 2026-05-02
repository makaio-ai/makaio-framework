import * as path from 'node:path';
import { z } from 'zod';

const AbsolutePathSchema = z
  .string()
  .refine((value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value), 'Expected an absolute path');

// =============================================================================
// File Watcher Schemas (events + watch/unwatch requests)
// =============================================================================

/**
 * File change kind.
 */
export const FsChangeKindSchema = z.enum(['create', 'change', 'delete']);
export type FsChangeKind = z.infer<typeof FsChangeKindSchema>;

/**
 * Single file change event payload.
 */
export const FsChangedSchema = z.object({
  path: AbsolutePathSchema,
  kind: FsChangeKindSchema,
});
export type FsChanged = z.infer<typeof FsChangedSchema>;

/**
 * Batch file change event payload.
 */
export const FsBatchSchema = z.object({
  changes: z.array(FsChangedSchema),
});
export type FsBatch = z.infer<typeof FsBatchSchema>;

/**
 * Watch request payload.
 */
export const FsWatchRequestSchema = z.object({
  /** Unique identifier for this watch registration */
  id: z.string(),
  /** Paths to watch (directories or globs) */
  paths: z.array(z.string()),
  /** File extensions to include (default: all) */
  extensions: z.array(z.string()).optional(),
  /** Default patterns to exclude from ignoring (allows watching normally-ignored paths) */
  excludeFromDefaults: z.array(z.string()).optional(),
});
export type FsWatchRequest = z.infer<typeof FsWatchRequestSchema>;

/**
 * Watch response payload.
 */
export const FsWatchResponseSchema = z.object({
  success: z.boolean(),
  watchId: z.string(),
});
export type FsWatchResponse = z.infer<typeof FsWatchResponseSchema>;

/**
 * Unwatch request payload.
 */
export const FsUnwatchRequestSchema = z.object({
  /** Watch ID returned from watch request */
  id: z.string(),
});
export type FsUnwatchRequest = z.infer<typeof FsUnwatchRequestSchema>;

/**
 * Unwatch response payload.
 */
export const FsUnwatchResponseSchema = z.object({
  success: z.boolean(),
});
export type FsUnwatchResponse = z.infer<typeof FsUnwatchResponseSchema>;

// =============================================================================
// Directory Browsing Schemas
// =============================================================================

/**
 * Single file or directory entry.
 */
export const FileEntrySchema = z.object({
  /** Entry name (filename or directory name) */
  name: z.string(),
  /** Full absolute path */
  path: AbsolutePathSchema,
  /** Entry type */
  type: z.enum(['file', 'directory']),
  /** Path relative to a working directory (optional, for search results) */
  relativePath: z.string().optional(),
  /** Whether this directory is a git repository (directories only) */
  isGitRepo: z.boolean().optional(),
  /** File size in bytes (files only) */
  size: z.number().optional(),
  /** Last modified timestamp (ms since epoch) */
  modified: z.number().optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

/**
 * Per-entry error when reading a directory.
 * Used for partial results when some entries fail to read.
 */
export const DirectoryEntryErrorSchema = z.object({
  /** Entry name that failed */
  name: z.string(),
  /** Error code (e.g., 'EACCES', 'ENOENT') */
  code: z.string(),
  /** Human-readable error message */
  message: z.string(),
});
export type DirectoryEntryError = z.infer<typeof DirectoryEntryErrorSchema>;

/**
 * Options for listing directory contents.
 * Policy decisions (filtering) are made by the caller, not the service.
 */
export const ListDirectoryOptionsSchema = z.object({
  /** Include hidden files/directories (starting with .) */
  includeHidden: z.boolean().optional().default(false),
  /** Directory names to exclude from listing */
  excludeNames: z.array(z.string()).optional(),
});
export type ListDirectoryOptions = z.infer<typeof ListDirectoryOptionsSchema>;

/**
 * A filesystem source (machine) that can be browsed.
 */
export const FileSystemSourceSchema = z.object({
  /** Unique machine identifier */
  machineId: z.string(),
  /** Human-readable label (e.g., "Local", "Container-1") */
  label: z.string(),
});
export type FileSystemSource = z.infer<typeof FileSystemSourceSchema>;

// =============================================================================
// listSources - Discover available filesystem nodes
// =============================================================================

export const ListSourcesRequestSchema = z.object({});
export type ListSourcesRequest = z.infer<typeof ListSourcesRequestSchema>;

export const ListSourcesResponseSchema = z.object({
  sources: z.array(FileSystemSourceSchema),
});
export type ListSourcesResponse = z.infer<typeof ListSourcesResponseSchema>;

// =============================================================================
// listDirectory - Browse directory contents
// =============================================================================

export const ListDirectoryRequestSchema = z.object({
  /** Target filesystem machine (required - discover via listSources first) */
  machineId: z.string(),
  /** Directory path to list (optional, defaults to home) */
  path: z.string().optional(),
  /** Listing options (filtering, hidden files) */
  options: ListDirectoryOptionsSchema.optional(),
});
export type ListDirectoryRequest = z.infer<typeof ListDirectoryRequestSchema>;

/**
 * Breadcrumb entry with full path for navigation.
 */
export const BreadcrumbEntrySchema = z.object({
  /** Segment name (e.g., 'Users', 'chris') */
  name: z.string(),
  /** Full absolute path to this segment */
  path: z.string(),
});
export type BreadcrumbEntry = z.infer<typeof BreadcrumbEntrySchema>;

export const ListDirectoryResponseSchema = z.object({
  /** Directory entries (files and subdirectories) */
  entries: z.array(FileEntrySchema),
  /** Whether the listed directory itself is a git repository */
  isGitRepo: z.boolean(),
  /** Resolved absolute path */
  path: z.string(),
  /** Parent directory path (null at filesystem root) */
  parentPath: z.string().nullable(),
  /** Path segments for breadcrumb navigation (e.g., ['Users', 'chris', 'code']) */
  segments: z.array(z.string()),
  /** Breadcrumbs with full paths for cross-platform navigation */
  breadcrumbs: z.array(BreadcrumbEntrySchema),
  /** Errors encountered while reading individual entries (partial results) */
  errors: z.array(DirectoryEntryErrorSchema).optional(),
});
export type ListDirectoryResponse = z.infer<typeof ListDirectoryResponseSchema>;

// =============================================================================
// getHomeDir - Get home directory path for a node
// =============================================================================

export const GetHomeDirRequestSchema = z.object({
  /** Target filesystem machine (required - discover via listSources first) */
  machineId: z.string(),
});
export type GetHomeDirRequest = z.infer<typeof GetHomeDirRequestSchema>;

export const GetHomeDirResponseSchema = z.object({
  /** Home directory path */
  path: z.string(),
});
export type GetHomeDirResponse = z.infer<typeof GetHomeDirResponseSchema>;

// =============================================================================
// Glob Schemas - Pattern-based file search
// =============================================================================

// =============================================================================
// readFile - Read file content
// =============================================================================

export const ReadFileRequestSchema = z.object({
  path: AbsolutePathSchema,
  machineId: z.string().optional(),
  encoding: z.string().optional().default('utf-8'),
});
export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;

export const ReadFileResponseSchema = z.object({
  content: z.string(),
});
export type ReadFileResponse = z.infer<typeof ReadFileResponseSchema>;

// =============================================================================
// writeFile - Write file content
// =============================================================================

export const WriteFileRequestSchema = z.object({
  path: AbsolutePathSchema,
  machineId: z.string().optional(),
  content: z.string(),
  encoding: z.string().optional().default('utf-8'),
});
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

export const WriteFileResponseSchema = z.object({
  success: z.boolean(),
});
export type WriteFileResponse = z.infer<typeof WriteFileResponseSchema>;

// =============================================================================
// Glob Schemas - Pattern-based file search
// =============================================================================

/**
 * Glob match entry.
 */

export const GlobEntrySchema = z.object({
  /** Full absolute path */
  path: z.string(),
  /** Path relative to cwd */
  relativePath: z.string(),
  /** Entry type */
  type: z.enum(['file', 'directory']),
  /** File size in bytes (files only) */
  size: z.number().optional(),
});
export type GlobEntry = z.infer<typeof GlobEntrySchema>;

/**
 * Glob request - pattern-based file search.
 */
export const GlobRequestSchema = z.object({
  /** Glob pattern (e.g., "**\/*.ts", "src/**\/*") */
  pattern: z.string(),
  /** Working directory - REQUIRED to scope search */
  cwd: z.string(),
  /** Maximum results (default: 100 in handler) */
  limit: z.number().int().min(1).optional(),
  /** Number of matches to skip before returning results. */
  offset: z.number().int().min(0).optional(),
  /** Patterns to ignore (e.g., ['node_modules/**']) */
  ignore: z.array(z.string()).optional(),
  /** Target filesystem machine (optional - if omitted, first handler responds) */
  machineId: z.string().optional(),
});
export type GlobRequest = z.infer<typeof GlobRequestSchema>;

/**
 * Glob response.
 */
export const GlobResponseSchema = z.object({
  /** Matched files */
  files: z.array(GlobEntrySchema),
  /** Whether results were truncated due to limit */
  truncated: z.boolean(),
  /** Total number of matches before limit/offset applied. */
  total: z.number().int().min(0),
});
export type GlobResponse = z.infer<typeof GlobResponseSchema>;
