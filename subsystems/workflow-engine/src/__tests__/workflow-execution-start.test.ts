import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { SessionNamespace, SessionSubjects, WorkflowNamespace, type WorkflowRunContext } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { startFileExecution, type StartExecutionDeps } from '../workflow-execution-start.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';

function makeRunContext(params: Parameters<StartExecutionDeps['buildRunContext']>[0]): WorkflowRunContext {
  return {
    executionId: params.executionId,
    workflowId: params.workflowId,
    source: params.source,
    workerManifest: { packages: [] },
    inputs: params.inputs,
    config: params.config,
    scope: params.scope,
    triggerPayload: params.triggerPayload,
    coordinatorSessionId: params.coordinatorSessionId,
    cancelSubject: `workflow.${params.executionId}.cancel`,
    context: {
      repoPath: params.workspaceRoot,
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'arm64',
    },
    env: {},
    createdAt: Date.now(),
  };
}

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
      await expect(startFileExecution(deps, '/repo/workflows/file.ts')).rejects.toThrow(
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
});
