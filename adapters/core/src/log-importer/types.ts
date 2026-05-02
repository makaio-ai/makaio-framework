/* eslint max-lines: ["error", { "max": 560 }] */
import type { SubjectDefinition } from '@makaio/core';
import type { SessionLineageKind, SessionMessageBlock, SessionMetadata } from '@makaio/contracts';
import type { JsonObject } from 'type-fest';

/**
 * Normalized event produced by log importers.
 *
 * Represents a single event extracted from an external tool's log file,
 * normalized to Makaio's subject/payload format for emission to the bus.
 * @remarks
 * Events may include optional {@link ImportMetadata} to distinguish
 * imported events from live events and preserve original timestamps.
 * @see {@link LogImporter} - Interface that produces these events
 * @see {@link ImportMetadata} - Provenance metadata for imported events
 */
export interface NormalizedEvent {
  /** The Makaio subject definition for this event */
  subject: SubjectDefinition;

  /** Event payload matching the subject's schema, may include _import metadata */
  payload: Record<string, unknown>;
}

/**
 * Base interface for adapter name identifiers used in log import provenance.
 *
 * Extended via declaration merging by adapters and extensions to register
 * new adapter names for log import provenance.
 * @remarks
 * Adapters and extensions extend this interface to add their adapter names:
 * ```typescript
 * declare module '@makaio/ai-adapters-core' {
 *   interface ExternalToolIdentifiers {
 *     'claude-code-cli': ExternalToolMeta;
 *     'my-custom-adapter': ExternalToolMeta;
 *   }
 * }
 * ```
 * @see {@link ExternalToolMeta} - Metadata interface for adapter identifiers
 * @see {@link ExternalToolIdentifier} - Type alias for registered adapter names
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Intentional seam for owner-package declaration merging
export interface ExternalToolIdentifiers {
  // Base interface - extended via declaration merging by owner packages.
}

/**
 * Metadata interface for external tool identifiers.
 *
 * Currently empty - provides a seam for future metadata like display names,
 * log format descriptions, or file patterns.
 * @remarks
 * Future extension might include:
 * - `displayName?: string` - Human-readable tool name
 * - `format?: 'jsonl' | 'json' | 'text'` - Expected log format
 * - `filePattern?: string` - Glob pattern for log files
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Intentional seam for future extension
export interface ExternalToolMeta {
  // Empty base - seam for future metadata
}

/**
 * Known adapter names used for log import provenance.
 *
 * Used in {@link ImportMetadata.tool} to identify the source adapter.
 * Extensible via declaration merging of {@link ExternalToolIdentifiers}.
 * Falls back to `string` when no augmentations are in scope, so the core
 * package is usable standalone while still providing autocomplete for
 * known keys when augmentations are present.
 */
export type ExternalToolIdentifier = keyof ExternalToolIdentifiers | (string & {});

/**
 * Provenance metadata for imported events.
 *
 * Added to event payloads under `_import` key to distinguish
 * imported events from live events and preserve original context.
 * @remarks
 * This metadata enables:
 * - Filtering imported vs live events in queries
 * - Accurate timeline reconstruction with original timestamps
 * - Debugging import issues by tracing back to source files
 * @see {@link NormalizedEvent} - Events containing this metadata
 */
export interface ImportMetadata {
  /** Always 'external' to indicate imported (not live) event */
  source: 'external';

  /** Adapter name that produced the original log (e.g., 'claude-code-cli') */
  tool: ExternalToolIdentifier;

  /** Original timestamp from the external tool's log record (ISO 8601) */
  originalTimestamp?: string;

  /** Always false for imported events (they are replayed, not streamed) */
  streaming: false;
}

/**
 * Cursor position for tracking import progress within a file.
 *
 * Used to resume import from the last successfully processed position
 * after restarts, avoiding duplicate event emission.
 * @remarks
 * Cursors track byte offsets rather than line numbers for efficiency
 * and to handle partial lines correctly. The lastModified timestamp
 * enables detection of file truncation/rotation.
 * @see {@link LogImporter} - Uses cursors for incremental import
 */
export interface ImportCursorPosition {
  /** Absolute path to the log file being tracked */
  filePath: string;

  /** Number of bytes successfully read and processed */
  bytesRead: number;

  /** ISO 8601 timestamp of file's last modification when cursor was saved */
  lastModified: string;

  /**
   * Session context for incremental imports (persisted on first read).
   * Contains adapter-specific state needed to resume processing mid-session.
   */
  sessionContext?: SessionMetadata & {
    /** Adapter's native session identifier */
    adapterSessionId: string;
    /** Session discovered event (emitted once at session start) */
    sessionEvent: NormalizedEvent;
    /** Agent started event (emitted once at session start) */
    startedEvent: NormalizedEvent;
    /** Serialized adapter-specific state for resumption */
    state: JsonObject;
  };
}

