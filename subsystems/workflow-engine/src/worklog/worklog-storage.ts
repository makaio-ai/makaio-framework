import { eq, and, desc, gte, lte, count, sum } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { WorkLogExecutionSummary, WorkLogStats, JsonValue, WorkflowArtifactBinding } from '@makaio/contracts';
import {
  worklogSummaries,
  worklogFrameEntries,
  worklogArtifactWrites,
  worklogGateEvents,
  type InsertWorklogSummary,
  type SelectWorklogSummary,
  type InsertWorklogFrameEntry,
  type SelectWorklogFrameEntry,
  type InsertWorklogArtifactWrite,
  type InsertWorklogGateEvent,
  type SelectWorklogGateEvent,
} from '../storage/schema.js';

// ─────────────────────────────────────────────────────────────
// Row → domain mappers
// ─────────────────────────────────────────────────────────────

/**
 * Map a `worklog_summaries` row to the public {@link WorkLogExecutionSummary} type.
 * @param row - Database row from `worklog_summaries`.
 * @returns Mapped summary with optional fields normalised.
 */
function mapSummary(row: SelectWorklogSummary): WorkLogExecutionSummary {
  return {
    executionId: row.executionId,
    workflowId: row.workflowId,
    workflowName: row.workflowName ?? undefined,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
    totalInputTokens: row.totalInputTokens ?? undefined,
    totalOutputTokens: row.totalOutputTokens ?? undefined,
    totalEstimatedCost: row.totalEstimatedCost ?? undefined,
    error: row.error ?? undefined,
    failedNodeId: row.failedNodeId ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Summary operations
// ─────────────────────────────────────────────────────────────

/**
 * Upsert a WorkLog execution summary row.
 *
 * Called when an `execution.started` event is received to create the initial
 * row, and again on `execution.completed`, `execution.failed`, and
 * `execution.cancelled` to update terminal status fields.
 * @param db - Drizzle database instance.
 * @param summary - The summary values to insert or update.
 */
export async function upsertWorklogSummary(db: MakaioDatabase, summary: InsertWorklogSummary): Promise<void> {
  await db.insert(worklogSummaries).values(summary).onConflictDoUpdate({
    target: worklogSummaries.executionId,
    set: summary,
  });
}

/**
 * Retrieve a single WorkLog execution summary by execution ID.
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier to look up.
 * @returns The summary, or `null` when not found.
 */
export async function getWorklogSummary(
  db: MakaioDatabase,
  executionId: string,
): Promise<WorkLogExecutionSummary | null> {
  const rows = await db.select().from(worklogSummaries).where(eq(worklogSummaries.executionId, executionId)).limit(1);
  return rows[0] ? mapSummary(rows[0]) : null;
}

/**
 * Query options for listing WorkLog execution summaries.
 */
export interface ListWorklogSummariesOptions {
  /** Filter by workflow definition ID. */
  workflowId?: string;
  /** Filter by execution status. */
  status?: WorkLogExecutionSummary['status'];
  /** Maximum number of records to return. Defaults to 50. */
  limit?: number;
  /** Zero-based offset for pagination. */
  offset?: number;
}

/**
 * List WorkLog execution summaries with optional filtering.
 *
 * Results are ordered by `startedAt` descending (newest first).
 * @param db - Drizzle database instance.
 * @param options - Filtering and pagination options.
 * @returns Matching summaries and the total count before limit/offset.
 */
export async function listWorklogSummaries(
  db: MakaioDatabase,
  options: ListWorklogSummariesOptions = {},
): Promise<{ items: WorkLogExecutionSummary[]; total: number }> {
  const { workflowId, status, limit = 50, offset = 0 } = options;

  const predicates = [
    ...(workflowId !== undefined ? [eq(worklogSummaries.workflowId, workflowId)] : []),
    ...(status !== undefined ? [eq(worklogSummaries.status, status)] : []),
  ];

  const where = predicates.length > 0 ? and(...predicates) : undefined;

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(worklogSummaries)
      .where(where)
      .orderBy(desc(worklogSummaries.startedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(worklogSummaries).where(where),
  ]);

  return {
    items: rows.map(mapSummary),
    total: totalRows[0]?.count ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────
// Frame entry operations
// ─────────────────────────────────────────────────────────────

/**
 * Upsert a WorkLog frame entry row.
 *
 * Called on `frame.started`, `frame.completed`, and `frame.failed` events to
 * create or update the frame's projection entry.
 * @param db - Drizzle database instance.
 * @param entry - Frame entry values to insert or update.
 */
export async function upsertWorklogFrameEntry(db: MakaioDatabase, entry: InsertWorklogFrameEntry): Promise<void> {
  await db.insert(worklogFrameEntries).values(entry).onConflictDoUpdate({
    target: worklogFrameEntries.frameId,
    set: entry,
  });
}

/**
 * Retrieve a single WorkLog frame entry by frame ID.
 *
 * Used by terminal-event projections (`frame.completed`, `frame.failed`) to
 * read the metadata written by `frame.started` before performing a
 * merge-style update that preserves `nodeType`, `nodeId`, and `path`.
 * @param db - Drizzle database instance.
 * @param frameId - Frame identifier to look up.
 * @returns The frame entry row, or `null` when not found.
 */
export async function getWorklogFrameEntry(
  db: MakaioDatabase,
  frameId: string,
): Promise<SelectWorklogFrameEntry | null> {
  const rows = await db.select().from(worklogFrameEntries).where(eq(worklogFrameEntries.frameId, frameId)).limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────
// Artifact write operations
// ─────────────────────────────────────────────────────────────

/**
 * Insert a WorkLog artifact write event row.
 *
 * Each `artifact.updated` event produces one row. No conflict handling needed
 * because each write gets a unique composite key.
 * @param db - Drizzle database instance.
 * @param write - Artifact write event values to insert.
 */
export async function insertWorklogArtifactWrite(db: MakaioDatabase, write: InsertWorklogArtifactWrite): Promise<void> {
  await db.insert(worklogArtifactWrites).values(write).onConflictDoUpdate({
    target: worklogArtifactWrites.id,
    set: write,
  });
}

/**
 * Build a stable surrogate key for an artifact write row.
 *
 * The key is composed of the execution ID, frame ID, artifact kind, artifact
 * ID, and a human-readable timestamp so that re-delivering the same event is
 * idempotent and multiple writes from the same frame are distinguishable.
 * @param executionId - Execution identifier.
 * @param frameId - Frame identifier.
 * @param artifactKind - Artifact kind string.
 * @param artifactId - Stable artifact identity within its kind.
 * @param writtenAt - Epoch milliseconds when the write was recorded.
 * @returns A stable string key suitable for use as a primary key.
 */
export function buildArtifactWriteId(
  executionId: string,
  frameId: string,
  artifactKind: string,
  artifactId: string,
  writtenAt: number,
): string {
  return `${executionId}:${frameId}:${artifactKind}:${artifactId}:${writtenAt}`;
}

// ─────────────────────────────────────────────────────────────
// Gate event operations
// ─────────────────────────────────────────────────────────────

/**
 * Upsert a WorkLog gate event row.
 *
 * Called on `gate.suspended` (creates the row with `waiting` status) and
 * `gate.resumed` (updates to `resumed` status and sets `resolvedAt`).
 * @param db - Drizzle database instance.
 * @param event - Gate event values to insert or update.
 */
export async function upsertWorklogGateEvent(db: MakaioDatabase, event: InsertWorklogGateEvent): Promise<void> {
  await db.insert(worklogGateEvents).values(event).onConflictDoUpdate({
    target: worklogGateEvents.id,
    set: event,
  });
}

/**
 * Retrieve a single WorkLog gate event by its surrogate ID.
 *
 * Used by `gate.resumed` projection to preserve the prompt and openedAt
 * metadata recorded when the gate first suspended.
 * @param db - Drizzle database instance.
 * @param id - Gate event surrogate key.
 * @returns The gate event row, or `null` when not found.
 */
export async function getWorklogGateEvent(db: MakaioDatabase, id: string): Promise<SelectWorklogGateEvent | null> {
  const rows = await db.select().from(worklogGateEvents).where(eq(worklogGateEvents.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Build a stable surrogate key for a gate event row.
 *
 * The key uniquely identifies a gate node execution within an execution.
 * For iterate expansions the `frameId` ensures uniqueness across iterations.
 * @param executionId - Execution identifier.
 * @param nodeId - Gate node identifier.
 * @param frameId - Frame identifier.
 * @returns A stable string key suitable for use as a primary key.
 */
export function buildGateEventId(executionId: string, nodeId: string, frameId: string): string {
  return `${executionId}:${nodeId}:${frameId}`;
}

// ─────────────────────────────────────────────────────────────
// Token aggregation helper
// ─────────────────────────────────────────────────────────────

/**
 * Re-aggregate token totals from all frame entries for an execution using a
 * single SQL aggregate query instead of loading every row into JS memory.
 *
 * Called after a `frame.completed` event that carries token telemetry so the
 * WorkLog summary stays accurate without loading all frames from memory.
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier to aggregate.
 * @returns Aggregated token sums and cost.
 */
export async function aggregateTokenTotals(
  db: MakaioDatabase,
  executionId: string,
): Promise<{ totalInputTokens: number; totalOutputTokens: number; totalEstimatedCost: number }> {
  const [row] = await db
    .select({
      totalInputTokens: sum(worklogFrameEntries.inputTokens),
      totalOutputTokens: sum(worklogFrameEntries.outputTokens),
      totalEstimatedCost: sum(worklogFrameEntries.estimatedCost),
    })
    .from(worklogFrameEntries)
    .where(eq(worklogFrameEntries.executionId, executionId));

  return {
    totalInputTokens: row?.totalInputTokens !== null ? Number(row?.totalInputTokens) : 0,
    totalOutputTokens: row?.totalOutputTokens !== null ? Number(row?.totalOutputTokens) : 0,
    totalEstimatedCost: row?.totalEstimatedCost !== null ? Number(row?.totalEstimatedCost) : 0,
  };
}

// ─────────────────────────────────────────────────────────────
// Stats aggregation
// ─────────────────────────────────────────────────────────────

/**
 * Query options for aggregating WorkLog statistics.
 */
export interface AggregateWorklogStatsOptions {
  /** Filter by workflow definition ID. */
  workflowId?: string;
  /** Inclusive lower bound on execution `startedAt` (epoch ms). */
  since?: number;
  /** Inclusive upper bound on execution `startedAt` (epoch ms). */
  until?: number;
}

/**
 * Aggregate WorkLog execution statistics over an optional time window.
 *
 * Runs two SQL aggregate queries over `worklog_summaries` (per-status counts
 * and duration/token/cost sums) instead of loading rows into JS memory.
 * Missing telemetry values are treated as zero.
 * @param db - Drizzle database instance.
 * @param options - Workflow and time-window filters (all optional).
 * @returns Aggregated counts per status, total, and duration/token/cost sums.
 */
export async function aggregateWorklogStats(
  db: MakaioDatabase,
  options: AggregateWorklogStatsOptions = {},
): Promise<WorkLogStats> {
  const { workflowId, since, until } = options;

  const predicates = [
    ...(workflowId !== undefined ? [eq(worklogSummaries.workflowId, workflowId)] : []),
    ...(since !== undefined ? [gte(worklogSummaries.startedAt, since)] : []),
    ...(until !== undefined ? [lte(worklogSummaries.startedAt, until)] : []),
  ];
  const where = predicates.length > 0 ? and(...predicates) : undefined;

  const [statusRows, totalRows] = await Promise.all([
    db
      .select({ status: worklogSummaries.status, count: count() })
      .from(worklogSummaries)
      .where(where)
      .groupBy(worklogSummaries.status),
    db
      .select({
        totalDurationMs: sum(worklogSummaries.durationMs),
        totalInputTokens: sum(worklogSummaries.totalInputTokens),
        totalOutputTokens: sum(worklogSummaries.totalOutputTokens),
        totalEstimatedCost: sum(worklogSummaries.totalEstimatedCost),
      })
      .from(worklogSummaries)
      .where(where),
  ]);

  const byStatus: WorkLogStats['byStatus'] = {
    pending: 0,
    running: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  let total = 0;
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
    total += row.count;
  }

  const sums = totalRows[0];
  return {
    total,
    byStatus,
    totalDurationMs: Number(sums?.totalDurationMs ?? 0),
    totalInputTokens: Number(sums?.totalInputTokens ?? 0),
    totalOutputTokens: Number(sums?.totalOutputTokens ?? 0),
    totalEstimatedCost: Number(sums?.totalEstimatedCost ?? 0),
  };
}

// Re-export types needed by the projection service
export type {
  InsertWorklogSummary,
  InsertWorklogFrameEntry,
  SelectWorklogFrameEntry,
  InsertWorklogArtifactWrite,
  InsertWorklogGateEvent,
  SelectWorklogGateEvent,
  WorkflowArtifactBinding,
  JsonValue,
};
