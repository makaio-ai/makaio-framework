import { and, asc, eq } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExecutionLink, SpanRecord, WorkflowStepType } from '@makaio/contracts';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowEngineSchema } from './schema.variants.js';

type WorkflowStepSpansTable = typeof workflowEngineSchema.sqlite.workflowStepSpans;
type WorkflowExecutionLinksTable = typeof workflowEngineSchema.sqlite.workflowExecutionLinks;
type DbSpanRow = WorkflowStepSpansTable['$inferSelect'];
type DbExecutionLinkRow = WorkflowExecutionLinksTable['$inferSelect'];

/**
 * Map nullable DB columns to optional API fields.
 * @param row - Database row
 * @returns Mapped span record
 */
function mapSpan(row: DbSpanRow): SpanRecord {
  return {
    executionId: row.executionId,
    frameId: row.frameId,
    stepId: row.stepId,
    stepType: row.stepType as WorkflowStepType,
    status: row.status,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    estimatedCost: row.estimatedCost ?? undefined,
    toolCallCount: row.toolCallCount ?? undefined,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
  };
}

/**
 * Map nullable DB columns to optional API fields.
 * @param row - Database row
 * @returns Mapped execution link
 */
function mapExecutionLink(row: DbExecutionLinkRow): ExecutionLink {
  return {
    sourceExecutionId: row.sourceExecutionId,
    targetExecutionId: row.targetExecutionId,
    linkType: row.linkType,
    metadata: row.metadata ?? undefined,
  };
}

/**
 * Registers span and execution link handlers.
 *
 * Handles:
 * - Span CRUD: setSpan, listSpans
 * - Execution link CRUD: setExecutionLink, listExecutionLinks
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @returns Cleanup function to unregister handlers
 */
export function registerSpanHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { workflowStepSpans, workflowExecutionLinks } = resolveSchema(db, workflowEngineSchema);

  const unsubSetSpan = bus.on(WorkflowStorageSubjects.setSpan, async (ctx) => {
    const { span } = ctx.payload;
    await db
      .insert(workflowStepSpans)
      .values(span)
      .onConflictDoUpdate({
        target: [workflowStepSpans.executionId, workflowStepSpans.frameId],
        set: span,
      });
    ctx.setResult({ id: `${span.executionId}:${span.frameId}` });
  });

  const unsubListSpans = bus.on(WorkflowStorageSubjects.listSpans, async (ctx) => {
    const rows = await db
      .select()
      .from(workflowStepSpans)
      .where(eq(workflowStepSpans.executionId, ctx.payload.executionId))
      .orderBy(asc(workflowStepSpans.startedAt), asc(workflowStepSpans.stepId), asc(workflowStepSpans.frameId));
    ctx.setResult({ spans: rows.map(mapSpan) });
  });

  const unsubSetExecutionLink = bus.on(WorkflowStorageSubjects.setExecutionLink, async (ctx) => {
    const { link } = ctx.payload;
    await db
      .insert(workflowExecutionLinks)
      .values(link)
      .onConflictDoUpdate({
        target: [workflowExecutionLinks.sourceExecutionId, workflowExecutionLinks.targetExecutionId],
        set: link,
      });
    ctx.setResult({ id: `${link.sourceExecutionId}:${link.targetExecutionId}` });
  });

  const unsubListExecutionLinks = bus.on(WorkflowStorageSubjects.listExecutionLinks, async (ctx) => {
    const { sourceExecutionId, targetExecutionId } = ctx.payload;
    if (sourceExecutionId === undefined && targetExecutionId === undefined) {
      throw new Error('Either sourceExecutionId or targetExecutionId is required to list execution links.');
    }

    const predicates = [
      ...(sourceExecutionId !== undefined ? [eq(workflowExecutionLinks.sourceExecutionId, sourceExecutionId)] : []),
      ...(targetExecutionId !== undefined ? [eq(workflowExecutionLinks.targetExecutionId, targetExecutionId)] : []),
    ];
    const query = db
      .select()
      .from(workflowExecutionLinks)
      .where(and(...predicates));
    ctx.setResult({ links: (await query).map(mapExecutionLink) });
  });

  return () => {
    unsubSetSpan();
    unsubListSpans();
    unsubSetExecutionLink();
    unsubListExecutionLinks();
  };
}
