import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowNamespace, WorkflowRunContextSchema, type WorkflowExecution } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { worklogSummaries, worklogFrameEntries } from '../storage/schema.js';
import { createTestDb, createWorkflowExecution, type TestDbContext } from './shared.js';
import { registerWorkflowStorageDelegationHandlers } from '../workflow-executor-handlers.js';

async function getStoredExecution(executionId: string): Promise<WorkflowExecution> {
  const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
  if (execution === null) {
    throw new Error(`Expected workflow execution to exist: ${executionId}`);
  }
  return execution;
}

describe('External execution registration', () => {
  let dbContext: TestDbContext;
  let delegationCleanups: Array<() => void>;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    // Register namespaces so schema validation (including superRefine cross-field
    // constraints) runs on bus.request() calls in non-production environments.
    MakaioBus.registerNamespace(WorkflowNamespace);
    MakaioBus.registerNamespace(WorkflowStorageNamespace);
    dbContext = await createTestDb();
    delegationCleanups = registerWorkflowStorageDelegationHandlers(MakaioBus);
  });

  afterEach(() => {
    for (const cleanup of delegationCleanups) {
      cleanup();
    }
    vi.restoreAllMocks();
    dbContext.cleanup();
  });

  it('registers an external execution and returns an execution ID', async () => {
    const { executionId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      name: 'direct-station-run',
    });

    expect(executionId).toMatch(/^wfx-ext-/);

    // Verify the execution row exists in storage
    const execution = await getStoredExecution(executionId);
    expect(execution).toMatchObject({
      id: executionId,
      workflowId: 'direct-station-run',
      status: 'running',
    });
  });

  it('supports the full lifecycle: register, emit events, worklog rows exist', async () => {
    // 1. Register the external execution (creates workflow_executions row)
    const { executionId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      name: 'my-station',
      scope: { type: 'external', kind: 'ci', id: 'run-42' },
    });

    // 2. Emit execution.started — worklog projection should create summary
    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId,
      workflowId: 'my-station',
      startedAt: 1000,
    });

    // 3. Emit frame.started — worklog projection should create frame entry
    await MakaioBus.emit(WorkflowSubjects.frame.started, {
      executionId,
      frameId: 'frame-main',
      nodeId: 'main',
      nodeType: 'station',
      path: ['frame-main'],
      startedAt: 1000,
    });

    // 4. Emit frame.completed
    await MakaioBus.emit(WorkflowSubjects.frame.completed, {
      executionId,
      frameId: 'frame-main',
      nodeId: 'main',
      duration: 500,
      completedAt: 1500,
    });

    // 5. Emit execution.completed
    await MakaioBus.emit(WorkflowSubjects.execution.completed, {
      executionId,
      workflowId: 'my-station',
      totalDuration: 500,
      completedAt: 1500,
    });

    // 6. Complete the external execution (update storage row)
    const { success } = await MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
      executionId,
      status: 'completed',
      completedAt: 1500,
    });
    expect(success).toBe(true);

    // Verify worklog summary was created (FK constraint satisfied)
    const summaries = await dbContext.db
      .select()
      .from(worklogSummaries)
      .where(eq(worklogSummaries.executionId, executionId));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      executionId,
      workflowId: 'my-station',
      status: 'completed',
    });

    // Verify worklog frame entry was created (FK constraint satisfied)
    const frames = await dbContext.db
      .select()
      .from(worklogFrameEntries)
      .where(eq(worklogFrameEntries.executionId, executionId));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      frameId: 'frame-main',
      executionId,
      nodeId: 'main',
      status: 'completed',
    });

    // Verify execution row was updated
    const execution = await getStoredExecution(executionId);
    expect(execution).toMatchObject({
      status: 'completed',
      completedAt: 1500,
    });
  });

  it('supports failed external executions', async () => {
    const { executionId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      name: 'failing-station',
    });

    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId,
      workflowId: 'failing-station',
    });

    await MakaioBus.emit(WorkflowSubjects.execution.failed, {
      executionId,
      workflowId: 'failing-station',
      error: 'station handler threw',
      completedAt: 2000,
    });

    const { success } = await MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
      executionId,
      status: 'failed',
      error: 'station handler threw',
      completedAt: 2000,
    });
    expect(success).toBe(true);

    // Verify worklog summary reflects failure
    const summaries = await dbContext.db
      .select()
      .from(worklogSummaries)
      .where(eq(worklogSummaries.executionId, executionId));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      status: 'failed',
      error: 'station handler threw',
    });
  });

  it('supports cancelled external executions', async () => {
    const { executionId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      name: 'cancelled-station',
    });

    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId,
      workflowId: 'cancelled-station',
      startedAt: 3000,
    });

    await MakaioBus.emit(WorkflowSubjects.execution.cancelled, {
      executionId,
      workflowId: 'cancelled-station',
      reason: 'operator cancelled',
      completedAt: 3500,
    });

    const { success } = await MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
      executionId,
      status: 'cancelled',
      reason: 'operator cancelled',
      completedAt: 3500,
    });
    expect(success).toBe(true);

    const summaries = await dbContext.db
      .select()
      .from(worklogSummaries)
      .where(eq(worklogSummaries.executionId, executionId));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      status: 'cancelled',
      completedAt: 3500,
    });

    const execution = await getStoredExecution(executionId);
    expect(execution).toMatchObject({
      status: 'cancelled',
      completedAt: 3500,
      reason: 'operator cancelled',
    });
  });

  it('passes artifact binding through to the execution row', async () => {
    const { executionId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      name: 'artifact-bound-run',
      artifactRef: { kind: 'workpiece', id: 'wp-123' },
    });

    const execution = await getStoredExecution(executionId);
    expect(execution).toMatchObject({
      artifactRef: { kind: 'workpiece', id: 'wp-123' },
    });
  });

  it('defaults scope to global when omitted', async () => {
    const { executionId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      name: 'no-scope',
    });

    const execution = await getStoredExecution(executionId);
    expect(execution.scope).toEqual({ type: 'global' });
  });

  it('preserves explicit null input rather than collapsing it to {}', async () => {
    const { executionId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      name: 'null-input-run',
      input: null,
    });

    const execution = await getStoredExecution(executionId);
    // null is a valid JSON value and must round-trip unchanged; {} would be wrong
    expect(execution.inputs).toBeNull();
  });

  it('rejects completeExternalExecution for a normal engine-owned execution', async () => {
    // Engine executions use the `wfx-` prefix (without `-ext`); the prefix check is the
    // primary discriminant and is sufficient without inspecting the run-context row.
    const execution = createWorkflowExecution({ id: 'wfx-engine-owned', workflowId: 'wf-engine' });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: 'wf-engine',
      source: { kind: 'source', filename: 'test-workflow.ts', source: 'export default {}' },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-engine',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: now,
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext });

    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        executionId: execution.id,
        status: 'completed',
      }),
    ).rejects.toThrow('engine-owned');
  });

  it('rejects completeExternalExecution for a pre-runtime-aborted engine execution (no run-context)', async () => {
    // persistPreRuntimeTerminalExecution writes an engine-owned terminal row via setExecution
    // (not setExecutionStart) when the worker signal aborts before the runtime starts.
    // That row has no run-context but is still engine-owned. The prefix guard catches it.
    const execution = createWorkflowExecution({
      id: 'wfx-pre-runtime-aborted',
      workflowId: 'wf-aborted',
      status: 'cancelled',
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    // No run-context row exists (setExecution, not setExecutionStart). The guard must
    // still reject because the ID lacks the wfx-ext- prefix.
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        executionId: execution.id,
        status: 'completed',
      }),
    ).rejects.toThrow('engine-owned');
  });

  describe('completeExternalExecution cross-field validation', () => {
    let executionId: string;

    beforeEach(async () => {
      const result = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
        name: 'validation-test-run',
      });
      executionId = result.executionId;
    });

    it("rejects status 'failed' without an error message", async () => {
      await expect(
        MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
          executionId,
          status: 'failed',
          // error intentionally omitted
        }),
      ).rejects.toThrow("status 'failed' requires");
    });

    it("rejects status 'cancelled' without a reason", async () => {
      await expect(
        MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
          executionId,
          status: 'cancelled',
          // reason intentionally omitted
        }),
      ).rejects.toThrow("status 'cancelled' requires");
    });

    it("rejects status 'completed' with an error field", async () => {
      await expect(
        MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
          executionId,
          status: 'completed',
          error: 'should not be here',
        }),
      ).rejects.toThrow("status 'completed' must not carry");
    });

    it("rejects status 'completed' with a reason field", async () => {
      await expect(
        MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
          executionId,
          status: 'completed',
          reason: 'should not be here',
        }),
      ).rejects.toThrow("status 'completed' must not carry");
    });

    it("accepts status 'failed' with an error message", async () => {
      const { success } = await MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        executionId,
        status: 'failed',
        error: 'station threw',
      });
      expect(success).toBe(true);
    });

    it("accepts status 'cancelled' with a reason", async () => {
      // Use a fresh registration to avoid "already terminal" conflicts
      const { executionId: cancelId } = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
        name: 'cancellation-test-run',
      });
      const { success } = await MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        executionId: cancelId,
        status: 'cancelled',
        reason: 'user requested cancellation',
      });
      expect(success).toBe(true);
      const execution = await getStoredExecution(cancelId);
      expect(execution).toMatchObject({ status: 'cancelled', reason: 'user requested cancellation' });
    });

    it('rejects completion payloads that violate status metadata rules when bus validation is disabled', async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(
          MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
            executionId,
            status: 'failed',
          }),
        ).rejects.toThrow("status 'failed' requires");
      } finally {
        if (previousNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = previousNodeEnv;
        }
      }
    });

    it('rejects re-completing a terminal external execution', async () => {
      const { success } = await MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        executionId,
        status: 'completed',
      });
      expect(success).toBe(true);

      await expect(
        MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
          executionId,
          status: 'cancelled',
          reason: 'cleanup raced completion',
        }),
      ).rejects.toThrow('cannot transition from status "completed"');
    });
  });
});