/**
 * Session context for incremental log imports.
 *
 * Contains adapter-specific state that must persist across chunks during
 * incremental import. Created on first read and restored from cursor on
 * subsequent reads.
 * @typeParam TState - Adapter-specific resumable state type
 * @see {@link LogImporter.extractSessionContext} - Creates this context
 * @see {@link LogImporter.processRecords} - Uses this context
 */
export interface LogImportSessionContext<TState = unknown> extends SessionMetadata {
  /** Adapter's native session identifier */
  adapterSessionId: string;

  /**
   * Session discovered event (adapter creates with adapter-specific payload).
   * Emitted once when the session is first discovered.
   */
  sessionEvent: NormalizedEvent;

  /**
   * Agent started event (adapter creates with model, cwd, etc.).
   * Emitted once when the session starts processing.
   */
  startedEvent: NormalizedEvent;

  /** Resumable import state - adapter-specific */
  state: TState;
}

/**
 * Message payload ready for persistence via MessageStorageSubjects.
 *
 * Adapters return this from {@link ProcessLogFileResult.messagePayloads}.
 * Uses {@link SessionMessageBlock} as the canonical block type.
 */
export interface StorageMessagePayload {
  /** Adapter's native message ID — used for upsert deduplication */
  adapterMessageId: string;
  /** Message role */
  role: 'user' | 'assistant';
  /** Plain text for FTS indexing */
  contentText: string;
  /** Structured content blocks */
  blocks: SessionMessageBlock[];
  /** Agent ID (defaults to 'main' for non-subagent messages) */
  agentId: string;
  /** Adapter's session ID */
  adapterSessionId: string;
  /** Unix ms timestamp */
  timestamp: number;
  /** Input modality or origin. `'compact'` = injected summary after a compaction boundary. */
  origin?: 'voice' | 'text' | 'compact';
}

/**
 * Canonical lineage metadata for an import segment.
 *
 * Every imported session segment carries explicit lineage — there is no
 * "unknown" state.  Root sessions use `kind: 'root'` with a null parent.
 */
export interface ImportSegmentLineage {
  /** Relationship of this segment to its parent. */
  kind: SessionLineageKind;
  /** Adapter session ID of the parent segment, null for root sessions. */
  parentAdapterSessionId: string | null;
  /** Message ID where this session diverged from parent (null for root, subagent, and compress). */
  forkPointMessageId: string | null;
}

/**
 * Compaction boundary metadata from the external tool's log.
 */
export interface CompactionMetadata {
  /** How compaction was triggered. */
  trigger: 'manual' | 'auto';
  /** Token count before compaction (null if unavailable). */
  preTokens: number | null;
  /** Unix ms timestamp of the compaction event (null if unavailable). */
  timestamp: number | null;
}

/**
 * Canonical import segment — the structural tree of imported session data.
 *
 * This is the single source of truth for compaction structure and lineage
 * during import.  The importer is the canonical owner of this contract.
 * @remarks
 * - Every segment carries explicit {@link ImportSegmentLineage}
 * - Children represent compaction boundaries or nested segments
 * - Use {@link toImportSegment} to convert a {@link ProcessLogFileResult}
 */
export interface ImportSegment {
  /** Adapter's native session identifier for this segment. */
  adapterSessionId: string;
  /** Explicit lineage metadata — always present, never inferred post-import. */
  lineage: ImportSegmentLineage;
  /** Storage-ready message payloads for this segment. */
  messages: StorageMessagePayload[];
  /** Compaction metadata from the boundary record (absent if not a compress child). */
  compaction?: CompactionMetadata;
  /** Child segments (compress children, nested compactions). */
  children?: ImportSegment[];
}

/**
 * Result of processing a complete log file.
 *
 * The full import pipeline result. For the structural tree without event data,
 * see {@link ImportSegment} and {@link toImportSegment}.
 * @see {@link LogImporter.processLogFile}
 */
export interface ProcessLogFileResult {
  /** Adapter session ID extracted from the log */
  adapterSessionId: string;
  /** Session discovered event (adapter.session.discovered) */
  sessionEvent: NormalizedEvent;
  /** All normalized message events including agent.started */
  messageEvents: NormalizedEvent[];
  /** Storage-ready message payloads extracted from records */
  messagePayloads: StorageMessagePayload[];
  /** Explicit lineage metadata — always present, never inferred post-import. */
  lineage: ImportSegmentLineage;
  /** Compress child results — one per compaction boundary. Absent when no compaction. */
  compressChildren?: ProcessLogFileResult[];
  /** Compaction metadata from the boundary record. */
  compactionMetadata?: CompactionMetadata;
}

