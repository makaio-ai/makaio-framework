import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactSubjects, type ArtifactRevision } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { worklogArtifactWrites } from '../storage/schema.js';
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
        nodeType: 'agent-step',
        path: ['frame-plan'],
      });

      expect(changedEvents).toEqual(['exec-worklog']);
    } finally {
      cleanup();
    }
  });

  it('releases mutation serialization before awaiting worklog.changed subscribers', async () => {
    const events: string[] = [];
    const cleanup = MakaioBus.on(WorkflowSubjects.worklog.changed, async () => {
      events.push('subscriber:start');
      await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({ id: 'exec-from-subscriber', workflowId: 'wf-subscriber' }),
      });
      events.push('subscriber:end');
    });

    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, {
        executionId: 'exec-worklog',
        workflowId: 'wf-worklog',
        startedAt: 1_000,
      });
      expect(events).toEqual(['subscriber:start', 'subscriber:end']);
      const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
        executionId: 'exec-from-subscriber',
      });
      expect(stored.execution?.workflowId).toBe('wf-subscriber');
    } finally {
      cleanup();
    }
  });

  it('serves a projected frame through worklog.frame.get', async () => {
    await MakaioBus.emit(WorkflowSubjects.frame.started, {
      executionId: 'exec-worklog',
      frameId: 'frame-review',
      nodeId: 'review',
      nodeType: 'agent-step',
      path: ['frame-review'],
      startedAt: 1_000,
    });
    await MakaioBus.emit(WorkflowSubjects.frame.completed, {
      executionId: 'exec-worklog',
      frameId: 'frame-review',
      nodeId: 'review',
      nodeType: 'agent-step',
      output: { verdict: 'approved' },
      duration: 250,
      completedAt: 1_250,
    });

    const result = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, { frameId: 'frame-review' });
    const missing = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, { frameId: 'frame-missing' });

    expect(result.frame).toEqual({
      executionId: 'exec-worklog',
      frameId: 'frame-review',
      nodeId: 'review',
      nodeType: 'agent-step',
      path: ['frame-review'],
      status: 'completed',
      attempt: 0,
      startedAt: 1_000,
      completedAt: 1_250,
      durationMs: 250,
    });
    expect(missing.frame).toBeNull();
  });

  it('writes the nodeType of frame.completed when no frame.started row preceded it (agent-step)', async () => {
    await MakaioBus.emit(WorkflowSubjects.frame.completed, {
      executionId: 'exec-worklog',
      frameId: 'frame-missed-start-completed',
      nodeId: 'review',
      nodeType: 'agent-step',
      duration: 250,
      completedAt: 1_250,
    });

    const result = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, {
      frameId: 'frame-missed-start-completed',
    });

    expect(result.frame?.nodeType).toBe('agent-step');
  });

  it('writes the nodeType of frame.failed when no frame.started row preceded it (code-step)', async () => {
    await MakaioBus.emit(WorkflowSubjects.frame.failed, {
      executionId: 'exec-worklog',
      frameId: 'frame-missed-start-failed',
      nodeId: 'review',
      nodeType: 'code-step',
      error: 'boom',
      duration: 250,
      completedAt: 1_250,
    });

    const result = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, {
      frameId: 'frame-missed-start-failed',
    });

    expect(result.frame?.nodeType).toBe('code-step');
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

  it('does not turn retired workflow artifact events into WorkLog rows', async () => {
    const artifact: ArtifactRevision = {
      kind: 'implementation-plan',
      id: 'artifact-1',
      slug: 'artifact-1',
      revision: 'rev-1',
      schemaVersion: 2,
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
        nodeType: 'agent-step',
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
      expect(writes).toEqual([]);
    } finally {
      cleanupResolve();
    }
  });
});
