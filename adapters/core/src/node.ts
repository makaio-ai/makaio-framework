/**
 * Node.js-specific exports from ai-adapters-core.
 *
 * This entry point contains modules that depend on Node.js APIs (node:fs, globby)
 * and should NOT be imported in browser/client code.
 * @example
 * ```typescript
 * // Server-side only
 * import { BaseLogOrchestrator, parseJsonlFile } from '@makaio/ai-adapters-core/node';
 * ```
 * @packageDocumentation
 */

// JSONL parser for line-delimited JSON files (uses node:fs)
export {
  parseJsonlFile,
  readFirstJsonlRecords,
  someJsonlRecord,
  type JsonlParseResult,
  type JsonlParseError,
  type JsonlParserOptions,
} from './log-importer/jsonl-parser.js';

// Base orchestrator for log import (uses LogFileWatcher which depends on node:fs, globby)
export { BaseLogOrchestrator } from './log-importer/base-orchestrator.js';
export type { LogFileChangeEvent } from './log-importer/log-import-watcher.js';

// Discovery orchestrator for shallow session discovery (node-only: uses BaseLogOrchestrator)
export { DiscoveryOrchestrator } from './log-importer/discovery-orchestrator.js';
