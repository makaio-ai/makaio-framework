import { and, eq, isNull, or } from 'drizzle-orm';
import {
  executeTransaction,
  resolveSchema,
  serializeDatabaseOperation,
  type MakaioDatabase,
} from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { WorkflowFinalizationClaim, WorkflowFinalizationIntent } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowEngineSchema } from './schema.variants.js';

type FinalizationRow = (typeof workflowEngineSchema.sqlite.workflowFinalizations)['$inferSelect'];
type PublishFinalization = (claim: WorkflowFinalizationClaim) => Promise<void>;

/**
 * Map one durable row to its public claim contract.
 * @param row - Durable finalization row.
 * @returns Public finalization claim.
 */
function mapClaim(row: FinalizationRow): WorkflowFinalizationClaim {
  return {
    executionId: row.executionId,
    workflowId: row.workflowId,
    finalizerId: row.finalizerId,
    transitionKey: row.transitionKey,
    claimToken: row.claimToken,
    intent: row.intent,
    claimedAt: row.claimedAt,
  };
}

/**
 * Whether an existing row is an exact replay of a claim request.
 * @param row - Existing durable row.
 * @param claim - Incoming claim request.
 * @returns Whether the request exactly replays the unsettled row.
 */
function isSameClaim(row: FinalizationRow, claim: WorkflowFinalizationClaim): boolean {
  return (
    row.state === 'claimed' &&
    row.executionId === claim.executionId &&
    row.workflowId === claim.workflowId &&
    row.finalizerId === claim.finalizerId &&
    row.transitionKey === claim.transitionKey &&
    row.claimToken === claim.claimToken &&
    row.intent.status === claim.intent.status &&
    row.intent.completedAt === claim.intent.completedAt &&
    row.intent.error === claim.intent.error &&
    row.intent.reason === claim.intent.reason
  );
}

/**
 * Assert that a publication request still names the exact durable claim.
 * @param row - Durable finalization authority.
 * @param claim - Requested publication identity.
 */
function assertPublishClaim(row: FinalizationRow, claim: WorkflowFinalizationClaim): void {
  if (
    row.executionId !== claim.executionId ||
    row.workflowId !== claim.workflowId ||
    row.finalizerId !== claim.finalizerId ||
    row.transitionKey !== claim.transitionKey ||
    row.claimToken !== claim.claimToken
  ) {
    throw new Error(`workflow finalization publication claim does not match durable transition ${claim.executionId}`);
  }
}

/**
 * Claim the sole terminal transition for a running execution.
 * @param db - Database handle.
 * @param claim - Finalization claim to persist.
 * @returns Whether this request owns the transition.
 */
async function claimFinalization(db: MakaioDatabase, claim: WorkflowFinalizationClaim): Promise<boolean> {
  const { workflowExecutions, workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
  return executeTransaction(db, async (tx) => {
    const existing = await tx
      .select()
      .from(workflowFinalizations)
      .where(eq(workflowFinalizations.executionId, claim.executionId))
      .limit(1);
    if (existing[0]) return isSameClaim(existing[0], claim);

    const transitioned = await tx
      .update(workflowExecutions)
      .set({ status: 'finalizing' })
      .where(
        and(
          eq(workflowExecutions.id, claim.executionId),
          eq(workflowExecutions.workflowId, claim.workflowId),
          eq(workflowExecutions.status, 'running'),
        ),
      )
      .returning({ id: workflowExecutions.id });
    if (transitioned.length === 0) return false;

    await tx.insert(workflowFinalizations).values({ ...claim, state: 'claimed' });
    return true;
  });
}

/**
 * Build the execution metadata written by successful acknowledgment.
 * @param intent - Persisted intended terminal state.
 * @returns Database values for the terminal execution update.
 */
function terminalExecutionValues(intent: WorkflowFinalizationIntent) {
  return {
    status: intent.status,
    completedAt: intent.completedAt,
    error: intent.status === 'failed' ? (intent.error ?? 'Workflow finalization failed') : null,
    reason: intent.status === 'cancelled' ? (intent.reason ?? null) : null,
  } as const;
}

/**
 * Settle a claimed execution at its intended terminal state exactly once.
 * @param db - Database handle.
 * @param executionId - Claimed execution identifier.
 * @param claimToken - Durable ownership token.
 * @param settledAt - Lifecycle settlement timestamp.
 * @returns Whether the acknowledgment was accepted or already acknowledged.
 */
async function acknowledgeFinalization(
  db: MakaioDatabase,
  executionId: string,
  claimToken: string,
  settledAt: number,
): Promise<boolean> {
  const { workflowExecutions, workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
  return executeTransaction(db, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowFinalizations)
      .where(eq(workflowFinalizations.executionId, executionId))
      .limit(1);
    const row = rows[0];
    if (!row || row.claimToken !== claimToken || row.state === 'failed') return false;
    if (row.state === 'acknowledged') return true;

    const transitioned = await tx
      .update(workflowExecutions)
      .set(terminalExecutionValues(row.intent))
      .where(and(eq(workflowExecutions.id, executionId), eq(workflowExecutions.status, 'finalizing')))
      .returning({ id: workflowExecutions.id });
    if (transitioned.length === 0) return false;
    await tx
      .update(workflowFinalizations)
      .set({ state: 'acknowledged', settledAt })
      .where(
        and(
          eq(workflowFinalizations.executionId, executionId),
          eq(workflowFinalizations.claimToken, claimToken),
          eq(workflowFinalizations.state, 'claimed'),
        ),
      );
    return true;
  });
}

