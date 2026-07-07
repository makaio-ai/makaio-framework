/** Generic import handlers for LogImportRegistry. @packageDocumentation */
import * as fs from 'node:fs/promises';
import type { IMakaioBus } from '@makaio/bus-core';
import type {
  LogImporter,
  ImportCursorPosition,
  StorageMessagePayload,
  ImportSegment,
  ImportSegmentTurn,
  CompactionMetadata,
  ProcessLogFileResult,
} from '@makaio/ai-adapters-core';
import { ImportCursorStorageSubjects, toImportSegment } from '@makaio/ai-adapters-core';
import type { TurnIngestionMarker } from '@makaio/contracts';
import {
  SessionStorageSubjects,
  MessageStorageSubjects,
  ingestCompletedTurn,
  isPolicyDiscoveredObservedSession,
  type IngestTurnMessage,
} from '@makaio/services-core/session';
import {
  extractSessionMetadata,
  toSessionMetadataFromImportSegment,
  toImportUpsertPayload,
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
 * Write an import cursor after a full (non-incremental) file import.
 *
 * Sets `bytesRead` to the byte length of the content snapshot that was
 * actually parsed and populates `sessionContext` so that subsequent
 * watcher-driven incremental reads can resume from the end of the parsed
 * content without re-processing already-imported records.
 *
 * The cursor must never claim knowledge of bytes it did not parse: the file
 * can grow between the caller's `readFile` and this write, so `bytesRead`
 * derives from the snapshot, not from a fresh `stat` size. The same applies
 * to `lastModified` — when the stat'd size no longer matches the snapshot,
 * the file changed after the read and the current mtime describes unparsed
 * bytes, so the epoch sentinel is stored instead (it can never satisfy the
 * orchestrator's `lastModified >= mtime` skip check).
 *
 * Failures are swallowed — a missing cursor is recoverable (the orchestrator
 * will fall back to a full re-read), but we don't want cursor I/O errors to
 * surface to callers of {@link importFromFileContent}.
 * @param bus - Bus instance for cursor storage requests
 * @param importer - Importer used to extract session context and serialize state
 * @param records - Parsed records from the full-import snapshot
 * @param contentByteLength - UTF-8 byte length of the parsed content snapshot
 * @param filePath - Absolute path to the log file on disk
 * @param adapterName - Canonical adapter name for warning logs
 * @param adapterSessionId - Adapter session identifier for warning logs
 */
async function writeCursorAfterFullImport(
  bus: IMakaioBus,
  importer: LogImporter<unknown>,
  records: unknown[],
  contentByteLength: number,
  filePath: string,
  adapterName: string,
  adapterSessionId: string,
): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    const snapshotIsCurrent = stat.size === contentByteLength;
    const context = importer.extractSessionContext(records);
    // Cursor resume state must represent the same parsed snapshot that was
    // just imported. `extractSessionContext()` only creates initial state;
    // `processRecords()` advances that state through turn/tool tracking.
    importer.processRecords(records, context);
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
      bytesRead: contentByteLength,
      lastModified: snapshotIsCurrent ? stat.mtime.toISOString() : new Date(0).toISOString(),
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
 * Persist message payloads for a session via bus upserts with `turnId: null`.
 *
 * Used for the legacy path (importers that do not yet produce
 * {@link ImportSegment.turns}) and for the remainder of a turn-aware segment:
 * messages not referenced by any reconstructed turn (system records, orphans).
 * Turn-member messages are persisted with their real `turnId` by the turn
 * ingestion seam instead — see {@link ingestSegmentTurns}.
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
 * Convert a storage message payload into a turn ingestion message.
 * @param payload - Storage-ready message payload from the importer
 * @returns Message shaped for {@link ingestCompletedTurn}
 */
function toIngestTurnMessage(payload: StorageMessagePayload): IngestTurnMessage {
  return {
    adapterMessageId: payload.adapterMessageId,
    role: payload.role,
    contentText: payload.contentText,
    blocks: payload.blocks,
    agentId: payload.agentId,
    adapterSessionId: payload.adapterSessionId,
    timestamp: payload.timestamp,
    ...(payload.origin !== undefined && { origin: payload.origin }),
  };
}

/**
 * Route a segment's reconstructed turns through the turn ingestion seam.
 *
 * For each turn (in transcript order) the member message payloads are resolved
 * from the segment's message set and handed to {@link ingestCompletedTurn},
 * which persists the turn row plus its messages (real `turnId` links) and —
 * only on first ingestion of the anchor — emits `session.turn.started` /
 * `session.turn.completed`. Member IDs missing from the segment are logged
 * and skipped so one malformed turn cannot abort the whole import.
 * @param bus - Bus instance
 * @param sessionId - Makaio session ID of the segment's session
 * @param segment - Segment whose turns are ingested (`turns` must be present)
 * @param turns - Reconstructed turns of the segment, in transcript order
 * @param ingestionMarker - Marker stamped on emitted `session.turn.*` events
 * @returns Set of adapterMessageIds persisted via the seam, and the number of
 *   NEWLY created turns (re-ingested anchors do not count)
 */
async function ingestSegmentTurns(
  bus: IMakaioBus,
  sessionId: string,
  segment: ImportSegment,
  turns: readonly ImportSegmentTurn[],
  ingestionMarker: TurnIngestionMarker,
): Promise<{ turnMemberIds: Set<string>; createdTurnCount: number }> {
  const payloadsByAdapterMessageId = new Map<string, StorageMessagePayload>(
    segment.messages.map((message) => [message.adapterMessageId, message]),
  );

  const turnMemberIds = new Set<string>();
  let createdTurnCount = 0;

  for (const [turnIndex, turn] of turns.entries()) {
    const members: IngestTurnMessage[] = [];
    const resolvedMemberIds = new Set<string>();
    for (const adapterMessageId of turn.adapterMessageIds) {
      const payload = payloadsByAdapterMessageId.get(adapterMessageId);
      if (payload === undefined) {
        console.warn(
          `[importSegmentTree] Turn ${turnIndex + 1}/${turns.length} references an unknown member; skipping it`,
        );
        continue;
      }
      resolvedMemberIds.add(adapterMessageId);
      members.push(toIngestTurnMessage(payload));
    }

    if (!resolvedMemberIds.has(turn.turnAnchorId)) {
      console.warn(`[importSegmentTree] Turn ${turnIndex + 1}/${turns.length} is missing its anchor; skipping turn`);
      continue;
    }

    const result = await ingestCompletedTurn(bus, {
      sessionId,
      turnAnchorId: turn.turnAnchorId,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      status: turn.status ?? 'completed',
      ingestionMarker,
      messages: members,
    });

    // Count NEW turns only: re-parses of the same file (e.g. compaction forces
    // a re-read from byte 0) match existing anchors and must not inflate counts.
    if (result.created) {
      createdTurnCount += 1;
    }
    for (const adapterMessageId of resolvedMemberIds) {
      turnMemberIds.add(adapterMessageId);
    }
  }

  return { turnMemberIds, createdTurnCount };
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
 *
 * ### Ordering invariant (single emitter)
 *
 * This function never emits `session.turn.*` itself. Reconstructed turns are
 * handed to the turn ingestion seam ({@link ingestCompletedTurn}), which emits
 * those events only AFTER the turn row and its messages are queryable — and
 * only on first ingestion of a turn anchor, so re-parses re-emit nothing.
 * `session.compacted` emission ({@link emitCompactionEvent}) keeps its
 * position directly after the segment's messages are persisted.
 * @remarks Canonical persistence path for explicit import segment trees. Watcher-driven
 * compaction imports also route through this helper so compaction ownership does not split.
 * @param bus - Bus instance
 * @param segment - Canonical import segment to persist
 * @param ctx - Adapter context for the import
 * @param parentSessionId - Makaio session ID of the parent segment (undefined for root)
 * @returns Makaio session ID, total message count, and newly created turn count
 */
export async function importSegmentTree(
  bus: IMakaioBus,
  segment: ImportSegment,
  ctx: ImportSegmentTreeContext,
  parentSessionId?: string,
): Promise<ImportSegmentTreeResult> {
  // Default applied once, at this boundary: absent marker means historical/watcher backfill.
  const resolvedMarker: TurnIngestionMarker = ctx.ingestionMarker ?? 'backfill';

  // Build metadata from segment lineage (canonical source — no event parsing)
  const metadata = toSessionMetadataFromImportSegment(segment, ctx.model, ctx.cwd);

  // Earliest message timestamp is the canonical startedAt; context carries adapter identity,
  // not temporal metadata. Empty segments fall back to Date.now() in the storage handler.
  const startedAt =
    segment.messages.length > 0
      ? segment.messages.reduce((min, message) => Math.min(min, message.timestamp), Infinity)
      : undefined;

  // Phase: ImportPhase.linked — importUpsert atomically creates or enriches the session;
  // sessionId is stable and messages are not yet in storage.
  // ctx.logFilePath: undefined = omit (no-op for log path), null = explicitly NULL (children),
  // string = parent's absolute file path.
  const existingSession = await bus.requestOptional(SessionStorageSubjects.getByAdapterSessionId, {
    adapterSessionId: metadata.adapterSessionId,
    source: ctx.adapterName,
  });
  if (existingSession.handled && existingSession.data.session !== null) {
    const session = existingSession.data.session;
    if (isPolicyDiscoveredObservedSession(session)) {
      return { sessionId: session.sessionId, messageCount: 0, turnCount: 0 };
    }
  }

  const { sessionId } = await bus.request(
    SessionStorageSubjects.importUpsert,
    toImportUpsertPayload({
      metadata,
      source: ctx.adapterName,
      cwd: ctx.cwd,
      logFilePath: ctx.logFilePath,
      startedAt,
      adapterId: ctx.adapterId,
      // Each segment carries its own sidechain flag — children never inherit the parent's.
      isSidechain: segment.isSidechain,
      machineId: ctx.machineId,
    }),
  );

  // Phase: ImportPhase.persisted — store messages; parent compaction event fires before children's.
  // Turn-aware path: turn members go through the ingestion seam (real turnId links +
  // created-gated session.turn.* events); the remainder (system records, orphans) and
  // the legacy path (importers without turn reconstruction) persist with turnId: null.
  let turnCount = 0;
  if (segment.turns !== undefined && segment.turns.length > 0) {
    const { turnMemberIds, createdTurnCount } = await ingestSegmentTurns(
      bus,
      sessionId,
      segment,
      segment.turns,
      resolvedMarker,
    );
    turnCount += createdTurnCount;
    await storeMessages(
      bus,
      sessionId,
      segment.messages.filter((message) => !turnMemberIds.has(message.adapterMessageId)),
    );
  } else {
    await storeMessages(bus, sessionId, segment.messages);
  }

  if (parentSessionId !== undefined && segment.compaction !== undefined) {
    await emitCompactionEvent(bus, parentSessionId, sessionId, segment.compaction, segment.messages);
  }

  // Recurse depth-first: each child reaches finalized before the parent does.
  let totalMessageCount = segment.messages.length;

  const childCtx: ImportSegmentTreeContext = {
    adapterId: ctx.adapterId,
    adapterName: ctx.adapterName,
    model: ctx.model,
    cwd: ctx.cwd,
    // Children never own the log file — explicit null stores NULL, not omitted
    logFilePath: null,
    machineId: ctx.machineId,
    ingestionMarker: resolvedMarker,
  };

  for (const child of segment.children ?? []) {
    const childResult = await importSegmentTree(bus, child, childCtx, sessionId);
    totalMessageCount += childResult.messageCount;
    turnCount += childResult.turnCount;
  }

  // Phase: ImportPhase.finalized — all descendants persisted; promote import status bottom-up (idempotent).
  // updateImportStatus with 'imported' also transitions session status to 'active' in the handler.
  await bus.request(SessionStorageSubjects.updateImportStatus, {
    sessionId,
    importStatus: 'imported',
  });

  return { sessionId, messageCount: totalMessageCount, turnCount };
}

/**
 * Persist a processed import result via the canonical segment-tree path.
 *
 * Uses the importer's explicit lineage tree as the single source of truth for
 * session creation, message persistence, compaction events, and status finalization.
 * @param bus - Bus instance
 * @param result - Fully processed importer result for one log file
 * @param ctx - Adapter identity, optional root log file path, and optional ingestion marker
 * @returns Makaio session ID, total persisted message count, and newly created turn count
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
    machineId: ctx.machineId,
    ingestionMarker: ctx.ingestionMarker,
  });
}

/**
 * Parse, extract, and store all messages from log file content.
 *
 * Core reusable import logic shared by the upload and lazy-load handlers.
 * This function marks the session import status as `'imported'` after subtree persistence succeeds.
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
  /**
   * Machine identifier of the machine that owns the imported sessions.
   * Always caller-supplied; never derived here. Pass `undefined` to omit
   * (leaves stored value untouched), `null` to explicitly store NULL.
   */
  machineId?: string | null;
  /**
   * Marker stamped on `session.turn.*` events emitted for ingested turns.
   * Defaults to `'backfill'` (applied at the {@link importSegmentTree} boundary).
   */
  ingestionMarker?: TurnIngestionMarker;
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

  const {
    sessionId: effectiveSessionId,
    messageCount: totalMessageCount,
    turnCount,
  } = await persistImportResultTree(bus, result, {
    adapterId,
    adapterName,
    logFilePath: normalizedPersistedLogFilePath,
    machineId: params.machineId,
    ingestionMarker: params.ingestionMarker,
  });

  // Only disk-backed imports should persist resumable cursor state and a durable log path.
  if (normalizedPersistedLogFilePath !== undefined) {
    await writeCursorAfterFullImport(
      bus,
      importer,
      records,
      Buffer.byteLength(content, 'utf8'),
      normalizedPersistedLogFilePath,
      adapterName,
      result.adapterSessionId,
    );
  }

  return { sessionId: effectiveSessionId, messageCount: totalMessageCount, turnCount };
}
