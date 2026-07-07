/**
 * OpenCode log importer for importing external session logs into Makaio.
 *
 * Emits to AgentSubjects.* for uniform downstream processing.
 * Format: Separate JSON files for sessions, messages, and parts.
 *
 * OpenCode stores logs in ~/.local/share/opencode/:
 * - Session metadata: `{project|global}/storage/session/{uuid}/session.json`
 * - Message metadata: `{project|global}/storage/message/{sessionId}/{messageId}.json`
 * - Message parts: `{project|global}/storage/part/{messageId}/{partId}.json`
 *
 * Storage path verified against actual OpenCode v1.1.x (2026-01-22).
 * @packageDocumentation
 */

/* eslint max-lines: ["error", { "max": 575 }] */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { z } from 'zod';
import type {
  LogImporter,
  LogImportSessionContext,
  NormalizedEvent,
  ImportMetadata,
  DiscoveryMetadata,
  ProcessLogFileResult,
} from '@makaio/ai-adapters-core';
import { TurnTracker } from '@makaio/ai-adapters-core';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import type { JsonObject } from 'type-fest';
import { createUserMessageEvent, createAssistantMessageEvents, buildMessagePayload } from './message-normalizer.js';
import {
  hasJsonFiles,
  isMissingDirectoryError,
  listJsonFileNames,
  type OpenCodeStorageSubDir,
} from './storage-files.js';
import {
  OpenCodeSessionSchema,
  OpenCodeMessageSchema,
  OpenCodePartSchema,
  type OpenCodeMessage,
  type OpenCodePart,
  type OpenCodeSessionLog,
  type OpenCodeLogImporterConfig,
  type OpenCodeImportState,
} from './types.js';

/** Zod schema for a single session entry within the serialized turn tracker state. */
const TurnTrackerSessionEntrySchema = z.object({
  state: z.enum(['idle', 'active']),
  currentTurnId: z.string().optional(),
});

/**
 * Zod schema for the serialized OpenCode import state stored in cursor.
 * Provides safe parsing with defaults instead of nested typeof/Array.isArray guards.
 */
const SerializedImportStateSchema = z.object({
  lastProcessedIndex: z.number().default(0),
  lastUserMessageId: z.string().optional(),
  turnTrackerState: z
    .object({ sessions: z.record(z.string(), TurnTrackerSessionEntrySchema) })
    .default({ sessions: {} }),
});

export { type OpenCodeSessionLog, type OpenCodeLogImporterConfig, type OpenCodeImportState } from './types.js';

/**
 * Log importer for OpenCode session logs.
 *
 * Converts OpenCode session JSON to normalized Makaio events,
 * emitting to the same AgentSubjects.* as the live path.
 *
 * Note: OpenCode uses separate files for sessions/messages/parts,
 * so this implementation aggregates them before processing.
 */
export class OpenCodeLogImporter implements LogImporter<OpenCodeSessionLog, OpenCodeImportState> {
  private readonly adapterId: string;
  private readonly adapterName: string;
  private readonly checkMakaioManaged?: (sessionId: string) => Promise<boolean>;

  /**
   * Turn tracker for detecting turn boundaries.
   * Initialized lazily per session via createTurnTracker().
   */
  private turnTracker: TurnTracker<OpenCodeMessage> | null = null;

  public constructor(config: OpenCodeLogImporterConfig) {
    this.adapterId = config.adapterId;
    this.adapterName = config.adapterName;
    this.checkMakaioManaged = config.checkMakaioManaged;
  }

  /**
   * Check if this importer can handle the given log sample.
   * @param sample - Sample log content (JSON string or parsed object)
   * @returns True if this appears to be an OpenCode session log
   */
  public canHandle(sample: string | JsonObject): boolean {
    let record: Record<string, unknown>;
    try {
      record = typeof sample === 'string' ? (JSON.parse(sample) as Record<string, unknown>) : sample;
    } catch {
      return false;
    }

    // Type guard: Verify record is a non-null object before using 'in' operator
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return false;
    }

