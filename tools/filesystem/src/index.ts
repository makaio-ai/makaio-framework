/**
 * \@makaio/tools-filesystem
 *
 * Cross-platform filesystem tools for the Makaio Framework.
 *
 * ## Overview
 * This package provides filesystem operations as Makaio tools,
 * supporting both POSIX and Windows platforms with consistent APIs.
 *
 * ## Features
 * - Path resolution relative to context.cwd
 * - Path validation against allowed directories and compiled FileAccessRules
 * - File size constraints
 * - Cross-platform hidden file detection
 * - Cancellation support via AbortSignal
 *
 * ## File Access Rules API
 * - `FileAccessRules`: compiled rule bundle with `allowedDirectories` and `isDenied(path)`
 * - `FileAccessRuleProvider`: provider seam used by ToolRegistry/approval services
 * - `extractToolFilePath`: helper that resolves tool payloads to normalized file paths
 *
 * `.makaioignore` discovery is hierarchical (cwd to filesystem root) and merges
 * with built-in deny patterns. Rules are enforced through path validation and
 * listing filters, while explicit negation patterns (`!pattern`) are supported.
 *
 * ## Usage
 * ```typescript
 * import { ToolRegistry } from '@makaio/services-core/tools';
 * import { createMakaioContext } from '@makaio/core';
 * import { filesystemToolset } from '@makaio/tools-filesystem';
 *
 * const registry = new ToolRegistry();
 * await registry.register(filesystemToolset);
 *
 * const context = createMakaioContext({
 *   cwd: '/path/to/project',
 *   constraints: {
 *     allowedDirectories: ['/path/to/project'],
 *     maxFileSize: 10_000_000,
 *   },
 * });
 *
 * // Read a file
 * const result = await registry.execute('read_file', {
 *   path: 'package.json',
 * }, context);
 *
 * if (result.success) {
 *   console.debug(result.data.content);
 * }
 * ```
 */

export { filesystemToolset } from './toolset.js';

export { type FileAccessRules, type FileAccessRuleProvider, FILE_ACCESS_RULES_KEY } from './types.js';

export { DEFAULT_DENIED_PATTERNS, createMakaioIgnoreProvider } from './ignore/index.js';

export { extractToolFilePath } from './tool-path-extractor.js';
