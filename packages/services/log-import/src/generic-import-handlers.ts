/** Generic import handlers for LogImportRegistry. @packageDocumentation */
import * as fs from 'node:fs/promises';
import type { IMakaioBus } from '@makaio/bus-core';
import type {
  LogImporter,
  ImportCursorPosition,
  StorageMessagePayload,
  ImportSegment,
  CompactionMetadata,
  ProcessLogFileResult,
} from '@makaio/ai-adapters-core';
import { ImportCursorStorageSubjects, toImportSegment } from '@makaio/ai-adapters-core';
import {
  AdapterSessionStorageSubjects,
  SessionStorageSubjects,
  MessageStorageSubjects,
} from '@makaio/services-core/session';
import {
  extractSessionMetadata,
  toSessionMetadataFromImportSegment,
  toCreateAndLinkMetadata,
  toAdapterSessionUpsertPayload,
  type SessionMetadataFromEvent,
} from './lineage-metadata.js';
import { appendSessionCompactedEvent } from './compaction-events.js';
import { parseFileContent, normalizePersistedLogFilePath } from './scan-handler.js';

export type {
  ImportFromFileContentResult,
  ImportSegmentTreeContext,
  ImportSegmentTreeResult,
  PersistImportResultContext,
} from './import-types.js';

import type {
  ImportFromFileContentResult,
  ImportSegmentTreeContext,
  ImportSegmentTreeResult,
  PersistImportResultContext,
} from './import-types.js';

// Re-export scan handler for backward compatibility
export { registerGenericScanHandler } from './scan-handler.js';
// Export for testing
export { matchesPattern } from './pattern-matching.js';

/**
 * Ensure a Makaio session exists for an adapter session.
 *
 * Routes through the bus via `AdapterSessionStorageSubjects.createAndLink` to
 * avoid a direct cross-package dependency on `@makaio/services-core/session` internals.
 * The handler handles idempotency, parent resolution, scope resolution, and cleanup.
 * @param bus - Bus instance
 * @param adapterSessionId - The adapter session ID (linked but not used as Makaio session ID)
 * @param adapterId - The adapter instance ID
 * @param adapterName - The adapter name
 * @param metadata - Session metadata extracted from the log file
 * @returns The Makaio session ID
 */
async function ensureMakaioSession(
  bus: IMakaioBus,
  adapterSessionId: string,
  adapterId: string,
  adapterName: string,
  metadata: SessionMetadataFromEvent,
): Promise<string> {
  // createAndLink is the concurrency boundary: it only returns after the
  // adapter-session link is confirmed, and it falls back to the winning linked
  // sessionId when another importer wins the race for this adapter session.
  const { sessionId } = await bus.request(AdapterSessionStorageSubjects.createAndLink, {
    adapterSessionId,
    adapterName,
    adapterId,
    metadata: toCreateAndLinkMetadata(metadata),
  });
  return sessionId;
}

/**
 * Transition an imported Makaio session from `'discovered'` to `'active'`.
 *
 * Must be called by every code path that completes a full message import so the
 * session becomes visible as a fully-populated, queryable session. The storage
 * handler is idempotent: if the session is already active the update is a no-op.
 * @param bus - Bus instance for storage requests
 * @param sessionId - Makaio session ID to activate
 */
export async function activateImportedSession(bus: IMakaioBus, sessionId: string): Promise<void> {
  await bus.request(SessionStorageSubjects.update, { sessionId, status: 'active' });
}

/**
 * Write an import cursor after a full (non-incremental) file import.
 *
 * Sets `bytesRead` to the full file size and populates `sessionContext` so
 * that subsequent watcher-driven incremental reads can resume from the end
 * of the file without re-processing already-imported records.
 *
 * Failures are swallowed — a missing cursor is recoverable (the orchestrator
 * will fall back to a full re-read), but we don't want cursor I/O errors to
 * surface to callers of {@link importFromFileContent}.
 * @param bus - Bus instance for cursor storage requests
 * @param importer - Importer used to extract session context and serialize state
 * @param records - Parsed records (already processed by the import pipeline)
 * @param filePath - Absolute path to the log file on disk
 * @param adapterName - Canonical adapter name for warning logs
 * @param adapterSessionId - Adapter session identifier for warning logs
 */
