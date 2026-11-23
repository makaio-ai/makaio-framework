import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createBusInstance } from '@makaio/bus-core';
import {
  WorkerNamespace,
  WorkerSubjects,
  WorkflowNamespace,
  WorkflowSubjects,
  WorkflowWorkerConfigSchema,
  WorkflowDefinitionSchema,
  JsonValueSchema,
  type CallContext,
  type JsonValue,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import { createTestCall } from '@makaio/test-utils';
import { createWorkflowTestNamespaceCapability } from './workflow-executor.test-setup.js';
import { createRestartableTempDb } from '@makaio/test-utils/drizzle-harness';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { buildWorkflowAttemptInstruction } from '../workflow-attempt-instruction.js';
import { workflowAttemptOutcomeCodec } from '../workflow-attempt-outcome.js';
import { registerDrizzleWorkflowStorage } from '../storage/handler.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

const legacySnapshot = {
  ...createWorkflowDefinition({ id: 'cancel-gap-workflow' }),
  root: {
    id: 'root',
    type: 'sequence',
    nodes: [{ id: 'retired-review', type: 'station', role: 'review', prompt: 'Review' }], // legacy-input
  },
};

const cancellationSnapshotCases: ReadonlyArray<{
  title: string;
  storedSnapshot: string;
  expectedSnapshot: JsonValue;
}> = [
  {
    title: 'an obsolete node snapshot',
    storedSnapshot: JSON.stringify(legacySnapshot),
    expectedSnapshot: JsonValueSchema.parse(legacySnapshot),
  },
  { title: 'invalid JSON snapshot text', storedSnapshot: '{', expectedSnapshot: '{' },
];

/**
 * Recompose the real owner and Authority over one persistent SQLite file.
 * @param store - Store whose file survives closing all connection handles.
 * @returns Public bus entrypoints, durable repositories and composition cleanup.
 */
async function connectOwner(store: ReturnType<typeof createRestartableTempDb>) {
  const db = await store.connect();
  await applyMigrations(db, readMigrations(), '__workflow_owner_recovery_migrations');
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  bus.registerNamespace(WorkerNamespace);
  const unregisterStorage = registerDrizzleWorkflowStorage(bus, db);
  const repository = await createSqliteAttemptRepository(db, workflowAttemptOutcomeCodec);
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
  const executor = new WorkflowExecutor(
    bus,
    createWorkflowTestNamespaceCapability(bus),
    undefined,
    undefined,
    authority,
  );
  await executor.init();
  const events: string[] = [];
  const unsubscribe = [
    bus.on(WorkflowSubjects.execution.completed, () => {
      events.push('completed');
    }),
    bus.on(WorkflowSubjects.execution.cancelled, () => {
      events.push('cancelled');
    }),
  ];
  return {
    bus,
    repository,
    authority,
    executor,
    events,
    raw: getRawSqlExecutor(db),
    async close() {
      await executor.destroy();
      unsubscribe.forEach((off) => off());
      unregisterStorage();
    },
  };
}

/**
 * Seed the same portable owner context used by authority-dispatched workflows.
 * @param call - Call context of the test's workflow operation.
 * @param owner - Current composition using real owner storage and Authority.
 * @returns Immutable attempt identity and a genuine workflow result.
 */
async function seedOwner(call: CallContext, owner: Awaited<ReturnType<typeof connectOwner>>) {
  const executionId = 'cancel-gap-owner';
  const workflow = createWorkflowDefinition({
    id: 'cancel-gap-workflow',
    root: {
      id: 'root',
      type: 'sequence',
      nodes: [],
    },
  });
  const runContext = {
    executionId,
    workflowId: workflow.id,
    source: { kind: 'definition' as const, workflowId: workflow.id },
    definitionSnapshot: workflow,
    workerManifest: { contributionRefs: [] },
    inputs: {},
    scope: { type: 'global' as const },
    triggerPayload: {},
    coordinatorSessionId: 'cancel-gap-session',
    cancelSubject: `workflow.${executionId}.cancel`,
    env: {},
    createdAt: Date.now(),
    terminalAuthority: 'authority' as const,
  };
  await owner.bus.request(call, WorkflowStorageSubjects.setExecutionStart, {
    execution: createWorkflowExecution({ id: executionId, workflowId: workflow.id }),
    runContext,
  });
  const instruction = buildWorkflowAttemptInstruction({
    id: 'cancel-gap-instruction',
    revision: '1',
    config: WorkflowWorkerConfigSchema.parse({ ...runContext, definition: workflow }),
    runContext,
    preservation: { required: [] },
  });
  const attempt = await owner.authority.createAttempt(executionId, instruction);
  const result: WorkflowRunResult = {
    executionId,
    workflowId: workflow.id,
    status: 'completed',
  };
  return { executionId, executionAttemptId: attempt.executionAttemptId, result };
}

describe('workflow owner cancellation recovery', () => {
  describe.each(['test', 'production'] as const)('in %s mode', (mode) => {
    it.each(cancellationSnapshotCases)('cancels through the real executor with $title', async (snapshot) => {
      expect(WorkflowDefinitionSchema.safeParse(snapshot.expectedSnapshot).success).toBe(false);
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = mode;
      const store = createRestartableTempDb('workflow-owner-opaque-cancel');
      const call = createTestCall();
      let owner: Awaited<ReturnType<typeof connectOwner>> | undefined;
      try {
        owner = await connectOwner(store);
        const { executionId } = await seedOwner(call, owner);
        await owner.raw.run(sql`UPDATE workflow_run_contexts
          SET definition_snapshot = ${snapshot.storedSnapshot} WHERE execution_id = ${executionId}`);
        const stored = await owner.bus.request(call, WorkflowStorageSubjects.getRunContext, { executionId });
        expect(stored.runContext?.definitionSnapshot).toEqual(snapshot.expectedSnapshot);
        const reason = 'Cancel without interpreting the stored definition';
        await expect(
          owner.executor.acceptAuthorityCancellation(call, executionId, { kind: 'cancelled', reason }),
        ).resolves.toEqual({ accepted: true, status: 'cancelled' });
        expect(
          (await owner.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId })).execution,
        ).toMatchObject({ status: 'cancelled', reason });
        expect(owner.events).toEqual(['cancelled']);
      } finally {
        try {
          await owner?.close();
        } finally {
          try {
            await store.close();
          } finally {
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
          }
        }
      }
    });
  });

  it('withholds the completed ACK across restart until the interrupted owner Cancel commits', async () => {
    const store = createRestartableTempDb('workflow-owner-cancel-gap');
    const call = createTestCall();
    let owner: Awaited<ReturnType<typeof connectOwner>> | undefined;
    try {
      owner = await connectOwner(store);
      const submission = await seedOwner(call, owner);
      const { executionId, executionAttemptId } = submission;
      // Fail the actual second durable write, not a mocked acceptance callback.
      await owner.raw.run(
        sql.raw(`CREATE TRIGGER reject_owner_cancel BEFORE UPDATE OF status
        ON workflow_executions WHEN NEW.status = 'cancelled'
        BEGIN SELECT RAISE(ABORT, 'owner cancel write interrupted'); END`),
      );
      await expect(owner.bus.request(call, WorkflowSubjects.cancel, { executionId })).rejects.toThrow();
      const cancellation = await owner.repository.readCancellation(executionAttemptId);
      expect(cancellation).toMatchObject({ controlRevision: 1 });
      const controlObservation = { controlRevision: 1, cancellation };
      const waiter = owner.authority.waitForOutcome(executionAttemptId);
      if (waiter === undefined) throw new Error('Initial dispatch must install a waiter');
      let resolved = false;
      void waiter.then(() => {
        resolved = true;
      });
      await expect(owner.bus.request(call, WorkerSubjects.control.outcome.submit, submission)).rejects.toThrow(
        'not durably settled',
      );
      const committed = await owner.repository.readAttemptSettlement({ executionId, executionAttemptId });
      expect(committed).toMatchObject({
        kind: 'outcome',
        result: { outcome: submission.result },
        controlObservation,
      });
      expect(resolved).toBe(false);
      expect(owner.events).toEqual([]);
      await owner.close();
      owner = undefined;
      await store.closeConnections();

      owner = await connectOwner(store);
      expect(await owner.repository.readAttemptSettlement({ executionId, executionAttemptId })).toEqual(committed);
      // Waiters are process-local; recovery must not need the lost original one.
      expect(owner.authority.waitForOutcome(executionAttemptId)).toBeUndefined();
      await expect(owner.bus.request(call, WorkerSubjects.control.outcome.submit, submission)).rejects.toThrow(
        'not durably settled',
      );
      expect(resolved).toBe(false);
      expect(
        (await owner.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId })).execution?.status,
      ).toBe('running');
      expect(owner.events).toEqual([]);

      await owner.raw.run(sql.raw('DROP TRIGGER reject_owner_cancel'));
      await expect(owner.bus.request(call, WorkflowSubjects.cancel, { executionId })).resolves.toEqual({
        cancelled: true,
      });
      await expect(owner.bus.request(call, WorkerSubjects.control.outcome.submit, submission)).resolves.toEqual({
        decision: 'duplicate',
      });
      if (committed.kind !== 'outcome') throw new Error('Expected a canonical committed outcome');
      await expect(
        owner.executor.acceptAuthorityOutcome({
          call,
          executionId,
          executionAttemptId,
          outcome: committed.result.outcome,
          controlObservation: committed.controlObservation,
          decision: 'duplicate',
        }),
      ).resolves.toBe('recorded-only');
      expect(
        (await owner.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId })).execution?.status,
      ).toBe('cancelled');
      expect(owner.events).toEqual(['cancelled']);
      expect(await owner.repository.readAttemptSettlement({ executionId, executionAttemptId })).toEqual(committed);
    } finally {
      try {
        await owner?.close();
      } finally {
        await store.close();
      }
    }
  });
});