/**
 * Permanently fail a claimed finalization and terminalize the engine record.
 * @param db - Database handle.
 * @param executionId - Claimed execution identifier.
 * @param claimToken - Durable ownership token.
 * @param failure - Permanent lifecycle delivery failure.
 * @param settledAt - Failure timestamp.
 * @returns Whether the failure was accepted or already failed.
 */
async function failFinalization(
  db: MakaioDatabase,
  executionId: string,
  claimToken: string,
  failure: string,
  settledAt: number,
): Promise<boolean> {
  const { workflowExecutions, workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
  return executeTransaction(db, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowFinalizations)
      .where(eq(workflowFinalizations.executionId, executionId))
      .limit(1);
    const row = rows[0];
    if (!row || row.claimToken !== claimToken || row.state === 'acknowledged') return false;
    if (row.state === 'failed') return true;

    const transitioned = await tx
      .update(workflowExecutions)
      .set({ status: 'failed', error: failure, reason: null, completedAt: settledAt })
      .where(and(eq(workflowExecutions.id, executionId), eq(workflowExecutions.status, 'finalizing')))
      .returning({ id: workflowExecutions.id });
    if (transitioned.length === 0) return false;
    await tx
      .update(workflowFinalizations)
      .set({ state: 'failed', failure, settledAt })
      .where(
        and(
          eq(workflowFinalizations.executionId, executionId),
          eq(workflowFinalizations.claimToken, claimToken),
          eq(workflowFinalizations.state, 'claimed'),
        ),
      );
    return true;
  });
}

/**
 * Emit and durably mark one settled terminal lifecycle transition.
 * @param bus - Bus used to publish the terminal lifecycle event.
 * @param db - Durable workflow database.
 * @param claim - Settled transition to publish.
 */
async function publishFinalization(
  bus: IMakaioBus,
  db: MakaioDatabase,
  claim: WorkflowFinalizationClaim,
): Promise<void> {
  const { workflowExecutions, workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
  const rows = await db
    .select()
    .from(workflowFinalizations)
    .where(eq(workflowFinalizations.executionId, claim.executionId))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  assertPublishClaim(row, claim);
  if (row.state === 'claimed' || row.publishedAt !== null) return;
  const executionRows = await db
    .select({
      startedAt: workflowExecutions.startedAt,
      status: workflowExecutions.status,
      error: workflowExecutions.error,
      reason: workflowExecutions.reason,
      completedAt: workflowExecutions.completedAt,
    })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, row.executionId))
    .limit(1);
  const execution = executionRows[0];
  if (!execution || execution.completedAt == null) return;
  if (execution.status === 'completed') {
    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: row.executionId,
      workflowId: row.workflowId,
      totalDuration: execution.completedAt - execution.startedAt,
      completedAt: execution.completedAt,
      transitionKey: row.transitionKey,
    });
  } else if (execution.status === 'failed') {
    await bus.emit(WorkflowSubjects.execution.failed, {
      executionId: row.executionId,
      workflowId: row.workflowId,
      error: execution.error ?? 'Workflow finalization failed',
      completedAt: execution.completedAt,
      transitionKey: row.transitionKey,
    });
  } else if (execution.status === 'cancelled') {
    await bus.emit(WorkflowSubjects.execution.cancelled, {
      executionId: row.executionId,
      workflowId: row.workflowId,
      reason: execution.reason ?? undefined,
      completedAt: execution.completedAt,
      transitionKey: row.transitionKey,
    });
  } else return;
  await serializeDatabaseOperation(db, () =>
    db
      .update(workflowFinalizations)
      .set({ publishedAt: Date.now() })
      .where(and(eq(workflowFinalizations.executionId, row.executionId), isNull(workflowFinalizations.publishedAt))),
  );
}