/**
 * Converts a {@link ProcessLogFileResult} to a canonical {@link ImportSegment}.
 *
 * Strips bus-emission fields (sessionEvent, messageEvents) and recursively
 * converts children, producing the clean structural tree.
 * @param result - The full import result from an adapter
 * @returns A canonical import segment tree
 */
export function toImportSegment(result: ProcessLogFileResult): ImportSegment {
  const segment: ImportSegment = {
    adapterSessionId: result.adapterSessionId,
    lineage: result.lineage,
    messages: result.messagePayloads,
  };
  if (result.compactionMetadata) {
    segment.compaction = result.compactionMetadata;
  }
  if (result.compressChildren?.length) {
    segment.children = result.compressChildren.map(toImportSegment);
  }
  return segment;
}

/**
 * Lightweight metadata extracted during session discovery.
 *
 * Contains only the fields needed to populate the `adapter.session.discovered`
 * event without running the full import pipeline.
 * @see {@link LogImporter.extractDiscoveryMetadata} - Method that returns this type
 */
export interface DiscoveryMetadata {
  /** Session identifier from the external tool */
  adapterSessionId: string;
  /** Model used (null if unknown or not present in logs) */
  model: string | null;
  /** Working directory (null if not present in logs) */
  cwd: string | null;
  /** Human-readable session title (truncated to 200 chars) */
  title: string;
  /**
   * Whether the log file contains at least one importable message (user or assistant).
   * Files with only system/metadata records should set this to `false` so the
   * discovery orchestrator can skip them.
   * Optional for backward compatibility with out-of-tree importers; consumers
   * should treat `undefined` as `false`.
   */
  hasMessages?: boolean;
  /** Parent session's adapter ID (null/undefined if root session). */
  parentAdapterSessionId?: string | null;
  /** Message ID where this session diverged from parent (null/undefined if root or subagent). */
  forkPointMessageId?: string | null;
  /** Relationship to parent: root session, user fork, or subagent. Defaults to 'root' if omitted. */
  kind?: SessionLineageKind;
  /** Unix ms timestamp of when the session started in the external tool. */
  startedAt?: number;
}

/**
 * Contract for log importers (adapters and extensions).
 *
 * Importers implement this interface to import external session logs
 * into Makaio's event system. Both AI adapters (Claude Code, Codex, Gemini)
 * and extensions can provide log importers.
 * @remarks
 * The importer is responsible for:
 * - Locating log files in tool-specific directories
 * - Parsing tool-specific log formats
 * - Detecting compatible log formats via {@link canHandle}
 * - Extracting session context from initial records
 * - Processing records into normalized events with context
 * - Serializing/deserializing state for cursor persistence
 * - Detecting sessions already managed by Makaio (to skip)
 *
 * The generic `TRecord` type represents the tool's native log record format
 * (e.g., Claude Code's JSONL records with `type`, `message`, `sessionId`).
 * @typeParam TRecord - The tool's native log record type
 * @typeParam TState - The resumable state type (defaults to unknown)
 * @see {@link NormalizedEvent} - Output format for normalized events
 * @see {@link ImportMetadata} - Provenance metadata added to events
 * @see {@link ImportCursorPosition} - Cursor tracking for incremental import
 * @see {@link LogImportSessionContext} - Session context for incremental imports
 */
export interface LogImporter<TRecord, TState = unknown> {
  /**
   * Check if this importer can handle the given log sample.
   *
   * Used for auto-detection during log upload to match importers with
   * unknown log formats. Inspects a sample record/line to determine compatibility.
   * @param sample - Sample log content (JSONL line or parsed JSON object)
   * @returns Boolean or confidence score (0-1) indicating compatibility
   * @remarks
   * Simple implementations return boolean. Advanced implementations can return
   * a confidence score for disambiguation when multiple importers claim support.
   *
   * Example implementations:
   * - Claude Code: Check for `type` field in `['started', 'message', 'tool_use']`
   * - Codex: Check for `event` field matching Codex schema patterns
   * - Gemini: Check for Gemini-specific log structure
   *
   * Return `{ confidence: 0.95 }` for high confidence matches,
   * `{ confidence: 0.5 }` for ambiguous formats, or `false` for incompatible.
   */
  canHandle(sample: string | JsonObject): boolean | { confidence: number };

  /**
   * Get the root directory containing this tool's log files.
   * @returns Absolute path to the log directory (may contain subdirectories)
   * @remarks
   * Examples of log directories:
   * - Claude Code: `~/.claude/projects/` (contains `session.jsonl` files)
   * - Codex: `~/.codex/sessions/` (date-organized subdirectories)
   * - Gemini: `~/.gemini/tmp/` (hash-organized project directories)
   */
  getLogDirectory(): string;