async function writeCursorAfterFullImport(
  bus: IMakaioBus,
  importer: LogImporter<unknown>,
  records: unknown[],
  filePath: string,
  adapterName: string,
  adapterSessionId: string,
): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    const context = importer.extractSessionContext(records);
    const sessionContext: NonNullable<ImportCursorPosition['sessionContext']> = {
      adapterSessionId,
      model: context.model,
      cwd: context.cwd,
      sessionEvent: context.sessionEvent,
      startedEvent: context.startedEvent,
      state: importer.serializeState(context.state),
    };
    await bus.request(ImportCursorStorageSubjects.set, {
      filePath,
      bytesRead: stat.size,
      lastModified: stat.mtime.toISOString(),
      sessionContext,
    });
  } catch (error) {
    // Cursor write failures are non-fatal — the next watcher cycle will
    // re-read from scratch and rebuild the cursor via the normal first-read path.
    console.warn('[importFromFileContent] Failed to persist import cursor', {
      adapterName,
      adapterSessionId,
      filePath,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

/**
 * Emit a `session.compacted` plugin event on the parent session.
 *
 * Persists the event to `session_events` so that extensions and the UI can react
 * to compaction. The summary is extracted from the first message in the compress
 * child that was marked `origin: 'compact'` (the `isCompactSummary` user message).
 *
 * This uses the plugin event path (`PluginSessionEventSchema`) — no core event
 * schema change is needed.
 * @param bus - Bus instance for storage requests
 * @param parentSessionId - Makaio session ID of the pre-compaction parent session
 * @param compressChildSessionId - Makaio session ID of the compress child session
 * @param compactionMetadata - Trigger and pre-compaction token count from the boundary record
 * @param childMessagePayloads - Message payloads from the compress child (for summary extraction)
 */
async function emitCompactionEvent(
  bus: IMakaioBus,
  parentSessionId: string,
  compressChildSessionId: string,
  compactionMetadata: CompactionMetadata,
  childMessagePayloads: StorageMessagePayload[],
): Promise<void> {
  const summaryPayload = childMessagePayloads.find((p) => p.origin === 'compact');
  const summary = summaryPayload?.contentText ?? null;
  const timestamp = compactionMetadata.timestamp ?? summaryPayload?.timestamp ?? Date.now();
  const eventId = `session-compacted:${parentSessionId}:${compressChildSessionId}`;
  await appendSessionCompactedEvent(bus, {
    sessionId: parentSessionId,
    eventId,
    timestamp,
    trigger: compactionMetadata.trigger,
    preTokens: compactionMetadata.preTokens,
    summary,
    compressChildSessionId,
  });
}

/**
 * Persist message payloads for a session via bus upserts.
 * @param bus - Bus instance
 * @param sessionId - Target Makaio session ID
 * @param messagePayloads - Payloads to persist
 */
async function storeMessages(
  bus: IMakaioBus,
  sessionId: string,
  messagePayloads: StorageMessagePayload[],
): Promise<void> {
  for (const msg of messagePayloads) {
    await bus.request(MessageStorageSubjects.upsertByAdapterMessageId, {
      sessionId,
      turnId: null,
      adapterMessageId: msg.adapterMessageId,
      role: msg.role,
      contentText: msg.contentText,
      blocks: msg.blocks,
      agentId: msg.agentId,
      adapterSessionId: msg.adapterSessionId,
      timestamp: msg.timestamp,
      ...(msg.origin !== undefined && { origin: msg.origin }),
    });
  }
}

/**
 * Recursively import a segment tree, processing children before finalizing
 * the parent (bottom-up status finalization).
 *
 * Uses {@link ImportSegment.lineage} as the canonical source of lineage truth
 * instead of parsing lineage from session events.
 *
 * Compaction events are emitted on the parent as soon as the child session is
 * linked, preserving the same event ordering as the previous per-child approach:
 * parent compaction event fires before the child's own grandchild events.
 *
 * Compress subagent parentage is resolved by tree traversal order: compress
 * parents are always persisted before their post-compaction subagents, so
 * `resolveLineage` finds the correct sessionId at link time. The
 * compress-lineage-resolver remains active for watcher-driven and legacy imports.
 *
 * ### Import lifecycle phases (see {@link ImportPhase} for full invariants)
 *
 * 1. **linked** — session link created; messages may not exist yet.
 * 2. **persisted** — messages stored; `session.compacted` emitted if applicable.
 * 3. **finalized** — full subtree persisted; statuses promoted bottom-up to
 * `'imported'` / `'active'`.
 * @remarks Canonical persistence path for explicit import segment trees. Watcher-driven
 * compaction imports also route through this helper so compaction ownership does not split.
 * @param bus - Bus instance
 * @param segment - Canonical import segment to persist
 * @param ctx - Adapter context for the import
 * @param parentSessionId - Makaio session ID of the parent segment (undefined for root)
 * @returns Makaio session ID and total message count
 */
export async function importSegmentTree(
  bus: IMakaioBus,
  segment: ImportSegment,
  ctx: ImportSegmentTreeContext,
  parentSessionId?: string,
): Promise<ImportSegmentTreeResult> {
  // Build metadata from segment lineage (canonical source — no event parsing)
  const metadata = toSessionMetadataFromImportSegment(segment, ctx.model, ctx.cwd);

  // Earliest message timestamp is the canonical startedAt; context carries adapter identity,
  // not temporal metadata. Empty segments fall back to Date.now() in the storage handler.
  const startedAt =
    segment.messages.length > 0
      ? segment.messages.reduce((min, message) => Math.min(min, message.timestamp), Infinity)
      : undefined;

  // Upsert adapter session record.
  // ctx.logFilePath: undefined = omit (no-op for log path), null = explicitly NULL (children),
  // string = parent's absolute file path.
  await bus.request(
    AdapterSessionStorageSubjects.upsert,
    toAdapterSessionUpsertPayload(metadata, ctx.adapterName, ctx.model, ctx.cwd, ctx.logFilePath, startedAt),
  );

  // Phase: ImportPhase.linked — session link established; sessionId is stable, messages not yet in storage.
  const sessionId = await ensureMakaioSession(bus, segment.adapterSessionId, ctx.adapterId, ctx.adapterName, metadata);

  // Phase: ImportPhase.persisted — store messages; parent compaction event fires before children's.
  await storeMessages(bus, sessionId, segment.messages);

  if (parentSessionId !== undefined && segment.compaction !== undefined) {
    await emitCompactionEvent(bus, parentSessionId, sessionId, segment.compaction, segment.messages);
  }

  // Recurse depth-first: each child reaches finalized before the parent does.
  let totalMessageCount = segment.messages.length;

  const childCtx = {
    adapterId: ctx.adapterId,
    adapterName: ctx.adapterName,
    model: ctx.model,
    cwd: ctx.cwd,
    // Children never own the log file — explicit null stores NULL, not omitted
    logFilePath: null,
  };

  for (const child of segment.children ?? []) {
    const childResult = await importSegmentTree(bus, child, childCtx, sessionId);
    totalMessageCount += childResult.messageCount;
  }

  // Phase: ImportPhase.finalized — all descendants persisted; promote statuses bottom-up (idempotent).
  await bus.request(AdapterSessionStorageSubjects.updateStatus, {
    adapterSessionId: segment.adapterSessionId,
    status: 'imported',
  });
  await activateImportedSession(bus, sessionId);

  return { sessionId, messageCount: totalMessageCount };
}

/**
 * Persist a processed import result via the canonical segment-tree path.
 *
 * Uses the importer's explicit lineage tree as the single source of truth for
 * session creation, message persistence, compaction events, and status finalization.
 * @param bus - Bus instance
 * @param result - Fully processed importer result for one log file
 * @param ctx - Adapter identity and optional root log file path
 * @returns Makaio session ID and total persisted message count
 */
export async function persistImportResultTree(
  bus: IMakaioBus,
  result: ProcessLogFileResult,
  ctx: PersistImportResultContext,
): Promise<ImportSegmentTreeResult> {
  const metadata = extractSessionMetadata(result.sessionEvent);
  const segmentTree = toImportSegment(result);

  return importSegmentTree(bus, segmentTree, {
    adapterId: ctx.adapterId,
    adapterName: ctx.adapterName,
    model: metadata.model,
    cwd: metadata.cwd,
    logFilePath: ctx.logFilePath,
  });
}

/**
 * Parse, extract, and store all messages from log file content.
 *
 * Core reusable import logic shared by the upload and lazy-load handlers.
 * This function marks the adapter session status as `'imported'` after subtree persistence succeeds.
 *
 * When the importer produces `compressChildren` (from compaction boundary
 * detection), each child is processed in order after the parent. Children
 * use `logFilePath: null` — only the parent session owns the file reference.
 * @param params - Import parameters
 * @returns The Makaio session ID and total message count
 * @throws Error if no valid records are found in the content
 */
export async function importFromFileContent(params: {
  bus: IMakaioBus;
  importer: LogImporter<unknown>;
  content: string;
  isJsonl: boolean;
  adapterName: string;
  adapterId: string;
  sourceFilePath?: string;
  persistedLogFilePath?: string;
}): Promise<ImportFromFileContentResult> {
  const { bus, importer, content, isJsonl, adapterName, adapterId, sourceFilePath, persistedLogFilePath } = params;
  const records = parseFileContent(content, importer, isJsonl, sourceFilePath);

  if (records.length === 0) {
    throw new Error('No valid records found');
  }

  // Process the full log file via the importer's unified pipeline
  const result = importer.processLogFile(records);
  // metadata from sessionEvent is still needed for model/cwd (segment tree context)
  // and to normalize the persisted log file path using metadata.cwd
  const metadata = extractSessionMetadata(result.sessionEvent);
  const normalizedPersistedLogFilePath = normalizePersistedLogFilePath(
    persistedLogFilePath,
    sourceFilePath,
    metadata.cwd,
  );

  const { sessionId: effectiveSessionId, messageCount: totalMessageCount } = await persistImportResultTree(
    bus,
    result,
    {
      adapterId,
      adapterName,
      logFilePath: normalizedPersistedLogFilePath,
    },
  );

  // Only disk-backed imports should persist resumable cursor state and a durable log path.
  if (normalizedPersistedLogFilePath !== undefined) {
    await writeCursorAfterFullImport(
      bus,
      importer,
      records,
      normalizedPersistedLogFilePath,
      adapterName,
      result.adapterSessionId,
    );
  }

  return { sessionId: effectiveSessionId, messageCount: totalMessageCount };
}
