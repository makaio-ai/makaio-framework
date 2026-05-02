/**
 * Log importer infrastructure for importing external session logs.
 *
 * This module provides the core types and interfaces for importing
 * session logs from external agentic tools (Claude Code, Codex, etc.)
 * into Makaio's event system.
 * @packageDocumentation
 */

export type {
  LogImporter,
  LogImportSessionContext,
  NormalizedEvent,
  ImportMetadata,
  ImportCursorPosition,
  ExternalToolIdentifier,
  ExternalToolIdentifiers,
  ExternalToolMeta,
  LogImporterConfig,
  StorageMessagePayload,
  LogImportTestConfig,
  DiscoveryMetadata,
  ProcessLogFileResult,
  ImportSegment,
  ImportSegmentLineage,
  CompactionMetadata,
} from './types.js';

export { toImportSegment } from './types.js';

export type {
  LogImportConfig,
  LogImportOrchestrator,
  LogImportRegistration,
  LogOrchestratorConstructor,
  LogImporterConstructor,
} from './registry-types.js';

export { BaseLogImporter } from './base-importer.js';

// Base orchestrator types (class is node-only, exported from '@makaio/ai-adapters-core/node')
export type { LogOrchestratorConfig, ParseFileResult } from './base-orchestrator.js';

// Cursor storage for tracking import progress
export {
  ImportCursorStorageNamespace,
  ImportCursorStorageSubjects,
  ImportCursorPositionSchema,
} from './cursor-storage.js';

// In-memory cursor storage handler
export { registerMemoryImportCursorStorage } from './cursor-memory-handler.js';

// NOTE: LogFileWatcher is owned by '@makaio/file-watcher'. JSONL helpers and
// orchestrator classes remain node-specific exports from
// '@makaio/ai-adapters-core/node' to avoid bundling node:fs/globby in browsers.

// Turn boundary state machine for synthesizing turn events
export {
  TurnTracker,
  TurnTrackerSerializedStateSchema,
  type TurnState,
  type TurnEvent,
  type TurnTrackerOptions,
  type TurnTrackerSerializedState,
} from './turn-tracker.js';
