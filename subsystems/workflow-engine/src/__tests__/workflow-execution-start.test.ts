import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createBusInstance } from '@makaio/bus-core';
import {
  isDefinitionInvalidError,
  SessionNamespace,
  SessionSubjects,
  WorkflowNamespace,
  type WorkflowRunContext,
} from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { workflowDefinitions, workflowExecutions, workflowRunContexts } from '../storage/schema.js';
import {
  persistLoadedExecutionStart,
  startExecution,
  startFileExecution,
  type StartExecutionDeps,
} from '../workflow-execution-start.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';
import { createTestDbForBus, createWorkflowDefinition, createWorkflowExecution } from './shared.js';

function makeRunContext(params: Parameters<StartExecutionDeps['buildRunContext']>[0]): WorkflowRunContext {
  return {
    executionId: params.executionId,
    workflowId: params.workflowId,
    source: params.source,
    workerManifest: { contributionRefs: [] },
    inputs: params.inputs,
    config: params.config,
    scope: params.scope,
    triggerPayload: params.triggerPayload,
    triggerMode: params.triggerMode,
    coordinatorSessionId: params.coordinatorSessionId,
    cancelSubject: `workflow.${params.executionId}.cancel`,
    env: {},
    createdAt: Date.now(),
  };
}

describe('startExecution', () => {
  it.each([
    {
      mode: 'test',
      name: 'removed node',
      unknownKey: undefined,
      node: { type: 'delegate-agent', id: 'removed-step', agentId: 'agent' },
    },
    {
      mode: 'production',
      name: 'removed node',
      unknownKey: undefined,
      node: { type: 'delegate-agent', id: 'removed-step', agentId: 'agent' },
    },
    {
      mode: 'production',
      name: 'unknown nested key',
      unknownKey: 'label',
      node: { type: 'sequence', id: 'inner', nodes: [], label: 'Main' },
    },
  ])('rejects a stored $name before creating a session or execution in $mode mode', async ({
    mode,
    unknownKey,
    node,
  }) => {
    const bus = createBusInstance();
    const call = bus.own('start');
    bus.registerNamespace(SessionNamespace);
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const createdSessions: string[] = [];
    const offCreate = bus.on(SessionSubjects.create, (ctx) => {
      createdSessions.push('session-invalid-definition');
      ctx.setResult({ sessionId: 'session-invalid-definition' });
    });
    const deps: StartExecutionDeps = {
      bus,
      config: { ...DEFAULT_EXECUTOR_CONFIG, platformDefaults: { cwd: '/repo' } },
      activeExecutions: new Map(),
      executionTasks: new Map(),
      workflowRunner: undefined,
      materializationSpecResolvers: new Set(),
      buildRunContext: vi.fn(makeRunContext),
      buildRunnerTaskDeps: vi.fn(),
      buildFinalizerDeps: vi.fn(),
      resolveExecutionWorkspaceRoot: vi.fn(async () => '/repo'),
      runExecution: vi.fn(async () => {}),
    };
    const workflowId = 'wf-invalid-definition';
    const root = {
      type: 'sequence',
      id: 'root',
      nodes: [node], // legacy-input
    };

    try {
      vi.stubEnv('NODE_ENV', mode);
      await dbContext.exec(sql`
          INSERT INTO workflow_definitions (id, name, root, scope_type, created_at, updated_at)
          VALUES (${workflowId}, ${workflowId}, ${JSON.stringify(root)}, 'global', 1, 1)
        `);

      await expect(startExecution(call, deps, workflowId)).rejects.toSatisfy(
        (error: unknown) =>
          isDefinitionInvalidError(error) &&
          (unknownKey === undefined || (error instanceof Error && error.message.includes(unknownKey))),
      );
      expect(createdSessions).toEqual([]);
      expect(deps.buildRunContext).not.toHaveBeenCalled();
      expect(deps.activeExecutions.size).toBe(0);
      expect(deps.executionTasks.size).toBe(0);
      expect(await dbContext.db.select().from(workflowExecutions)).toEqual([]);
      expect(await dbContext.db.select().from(workflowRunContexts)).toEqual([]);
      expect(await dbContext.db.select({ id: workflowDefinitions.id }).from(workflowDefinitions)).toEqual([
        { id: workflowId },
      ]);
    } finally {
      vi.unstubAllEnvs();
      offCreate();
      await dbContext.cleanup();
    }
  });
});

