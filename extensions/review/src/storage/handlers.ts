import { eq, and, sql } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { ExtensionContext, ReviewFinding, FindingTarget, FindingStatus } from '@makaio/contracts';
import { ReviewStorageSubjects } from './namespace.js';
import { reviewFindings } from './schema.js';
import type { SelectReviewFinding } from './schema.js';

/**
 * Parse the JSON-serialised suggested changes column, defaulting to an empty
 * array when the stored value is malformed.
 * @param raw - Raw JSON string from the database column
 * @returns Parsed suggested-changes array, or `[]` on parse failure
 */
function parseSuggestedChanges(raw: string): ReviewFinding['suggestedChanges'] {
  try {
    return JSON.parse(raw) as ReviewFinding['suggestedChanges'];
  } catch {
    return [];
  }
}

/**
 * Maps a database row to a {@link ReviewFinding} API type.
 * @param row - Database row from extension_review_findings table
 * @returns Mapped ReviewFinding object with validated types
 */
function rowToFinding(row: SelectReviewFinding): ReviewFinding {
  return {
    id: row.id,
    target: {
      repository: row.repository,
      prNumber: row.prNumber ?? undefined,
      branch: row.branch ?? undefined,
      headSha: row.headSha ?? undefined,
    },
    sourceId: row.sourceId,
    reviewer: row.reviewer,
    // Enum casts are safe: the DB is written exclusively by our own code and
    // these values are validated at write-time before storage.
    origin: row.origin as ReviewFinding['origin'],
    threadId: row.threadId,
    severity: row.severity as ReviewFinding['severity'],
    file: row.file,
    startLine: row.startLine,
    endLine: row.endLine,
    message: row.message,
    agentPrompt: row.agentPrompt,
    suggestedChanges: parseSuggestedChanges(row.suggestedChanges),
    status: row.status as ReviewFinding['status'],
    addressedBy: row.addressedBy,
    addressedAt: row.addressedAt,
    verifiedAt: row.verifiedAt,
    dismissedReason: row.dismissedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rawCommentId: row.rawCommentId,
  };
}

/**
 * Maps a {@link ReviewFinding} to a database insert row.
 * @param finding - ReviewFinding to persist
 * @returns Database insert row shape
 */
function findingToRow(finding: ReviewFinding): typeof reviewFindings.$inferInsert {
  return {
    id: finding.id,
    repository: finding.target.repository,
    prNumber: finding.target.prNumber ?? null,
    branch: finding.target.branch ?? null,
    headSha: finding.target.headSha ?? null,
    sourceId: finding.sourceId,
    reviewer: finding.reviewer,
    origin: finding.origin,
    threadId: finding.threadId ?? null,
    severity: finding.severity,
    file: finding.file ?? null,
    startLine: finding.startLine ?? null,
    endLine: finding.endLine ?? null,
    message: finding.message,
    agentPrompt: finding.agentPrompt ?? null,
    suggestedChanges: JSON.stringify(finding.suggestedChanges),
    status: finding.status,
    addressedBy: finding.addressedBy ?? null,
    addressedAt: finding.addressedAt ?? null,
    verifiedAt: finding.verifiedAt ?? null,
    dismissedReason: finding.dismissedReason ?? null,
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
    rawCommentId: finding.rawCommentId ?? null,
  };
}

/**
 * Builds drizzle WHERE conditions for a FindingTarget.
 *
 * Always filters by repository. Filters by optional target fields only when
 * they are present on the query target, preserving broad PR/branch queries
 * while allowing head-specific consumers to exclude stale findings.
 * @param target - The finding target to build conditions for
 * @returns Array of drizzle SQL conditions
 */
function buildTargetConditions(target: FindingTarget): Parameters<typeof and>[number][] {
  const conditions: Parameters<typeof and>[number][] = [eq(reviewFindings.repository, target.repository)];
  if (target.prNumber !== undefined) {
    conditions.push(eq(reviewFindings.prNumber, target.prNumber));
  }
  if (target.branch !== undefined) {
    conditions.push(eq(reviewFindings.branch, target.branch));
  }
  if (target.headSha !== undefined) {
    conditions.push(eq(reviewFindings.headSha, target.headSha));
  }
  return conditions;
}

/**
 * Registers the upsert-single handler.
 * @param bus - MakaioBus instance
 * @param db - Drizzle database instance
 * @returns Cleanup function
 */
function registerUpsertHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(ReviewStorageSubjects.findings.upsert, async (ctx) => {
    const { finding } = ctx.payload;
    const now = Date.now();
    const row = findingToRow(finding);

    await db
      .insert(reviewFindings)
      .values(row)
      .onConflictDoUpdate({
        target: reviewFindings.id,
        set: {
          ...row,
          createdAt: sql`COALESCE(${reviewFindings.createdAt}, excluded.created_at)`,
          updatedAt: now,
        },
      });

    ctx.setResult({ id: finding.id });
  });
}

/**
 * Registers the upsert-batch handler.
 *
 * All rows are batched into a single multi-row INSERT … ON CONFLICT DO UPDATE
 * statement. Using `.values([...rows])` avoids N sequential writes; the
 * `excluded.*` references in the conflict set apply per conflicting row.
 * @param bus - MakaioBus instance
 * @param db - Drizzle database instance
 * @returns Cleanup function
 */
function registerUpsertBatchHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(ReviewStorageSubjects.findings.upsertBatch, async (ctx) => {
    const { findings } = ctx.payload;
    if (findings.length === 0) {
      ctx.setResult({ upserted: 0 });
      return;
    }

    const now = Date.now();
    const rows = findings.map(findingToRow);

    const affectedRows = await db
      .insert(reviewFindings)
      .values(rows)
      .onConflictDoUpdate({
        target: reviewFindings.id,
        set: {
          repository: sql`excluded.repository`,
          prNumber: sql`excluded.pr_number`,
          branch: sql`excluded.branch`,
          headSha: sql`excluded.head_sha`,
          sourceId: sql`excluded.source_id`,
          reviewer: sql`excluded.reviewer`,
          origin: sql`excluded.origin`,
          threadId: sql`excluded.thread_id`,
          severity: sql`excluded.severity`,
          file: sql`excluded.file`,
          startLine: sql`excluded.start_line`,
          endLine: sql`excluded.end_line`,
          message: sql`excluded.message`,
          agentPrompt: sql`excluded.agent_prompt`,
          suggestedChanges: sql`excluded.suggested_changes`,
          status: sql`excluded.status`,
          addressedBy: sql`excluded.addressed_by`,
          addressedAt: sql`excluded.addressed_at`,
          verifiedAt: sql`excluded.verified_at`,
          dismissedReason: sql`excluded.dismissed_reason`,
          createdAt: sql`COALESCE(${reviewFindings.createdAt}, excluded.created_at)`,
          updatedAt: now,
          rawCommentId: sql`excluded.raw_comment_id`,
        },
      })
      .returning({ id: reviewFindings.id });

    ctx.setResult({ upserted: affectedRows.length });
  });
}

/**
 * Registers the list-by-target handler.
 * @param bus - MakaioBus instance
 * @param db - Drizzle database instance
 * @returns Cleanup function
 */
function registerListHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(ReviewStorageSubjects.findings.list, async (ctx) => {
    const { target, status } = ctx.payload;
    const conditions = buildTargetConditions(target);

    if (status !== undefined) {
      conditions.push(eq(reviewFindings.status, status as FindingStatus));
    }

    const rows = await db
      .select()
      .from(reviewFindings)
      .where(and(...conditions))
      .orderBy(reviewFindings.createdAt);

    ctx.setResult({ findings: rows.map(rowToFinding) });
  });
}

/**
 * Registers the get-by-id handler.
 * @param bus - MakaioBus instance
 * @param db - Drizzle database instance
 * @returns Cleanup function
 */
function registerGetHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(ReviewStorageSubjects.findings.get, async (ctx) => {
    const [row] = await db.select().from(reviewFindings).where(eq(reviewFindings.id, ctx.payload.id)).limit(1);
    ctx.setResult({ finding: row ? rowToFinding(row) : null });
  });
}

/**
 * Registers all Drizzle-based review findings storage handlers with the bus.
 *
 * Handles upsert, upsertBatch, list, and get operations for review findings.
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unregister all handlers
 */
export function registerReviewStorageHandlers(bus: IMakaioBus, db: MakaioDatabase, _ctx: ExtensionContext): () => void {
  const cleanups = [
    registerUpsertHandler(bus, db),
    registerUpsertBatchHandler(bus, db),
    registerListHandler(bus, db),
    registerGetHandler(bus, db),
  ];

  return () => cleanups.forEach((fn) => fn());
}