  /**
   * Parse a single line/record from log file content.
   * @param content - Raw line content from the log file (JSONL) or full file (JSON)
   * @param sourceFilePath - Optional path to the source file (for importers that need path context)
   * @returns Parsed record or null if line is malformed/unparseable
   * @remarks
   * Implementations should be lenient - return null for malformed records
   * rather than throwing. The caller will log a warning and continue.
   *
   * The optional `sourceFilePath` parameter enables importers to store file path
   * context in records when needed (e.g., deriving storage roots from path structure).
   */
  parseRecord(content: string | JsonObject, sourceFilePath?: string): TRecord | null;

  /**
   * Check if a session is managed by Makaio (should be skipped during import).
   * @param sessionId - The external tool's session identifier
   * @returns True if Makaio manages this session, false if it should be imported
   * @remarks
   * This prevents re-importing sessions that Makaio already tracks via live
   * streaming. Implementation typically queries AdapterSessionStorage for the
   * sessionId to check if the session has status='live'.
   *
   * May be async to support database lookups.
   */
  isMakaioManaged(sessionId: string): Promise<boolean>;

  /**
   * Extract lightweight discovery metadata from a log file.
   *
   * Optimized for minimal I/O — reads only enough of the file to populate
   * the four discovery fields. Used by the DiscoveryOrchestrator to avoid
   * the full parseFile → extractSessionContext pipeline.
   * @param filePath - Absolute path to the log file
   * @returns Discovery metadata with session ID, model, cwd, and title
   */
  extractDiscoveryMetadata(filePath: string): Promise<DiscoveryMetadata>;

  /**
   * Extract session context from records (called on first read only).
   *
   * Creates the session context including session/started events and
   * initial adapter state. This is only called when no existing cursor
   * context exists (i.e., first time reading this file).
   * @param records - Initial batch of parsed records from the file
   * @returns Session context with events and initial state
   * @remarks
   * The returned context is persisted in the cursor and restored on
   * subsequent reads via {@link deserializeState}.
   */
  extractSessionContext(records: TRecord[]): LogImportSessionContext<TState>;

  /**
   * Process records into events (context always provided).
   *
   * Converts adapter-specific records to normalized Makaio events using
   * the provided session context. Updates context.state as needed for
   * stateful processing (e.g., turn tracking).
   * @param records - Batch of parsed records to process
   * @param context - Session context (from extractSessionContext or restored)
   * @returns Array of normalized events (may be empty)
   * @remarks
   * This replaces the stateless `toNormalizedEvents` method. The context
   * provides session metadata and mutable adapter state for tracking
   * things like conversation turns across chunks.
   *
   * Implementations should add {@link ImportMetadata} to payloads
   * under the `_import` key for provenance tracking.
   */
  processRecords(records: TRecord[], context: LogImportSessionContext<TState>): NormalizedEvent[];

  /**
   * Serialize adapter state for cursor persistence.
   *
   * Converts the adapter's typed state to a JSON-serializable object
   * for storage in the cursor.
   * @param state - Adapter-specific state to serialize
   * @returns JSON-serializable representation of the state
   */
  serializeState(state: TState): JsonObject;

  /**
   * Restore adapter state from cursor.
   *
   * Converts the serialized state back to the adapter's typed state
   * when resuming from a persisted cursor.
   * @param raw - Serialized state from cursor storage
   * @returns Restored adapter-specific state
   */
  deserializeState(raw: JsonObject): TState;

  /**
   * Process a complete log file in a single call.
   *
   * Composes extractSessionContext + processRecords + message extraction.
   * Adapters that need special handling (fork detection, field normalization)
   * should override this method.
   * @param records - All parsed records from the log file
   * @returns Combined session metadata, events, and message payloads
   */
  processLogFile(records: TRecord | TRecord[]): ProcessLogFileResult;
}

/**
 * Configuration for log importer constructor.
 *
 * Minimal config required to instantiate a log importer for testing.
 */
export interface LogImporterConfig {
  /** Unique identifier for the adapter instance */
  adapterId: string;
  /** Human-readable adapter name */
  adapterName: string;
  /** Optional session ownership check used by importer implementations that can skip Makaio-managed sessions. */
  checkMakaioManaged?: (sessionId: string) => Promise<boolean>;
}

/**
 * Test configuration for log import conformance tests.
 *
 * Host-owned log importer packages may use this shape to describe their
 * test fixtures and importer constructors.
 * @see {@link LogImporter} - Base interface that LogImporterClass must implement
 */
export interface LogImportTestConfig<TRecord = unknown, TState = unknown> {
  /**
   * Fixture file name for conformance tests.
   *
   * Relative to the conformance harness fixture directory.
   * @example 'codex-session.jsonl' or 'gemini-session.json'
   */
  fixtureFile: string;

  /**
   * Log importer class constructor.
   *
   * Must implement {@link LogImporter} for conformance tests.
   */
  LogImporterClass: new (config: LogImporterConfig) => LogImporter<TRecord, TState>;
}