describe('startFileExecution', () => {
  it('checks the workflow runner before persisting or emitting execution start', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(SessionNamespace);
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);

    const setExecutionStart = vi.fn();
    const startedEvents: unknown[] = [];
    const offCreate = bus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'session-file-start' });
    });
    const offClose = bus.on(SessionSubjects.close, (ctx) => {
      ctx.setResult({ success: true });
    });
    const offSetExecutionStart = bus.on(WorkflowStorageSubjects.setExecutionStart, (ctx) => {
      setExecutionStart(ctx.payload);
      ctx.setResult({ id: ctx.payload.execution.id, executionId: ctx.payload.execution.id });
    });
    const offStarted = bus.on(WorkflowSubjects.execution.started, (ctx) => {
      startedEvents.push(ctx.payload);
    });

    const deps: StartExecutionDeps = {
      bus,
      config: {
        ...DEFAULT_EXECUTOR_CONFIG,
        platformDefaults: { cwd: '/repo' },
      },
      activeExecutions: new Map(),
      executionTasks: new Map(),
      workflowRunner: undefined,
      materializationSpecResolvers: new Set(),
      buildRunContext: vi.fn(makeRunContext),
      buildRunnerTaskDeps: vi.fn(() => {
        throw new Error('buildRunnerTaskDeps should not be called without a workflow runner');
      }),
      buildFinalizerDeps: vi.fn(() => {
        throw new Error('buildFinalizerDeps should not be called before launch');
      }),
      resolveExecutionWorkspaceRoot: vi.fn(async () => '/repo'),
      runExecution: vi.fn(async () => {}),
    };

    try {
      await expect(startFileExecution(createTestCall(), deps, '/repo/workflows/file.ts')).rejects.toThrow(
        '[WorkflowExecutor] startFileExecution called without a workflow runner',
      );
      expect(setExecutionStart).not.toHaveBeenCalled();
      expect(startedEvents).toHaveLength(0);
      expect(deps.activeExecutions.size).toBe(0);
      expect(deps.executionTasks.size).toBe(0);
    } finally {
      offStarted();
      offSetExecutionStart();
      offClose();
      offCreate();
    }
  });

  it('rejects a path-backed start without a host-resolved materialization spec before persistence', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(SessionNamespace);
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);

    const setExecutionStart = vi.fn();
    const offCreate = bus.on(SessionSubjects.create, (ctx) => ctx.setResult({ sessionId: 'session-file-start' }));
    const offClose = bus.on(SessionSubjects.close, (ctx) => ctx.setResult({ success: true }));
    const offSetExecutionStart = bus.on(WorkflowStorageSubjects.setExecutionStart, (ctx) => {
      setExecutionStart(ctx.payload);
      ctx.setResult({ id: ctx.payload.execution.id, executionId: ctx.payload.execution.id });
    });
    const deps: StartExecutionDeps = {
      bus,
      config: { ...DEFAULT_EXECUTOR_CONFIG, platformDefaults: { cwd: '/repo' } },
      activeExecutions: new Map(),
      executionTasks: new Map(),
      workflowRunner: { run: vi.fn() },
      materializationSpecResolvers: new Set(),
      buildRunContext: vi.fn(makeRunContext),
      buildRunnerTaskDeps: vi.fn(),
      buildFinalizerDeps: vi.fn(),
      resolveExecutionWorkspaceRoot: vi.fn(async () => '/repo'),
      runExecution: vi.fn(async () => {}),
    };

    try {
      await expect(startFileExecution(createTestCall(), deps, '/repo/workflows/file.ts')).rejects.toThrow(
        'path-backed execution requires a resolved materializationSpec',
      );
      expect(setExecutionStart).not.toHaveBeenCalled();
    } finally {
      offSetExecutionStart();
      offClose();
      offCreate();
    }
  });
});

describe('persistLoadedExecutionStart', () => {
  it('requires atomic execution-start storage for worker-loaded executions', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);

    const setExecution = vi.fn();
    const offSetExecution = bus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
      setExecution(ctx.payload);
      ctx.setResult({ id: ctx.payload.execution.id });
    });

    const workflow = createWorkflowDefinition({ id: 'wf-worker-start-storage-required' });
    const execution = createWorkflowExecution({
      id: 'wfx-worker-start-storage-required',
      workflowId: workflow.id,
      status: 'running',
    });
    const runContext = makeRunContext({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      inputs: {},
      config: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-worker-start-storage-required',
    });

    try {
      await expect(persistLoadedExecutionStart(createTestCall(), bus, execution, runContext, workflow)).rejects.toThrow(
        'storage:workflow.setExecutionStart',
      );
      expect(setExecution).not.toHaveBeenCalled();
    } finally {
      offSetExecution();
    }
  });
});