/**
 * Serialize terminal event publication per execution while preserving mark-after-emit crash replay.
 * @param bus - Bus used to publish terminal lifecycle events.
 * @param db - Durable workflow database.
 * @returns Per-execution publication function.
 */
function createFinalizationPublisher(bus: IMakaioBus, db: MakaioDatabase): PublishFinalization {
  const tails = new Map<string, Promise<void>>();
  return async (claim) => {
    const previous = tails.get(claim.executionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => publishFinalization(bus, db, claim));
    tails.set(claim.executionId, current);
    try {
      await current;
    } finally {
      if (tails.get(claim.executionId) === current) tails.delete(claim.executionId);
    }
  };
}

/**
 * Register durable workflow-finalization protocol handlers.
 * @param bus - Bus receiving finalization storage requests.
 * @param db - Database handle.
 * @returns Cleanup function for every registered handler.
 */
export function registerFinalizationHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const publish = createFinalizationPublisher(bus, db);
  const unsubClaim = bus.on(WorkflowStorageSubjects.claimFinalization, async (ctx) => {
    ctx.setResult({ claimed: await claimFinalization(db, ctx.payload.claim) });
  });
  const unsubList = bus.on(WorkflowStorageSubjects.listClaimedFinalizations, async (ctx) => {
    const { workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
    const rows = await db
      .select()
      .from(workflowFinalizations)
      .where(
        and(eq(workflowFinalizations.finalizerId, ctx.payload.finalizerId), eq(workflowFinalizations.state, 'claimed')),
      );
    ctx.setResult({ claims: rows.map(mapClaim) });
  });
  const unsubListUnpublished = bus.on(WorkflowStorageSubjects.listUnpublishedFinalizations, async (ctx) => {
    const { workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
    const rows = await db
      .select()
      .from(workflowFinalizations)
      .where(
        and(
          or(eq(workflowFinalizations.state, 'acknowledged'), eq(workflowFinalizations.state, 'failed')),
          eq(workflowFinalizations.finalizerId, ctx.payload.finalizerId),
          isNull(workflowFinalizations.publishedAt),
        ),
      );
    ctx.setResult({ claims: rows.map(mapClaim) });
  });
  const unsubPublish = bus.on(WorkflowStorageSubjects.publishFinalization, async (ctx) => {
    await publish(ctx.payload.claim);
    ctx.setResult({});
  });
  const unsubAcknowledge = bus.on(WorkflowStorageSubjects.acknowledgeFinalization, async (ctx) => {
    const { executionId, claimToken, settledAt } = ctx.payload;
    const acknowledged = await acknowledgeFinalization(db, executionId, claimToken, settledAt);
    ctx.setResult({ acknowledged });
    if (!acknowledged) return;
    const { workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
    const rows = await db
      .select()
      .from(workflowFinalizations)
      .where(eq(workflowFinalizations.executionId, executionId))
      .limit(1);
    if (rows[0]) await publish(mapClaim(rows[0]));
  });
  const unsubFail = bus.on(WorkflowStorageSubjects.failFinalization, async (ctx) => {
    const { executionId, claimToken, error, settledAt } = ctx.payload;
    const failed = await failFinalization(db, executionId, claimToken, error, settledAt);
    ctx.setResult({ failed });
    if (!failed) return;
    const { workflowFinalizations } = resolveSchema(db, workflowEngineSchema);
    const rows = await db
      .select()
      .from(workflowFinalizations)
      .where(eq(workflowFinalizations.executionId, executionId))
      .limit(1);
    if (rows[0]) await publish(mapClaim(rows[0]));
  });
  return () => {
    unsubClaim();
    unsubList();
    unsubListUnpublished();
    unsubPublish();
    unsubAcknowledge();
    unsubFail();
  };
}
