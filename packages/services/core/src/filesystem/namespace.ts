import type { SchemaRecord } from '@makaio/core';
import { MakaioBus } from '@makaio/bus-core';
import {
  // File watcher schemas
  FsChangedSchema,
  FsBatchSchema,
  FsWatchRequestSchema,
  FsWatchResponseSchema,
  FsUnwatchRequestSchema,
  FsUnwatchResponseSchema,
  // Directory browsing schemas
  ListSourcesRequestSchema,
  ListSourcesResponseSchema,
  ListDirectoryRequestSchema,
  ListDirectoryResponseSchema,
  GetHomeDirRequestSchema,
  GetHomeDirResponseSchema,
  // Glob schemas
  GlobRequestSchema,
  GlobResponseSchema,
  // File IO schemas
  ReadFileRequestSchema,
  ReadFileResponseSchema,
  WriteFileRequestSchema,
  WriteFileResponseSchema,
} from './schemas.js';

/**
 * Unified filesystem namespace schemas.
 *
 * File Watcher Subjects:
 * - changed: Single file change event
 * - batch: Batch of file changes (debounced)
 * - watch: Register file watch (RPC)
 * - unwatch: Unregister file watch (RPC)
 *
 * Directory Browser Subjects:
 * - listSources: Discover available filesystem nodes (fan-out broadcast)
 * - listDirectory: Browse directory contents
 * - getHomeDir: Get home directory path for a node
 *
 * Glob Subjects:
 * - glob: Pattern-based file search (RPC)
 */
const FsSchemas = {
  // File watcher events
  changed: FsChangedSchema,
  batch: FsBatchSchema,
  // File watcher requests
  watch: {
    request: FsWatchRequestSchema,
    response: FsWatchResponseSchema,
  },
  unwatch: {
    request: FsUnwatchRequestSchema,
    response: FsUnwatchResponseSchema,
  },
  // Directory browser requests
  listSources: {
    request: ListSourcesRequestSchema,
    response: ListSourcesResponseSchema,
  },
  listDirectory: {
    request: ListDirectoryRequestSchema,
    response: ListDirectoryResponseSchema,
  },
  getHomeDir: {
    request: GetHomeDirRequestSchema,
    response: GetHomeDirResponseSchema,
  },
  // Glob requests
  glob: {
    request: GlobRequestSchema,
    response: GlobResponseSchema,
  },
  readFile: {
    request: ReadFileRequestSchema,
    response: ReadFileResponseSchema,
  },
  writeFile: {
    request: WriteFileRequestSchema,
    response: WriteFileResponseSchema,
  },
} satisfies SchemaRecord;

/**
 * Unified filesystem namespace registration.
 */
export const FsNamespace = MakaioBus.registerNamespace('fs', FsSchemas);

/**
 * Typed subjects for filesystem operations.
 * Use FsSubjects for file watcher operations (changed, batch, watch, unwatch).
 * Use FileSystemSubjects for directory browser operations (listSources, listDirectory, getHomeDir).
 */
export const FsSubjects = FsNamespace.subjects;

/**
 * Alias for directory browser API consistency.
 */
export const FileSystemSubjects = FsSubjects;