    // OpenCode session logs have distinctive fields: id, slug, version, projectID, directory
    return (
      'id' in record &&
      'slug' in record &&
      'version' in record &&
      'projectID' in record &&
      'directory' in record &&
      'time' in record
    );
  }

  /**
   * Get the root directory containing OpenCode log files.
   * All platforms use ~/.local/share/opencode/storage/ per OpenCode docs.
   * @returns Path to OpenCode storage directory
   */
  public getLogDirectory(): string {
    return join(homedir(), '.local', 'share', 'opencode', 'storage');
  }

  /**
   * Parse a session record from JSON content.
   * Messages and parts loaded lazily in processRecords().
   * @param content - Raw JSON string or parsed JSON object
   * @param sourceFilePath - Optional path to the session.json file (for deriving storage root)
   * @returns Parsed session log (with empty messages/parts) or null if invalid
   */
  public parseRecord(content: string | JsonObject, sourceFilePath?: string): OpenCodeSessionLog | null {
    let raw: unknown;
    try {
      raw = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      return null;
    }

    // Parse session metadata
    const sessionResult = OpenCodeSessionSchema.safeParse(raw);
    if (!sessionResult.success) {
      return null;
    }

    // Return minimal structure - messages and parts loaded lazily in processRecords
    return {
      session: sessionResult.data,
      messages: [],
      parts: new Map(),
      sourceFilePath,
    };
  }

  /**
   * Check if a session is managed by Makaio.
   * @param sessionId - The OpenCode session ID to check
   * @returns True if session is managed by Makaio, false otherwise
   */
  public async isMakaioManaged(sessionId: string): Promise<boolean> {
    if (this.checkMakaioManaged) {
      return this.checkMakaioManaged(sessionId);
    }
    // No callback provided - assume not managed (allow import)
    return false;
  }

  /**
   * Extract lightweight discovery metadata from an OpenCode session.json file.
   *
   * Reads the session.json file directly (single JSON object, not JSONL) and
   * extracts the fields needed for discovery without loading messages or parts.
   * Model is always null for OpenCode — it lives in individual message files.
   * @param filePath - Absolute path to the session.json file
   * @returns Discovery metadata with session ID, model, cwd, and title
   */
  public async extractDiscoveryMetadata(filePath: string): Promise<DiscoveryMetadata> {
    let raw: unknown;
    try {
      const content = await readFile(filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch {
      throw new Error(`Failed to read or parse session file: ${filePath}`);
    }

    const result = OpenCodeSessionSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid OpenCode session.json at: ${filePath}`);
    }

    const session = result.data;
    const adapterSessionId = session.id;
    const cwd = session.directory;
    const rawTitle = session.title.trim();
    const title = rawTitle.length > 0 ? rawTitle.slice(0, 200) : adapterSessionId;

    let hasMessages = false;
    try {
      hasMessages = await hasJsonFiles(this.deriveStorageRoot(filePath), 'message', adapterSessionId);
    } catch (error) {
      if (!isMissingDirectoryError(error)) {
        throw error;
      }
    }

    return {
      adapterSessionId,
      model: null,
      cwd,
      title,
      hasMessages,
      startedAt: session.time.created,
    };
  }

  /**
   * Extract session context from records (called on first read only).
   * @param records - Parsed OpenCode session logs (typically one)
   * @returns Session context with events and initial state
   */
  public extractSessionContext(records: OpenCodeSessionLog[]): LogImportSessionContext<OpenCodeImportState> {
    const sessionLog = records[0];
    if (!sessionLog) {
      throw new Error('No session record found in records array');
    }

    const { session } = sessionLog;
    const adapterSessionId = session.id;
    const cwd = session.directory;
    const model = null; // Model info is in individual messages, not session
    const sessionStartedAt = session.time.created;

    const importMetadata: ImportMetadata = {
      source: 'external',
      tool: 'plugin:opencode',
      streaming: false,
      originalTimestamp: new Date(session.time.created).toISOString(),
    };

    // Session discovered event
    const sessionEvent: NormalizedEvent = {
      subject: AdapterSubjects.session.discovered,
      payload: {
        adapterId: this.adapterId,
        adapterName: this.adapterName,
        adapterSessionId,
        parentAdapterSessionId: null,
        kind: 'root' as const,
        forkPointMessageId: null,
        projectHash: session.projectID,
        model,
        startedAt: sessionStartedAt,
      },
    };

    // Agent started event
    const startedEvent: NormalizedEvent = {
      subject: AgentSubjects.started,
      payload: {
        adapterId: this.adapterId,
        adapterName: this.adapterName,
        agentId: 'main',
        adapterSessionId,
        model,
        cwd,
        startMode: 'fresh' as const,
        _import: importMetadata,
      },
    };

    // Initialize turn tracker and serialize its state
    this.turnTracker = this.createTurnTracker(adapterSessionId);
    this.turnTracker.resetAll();

    return {
      adapterSessionId,
      model,
      cwd,
      sessionEvent,
      startedEvent,
      state: {
        lastProcessedIndex: 0,
        lastUserMessageId: undefined,
        turnTrackerState: this.turnTracker.serialize(),
      },
    };
  }

  /**
   * Process records into events (context always provided).
   * @param records - Parsed OpenCode session logs (typically one)
   * @param context - Session context (from extractSessionContext or restored)
   * @returns Array of normalized events (NOT including session/started events)
   */
  public processRecords(
    records: OpenCodeSessionLog[],
    context: LogImportSessionContext<OpenCodeImportState>,
  ): NormalizedEvent[] {
    const sessionLog = records[0];
    if (!sessionLog) {
      return [];
    }

    const { session } = sessionLog;

    // Load all messages from disk if not already loaded
    if (sessionLog.messages.length === 0) {
      sessionLog.messages = this.loadMessages(session.id, sessionLog);
    }

    // Restore turn tracker from state
    this.turnTracker = this.createTurnTracker(context.adapterSessionId);
    this.turnTracker.restore(context.state.turnTrackerState);

    const importMetadata: ImportMetadata = {
      source: 'external',
      tool: 'plugin:opencode',
      streaming: false,
      originalTimestamp: new Date(session.time.created).toISOString(),
    };

    const messageEvents: NormalizedEvent[] = [];
    let lastUserMessageId = context.state.lastUserMessageId;

    // Process only new messages (skip already-processed on incremental reads)
    const startIndex = context.state.lastProcessedIndex;
    for (let i = startIndex; i < sessionLog.messages.length; i++) {
      const message = sessionLog.messages[i];
      const parts = this.loadParts(message.id, sessionLog);
      const timestamp = new Date(message.time.created).toISOString();

      // Capture turn ID before and after processing to handle both roles:
      // - User messages start a new turn → use post-process ID (new turn).
      // - Assistant messages complete the turn → use pre-process ID (active turn).
      const preProcessTurnId = this.turnTracker.getCurrentTurnId(context.adapterSessionId);
      this.turnTracker.processRecord(message);
      const currentTurnId =
        message.role === 'assistant' ? preProcessTurnId : this.turnTracker.getCurrentTurnId(context.adapterSessionId);

      const normCtx = {
        adapterId: this.adapterId,
        adapterName: this.adapterName,
        adapterSessionId: context.adapterSessionId,
        timestamp,
        importMetadata,
      };

      if (message.role === 'user') {
        const event = createUserMessageEvent(message, parts, normCtx);
        messageEvents.push(event);
        lastUserMessageId = message.id;
      } else if (message.role === 'assistant') {
        const events = createAssistantMessageEvents(message, parts, normCtx, currentTurnId);
        messageEvents.push(...events);
      }
    }

    // Update context state for next chunk
    context.state.lastProcessedIndex = sessionLog.messages.length;
    context.state.lastUserMessageId = lastUserMessageId;
    context.state.turnTrackerState = this.turnTracker.serialize();

    return messageEvents;
  }

  /**
   * Process a complete log file in a single call.
   *
   * Composes extractSessionContext + processRecords + message payload extraction.
   * OpenCode uses a single session record per file, so records is typically a
   * one-element array.
   *
   * Messages and parts are loaded from disk during processRecords. After that
   * call, sessionLog.messages and sessionLog.parts are reused directly for
   * storage-ready payload extraction.
   * @param records - Single session log or array of session logs
   * @returns Combined session metadata, events, and message payloads
   */
  public processLogFile(records: OpenCodeSessionLog | OpenCodeSessionLog[]): ProcessLogFileResult {
    const input = Array.isArray(records) ? records : [records];
    if (input.length === 0) {
      throw new Error('No session record provided to processLogFile');
    }
    if (input.length > 1) {
      throw new Error(`OpenCodeLogImporter.processLogFile expects exactly 1 session record, received ${input.length}`);
    }
    const context = this.extractSessionContext(input);
    const messageEvents = this.processRecords(input, context);

    // After processRecords, sessionLog.messages is fully loaded from disk.
    const sessionLog = input[0];
    const messagePayloads = sessionLog
      ? sessionLog.messages.map((message) => {
          const parts = sessionLog.parts.get(message.id) ?? this.loadParts(message.id, sessionLog);
          return buildMessagePayload(message, parts, context.adapterSessionId);
        })
      : [];

    return {
      adapterSessionId: context.adapterSessionId,
      sessionEvent: context.sessionEvent,
      messageEvents: [context.startedEvent, ...messageEvents],
      messagePayloads,
      lineage: { kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null },
    };
  }

  /**
   * Serialize adapter state for cursor persistence.
   * @param state - OpenCode import state to serialize
   * @returns JSON-serializable representation of the state
   */
  public serializeState(state: OpenCodeImportState): JsonObject {
    const result: JsonObject = {
      lastProcessedIndex: state.lastProcessedIndex,
      turnTrackerState: { sessions: state.turnTrackerState.sessions },
    };
    if (state.lastUserMessageId !== undefined) {
      result.lastUserMessageId = state.lastUserMessageId;
    }
    return result;
  }

  /**
   * Restore adapter state from cursor.
   * @param raw - Serialized state from cursor storage
   * @returns Restored OpenCode import state
   */
  public deserializeState(raw: JsonObject): OpenCodeImportState {
    const parsed = SerializedImportStateSchema.safeParse(raw);
    if (parsed.success) {
      return {
        lastProcessedIndex: parsed.data.lastProcessedIndex,
        lastUserMessageId: parsed.data.lastUserMessageId,
        turnTrackerState: {
          sessions: parsed.data.turnTrackerState.sessions,
        },
      };
    }
    // Fallback for completely invalid data
    return {
      lastProcessedIndex: 0,
      lastUserMessageId: undefined,
      turnTrackerState: { sessions: {} },
    };
  }

  /**
   * Create a turn tracker for a session.
   * @param adapterSessionId - Session ID for the tracker
   * @returns Configured TurnTracker instance
   */
  private createTurnTracker(adapterSessionId: string): TurnTracker<OpenCodeMessage> {
    return new TurnTracker<OpenCodeMessage>({
      detectTurnStart: (m) => m.role === 'user',
      detectTurnComplete: (m) => m.role === 'assistant',
      getSessionId: () => adapterSessionId,
    });
  }

  /**
   * Derive storage root from session.json file path.
   *
   * Given: ~/.local/share/opencode/project/\{slug\}/storage/session/\{uuid\}/session.json
   * Returns: ~/.local/share/opencode/project/\{slug\}/storage
   *
   * Given: ~/.local/share/opencode/global/storage/session/\{uuid\}/session.json
   * Returns: ~/.local/share/opencode/global/storage
   * @param sessionFilePath - Full path to session.json file
   * @returns Storage root directory path
   */
  private deriveStorageRoot(sessionFilePath: string): string {
    // Path structure: .../storage/session/{uuid}/session.json
    // We want to go up to the 'storage' directory
    // Normalize path to handle both Unix and Windows separators
    const normalized = normalize(sessionFilePath);
    const parts = normalized.split(sep);
    const storageIndex = parts.lastIndexOf('storage');
    if (storageIndex === -1) {
      // Fallback to old behavior if path doesn't match expected structure
      return this.getLogDirectory();
    }
    return parts.slice(0, storageIndex + 1).join(sep);
  }

  /**
   * Load and parse JSON records from a storage subdirectory.
   * @param sessionLog - Session log containing source file path
   * @param subDir - Storage subdirectory (`message` or `part`)
   * @param id - Session ID for `message` or message ID for `part`
   * @param schema - Zod schema used to validate each JSON file
   * @returns Parsed records that passed schema validation
   */
  private loadJsonFiles<T>(
    sessionLog: OpenCodeSessionLog,
    subDir: OpenCodeStorageSubDir,
    id: string,
    schema: z.ZodType<T>,
  ): T[] {
    const storageRoot = sessionLog.sourceFilePath
      ? this.deriveStorageRoot(sessionLog.sourceFilePath)
      : this.getLogDirectory();
    const targetDir = join(storageRoot, subDir, id);

    let files: string[];
    try {
      files = listJsonFileNames(storageRoot, subDir, id);
    } catch {
      // Directory does not exist or is inaccessible — treat as empty.
      return [];
    }

    const items: T[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(targetDir, file), 'utf-8');
        const parsed = JSON.parse(content);
        const result = schema.safeParse(parsed);
        if (result.success) {
          items.push(result.data);
        }
      } catch (error) {
        // SyntaxError from JSON.parse is expected for corrupt files — skip silently.
        // Other errors (ENOENT race, EACCES) indicate unexpected I/O issues.
        if (!(error instanceof SyntaxError)) {
          console.warn(
            `[opencode-importer] Unexpected error reading ${file}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return items;
  }

  /**
   * Load all message files for a session from disk.
   * @param sessionId - The OpenCode session ID
   * @param sessionLog - Session log containing source file path
   * @returns Array of parsed messages, sorted by creation time
   */
  private loadMessages(sessionId: string, sessionLog: OpenCodeSessionLog): OpenCodeMessage[] {
    const messages = this.loadJsonFiles(sessionLog, 'message', sessionId, OpenCodeMessageSchema);

    // Sort by creation time
    return messages.sort((a, b) => a.time.created - b.time.created);
  }

  /**
   * Load all part files for a message from disk.
   * @param messageId - The OpenCode message ID
   * @param sessionLog - Session log containing source file path
   * @returns Array of parsed parts, sorted by part ID
   */
  private loadParts(messageId: string, sessionLog: OpenCodeSessionLog): OpenCodePart[] {
    const cached = sessionLog.parts.get(messageId);
    if (cached) return cached;
    const parts = this.loadJsonFiles(sessionLog, 'part', messageId, OpenCodePartSchema);
    const sortedParts = parts.sort((a, b) => a.id.localeCompare(b.id));
    sessionLog.parts.set(messageId, sortedParts);
    return sortedParts;
  }
}
