import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ArtifactSubjects, type ArtifactRevision } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { worklogArtifactWrites, worklogGateEvents } from '../storage/schema.js';
import { createTestDb, createWorkflowExecution, type TestDbContext } from './shared.js';

describe('WorkLog projection service', () => {
  let dbContext: TestDbContext;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: createWorkflowExecution({ id: 'exec-worklog', workflowId: 'wf-worklog' }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dbContext.cleanup();
  });

  it('emits worklog.changed after projecting frame.started', async () => {
    const changedEvents: string[] = [];
    const cleanup = MakaioBus.on(WorkflowSubjects.worklog.changed, (ctx) => {
      changedEvents.push(ctx.payload.executionId);
    });

    try {
      await MakaioBus.emit(WorkflowSubjects.frame.started, {
        executionId: 'exec-worklog',
        frameId: 'frame-plan',
        nodeId: 'plan',
        nodeType: 'station',
        path: ['frame-plan'],
      });

      expect(changedEvents).toEqual(['exec-worklog']);
    } finally {
      cleanup();
    }
  });

  it('preserves gate suspension metadata when projecting gate.resumed', async () => {
    await MakaioBus.emit(WorkflowSubjects.gate.suspended, {
      executionId: 'exec-worklog',
      frameId: 'frame-gate',
      nodeId: 'approve',
      schema: {},
      prompt: 'Approve deployment?',
      autoAction: 'reject',
      timeoutMs: 60000,
      openedAt: Date.now(),
    });

    const [waiting] = await dbContext.db
      .select()
      .from(worklogGateEvents)
      .where(eq(worklogGateEvents.frameId, 'frame-gate'));

    await MakaioBus.emit(WorkflowSubjects.gate.resumed, {
      executionId: 'exec-worklog',
      frameId: 'frame-gate',
      nodeId: 'approve',
      resumeData: { approved: true },
    });

    const [resumed] = await dbContext.db
      .select()
      .from(worklogGateEvents)
      .where(eq(worklogGateEvents.frameId, 'frame-gate'));

    expect(resumed).toMatchObject({
      status: 'resumed',
      prompt: 'Approve deployment?',
      openedAt: waiting?.openedAt,
      resumeData: { approved: true },
    });
    expect(resumed?.resolvedAt).toBeGreaterThanOrEqual(waiting?.openedAt ?? 0);
  });

  it('preserves rejected gate resume data when projecting the resolution event', async () => {
    await MakaioBus.emit(WorkflowSubjects.gate.suspended, {
      executionId: 'exec-worklog',
      frameId: 'frame-gate-reject',
      nodeId: 'approve',
      schema: {},
      prompt: 'Approve deployment?',
      autoAction: 'reject',
      timeoutMs: 60000,
      openedAt: Date.now(),
    });

    const [waiting] = await dbContext.db
      .select()
      .from(worklogGateEvents)
      .where(eq(worklogGateEvents.frameId, 'frame-gate-reject'));

    await MakaioBus.emit(WorkflowSubjects.gate.resumed, {
      executionId: 'exec-worklog',
      frameId: 'frame-gate-reject',
      nodeId: 'approve',
      resumeData: { approved: false, reason: 'needs changes' },
    });

    await MakaioBus.emit(WorkflowSubjects.gate.resolved, {
      executionId: 'exec-worklog',
      stepId: 'approve',
      stepType: 'gate',
      frameId: 'frame-gate-reject',
      action: 'reject',
      source: 'user',
    });

    const [rejected] = await dbContext.db
      .select()
      .from(worklogGateEvents)
      .where(eq(worklogGateEvents.frameId, 'frame-gate-reject'));

    expect(rejected).toMatchObject({
      status: 'rejected',
      prompt: 'Approve deployment?',
      openedAt: waiting?.openedAt,
      resumeData: { approved: false, reason: 'needs changes' },
    });
    expect(rejected?.resolvedAt).toBeGreaterThanOrEqual(waiting?.openedAt ?? 0);
  });

  it('records cancelled gate settlements without resume data', async () => {
    await MakaioBus.emit(WorkflowSubjects.gate.suspended, {
      executionId: 'exec-worklog',
      frameId: 'frame-gate-cancel',
      nodeId: 'approve',
      schema: {},
      prompt: 'Approve deployment?',
      autoAction: 'reject',
      timeoutMs: 60000,
      openedAt: Date.now(),
    });

    const [waiting] = await dbContext.db
      .select()
      .from(worklogGateEvents)
      .where(eq(worklogGateEvents.frameId, 'frame-gate-cancel'));

    await MakaioBus.emit(WorkflowSubjects.gate.resolved, {
      executionId: 'exec-worklog',
      stepId: 'approve',
      stepType: 'gate',
      frameId: 'frame-gate-cancel',
      source: 'cancelled',
    });

    const [cancelled] = await dbContext.db
      .select()
      .from(worklogGateEvents)
      .where(eq(worklogGateEvents.frameId, 'frame-gate-cancel'));

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      prompt: 'Approve deployment?',
      openedAt: waiting?.openedAt,
      resumeData: null,
    });
    expect(cancelled?.resolvedAt).toBeGreaterThanOrEqual(waiting?.openedAt ?? 0);
  });

  it('aggregates worklog stats within a time window', async () => {
    // worklog_summaries.execution_id references workflow_executions.id, so the
    // execution rows must exist before lifecycle events can project summaries.
    for (const executionId of ['wfx-stats-1', 'wfx-stats-2', 'wfx-stats-old']) {
      await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({ id: executionId, workflowId: 'wf-stats' }),
      });
    }

    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId: 'wfx-stats-1',
      workflowId: 'wf-stats',
      startedAt: 1_000,
    });
    await MakaioBus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'wfx-stats-1',
      workflowId: 'wf-stats',
      totalDuration: 500,
      completedAt: 1_500,
    });
    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId: 'wfx-stats-2',
      workflowId: 'wf-stats',
      startedAt: 2_000,
    });
    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId: 'wfx-stats-old',
      workflowId: 'wf-stats',
      startedAt: 10,
    });

    const { stats } = await MakaioBus.request(WorkflowSubjects.worklog.stats, {
      workflowId: 'wf-stats',
      since: 1_000,
      until: 3_000,
    });

    expect(stats.total).toBe(2);
    expect(stats.byStatus.completed).toBe(1);
    expect(stats.byStatus.running).toBe(1);
    expect(stats.totalDurationMs).toBe(500);
  });

  it('records artifact writes with node and artifact metadata resolved from current contracts', async () => {
    const artifact: ArtifactRevision = {
      kind: 'implementation-plan',
      id: 'artifact-1',
      revision: 'rev-1',
      schemaVersion: '2',
      scope: { level: 'project', ids: { projectId: 'project-1' } },
      data: { status: 'draft' },
      relations: [],
      actor: { kind: 'agent', id: 'agent-1' },
      timestamp: 1000,
    };
    const cleanupResolve = MakaioBus.on(ArtifactSubjects.resolve, (ctx) => {
      ctx.setResult({ artifact });
    });

    try {
      await MakaioBus.emit(WorkflowSubjects.frame.started, {
        executionId: 'exec-worklog',
        frameId: 'frame-plan',
        nodeId: 'plan',
        nodeType: 'station',
        path: ['frame-plan'],
      });

      await MakaioBus.emit(WorkflowSubjects.artifact.updated, {
        executionId: 'exec-worklog',
        frameId: 'frame-plan',
        artifactRef: { kind: 'implementation-plan', id: 'artifact-1' },
        paths: ['/status'],
        operation: 'revise',
        revision: 'rev-1',
      });

      const writes = await dbContext.db.select().from(worklogArtifactWrites);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        executionId: 'exec-worklog',
        frameId: 'frame-plan',
        nodeId: 'plan',
        artifact: {
          kind: 'implementation-plan',
          schemaVersion: '2',
          scope: { level: 'project', ids: { projectId: 'project-1' } },
        },
        revision: 'rev-1',
      });
    } finally {
      cleanupResolve();
    }
  });
});
