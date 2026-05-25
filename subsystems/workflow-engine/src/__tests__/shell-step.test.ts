import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { SessionSubjects } from '@makaio/contracts';
import { ExecutionTargetSubjects } from '@makaio/services-core';
import { WorkflowSubjects } from '../namespace.js';
import {
  registerMemorySessionStorage,
  registerMemorySessionEventStorage,
  MakaioSessionService,
} from '@makaio/services-core/session';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { executeShellStep } from '../workflow-step-executors.js';
import { WorkflowGateCoordinator } from '../workflow-gate-coordinator.js';
import { DEFAULT_EXECUTOR_CONFIG, type ActiveExecution } from '../types.js';
import {
  asExecutable,
  createTestDb,
  createWorkflowDefinition,
  createWorkflowExecution,
  type TestDbContext,
} from './shared.js';

describe('WorkflowExecutor — shell steps', () => {
  let dbContext: TestDbContext;
  let sessionService: MakaioSessionService;
  let workflowExecutor: WorkflowExecutor;
  let cleanupFns: Array<() => void> = [];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];

    dbContext = await createTestDb();

    cleanupFns.push(registerMemorySessionStorage(MakaioBus));
    cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));

    sessionService = new MakaioSessionService(MakaioBus);
    await sessionService.init();

    workflowExecutor = new WorkflowExecutor(MakaioBus, {
      stepCooldownMs: 0,
      stepTimeoutMs: 30_000,
    });
    await workflowExecutor.init();

    cleanupFns.push(
      MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
      }),
    );
    cleanupFns.push(
      MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
        ctx.setResult({
          executionTarget: {
            id: 'system:local',
            name: 'Local',
            description: 'Default local process execution',
            type: 'local',
            scope: 'default',
            enabled: true,
            createdAt: 0,
            updatedAt: 0,
          },
        });
      }),
    );
  });

  afterEach(async () => {
    workflowExecutor.destroy();
    await sessionService.destroy();
    cleanupFns.forEach((cleanup) => cleanup());
    cleanupFns = [];
    dbContext.cleanup();
  });

  it('captures stdout as result and marks step completed on exit code 0', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'echo-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log("hello world")'],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const completedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.status).toBe('completed');
    expect(execution?.steps['echo-step']?.status).toBe('completed');
    expect(asExecutable(execution?.steps['echo-step'])?.result).toBe('hello world\n');
  });

  it('captures stderr as error and marks step failed on non-zero exit', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'fail-step',
          type: 'shell' as const,
          command: ['node', '-e', "process.stderr.write('bad\\n'); process.exit(1)"],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const failedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.status).toBe('failed');
    expect(execution?.steps['fail-step']?.status).toBe('failed');
    expect(execution?.steps['fail-step']?.error).toBe('bad');
  });

  it('marks shell step failed and releases abort controller when session lookup fails before launch', async () => {
    const workflowInput = createWorkflowDefinition({
      steps: [
        {
          id: 'prelaunch-failure-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log("should not launch")'],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: workflowInput });
    const { workflow } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflowInput.id });
    if (!workflow) {
      throw new Error('Expected stored workflow for shell pre-launch failure test');
    }

    cleanupFns.push(
      MakaioBus.on(
        SessionSubjects.get,
        () => {
          throw new Error('session lookup unavailable');
        },
        { priority: 100 },
      ),
    );

    const execution = createWorkflowExecution({
      id: 'execution-shell-prelaunch-failure',
      workflowId: workflow.id,
      coordinatorSessionId: 'coordinator-session',
      steps: { 'prelaunch-failure-step': { kind: 'executable', status: 'pending' } },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow,
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);
    const shellAbortControllers = new Map<string, AbortController>();
    const gateCoordinator = new WorkflowGateCoordinator(MakaioBus);

    await executeShellStep(
      {
        bus: MakaioBus,
        activeExecutions,
        shellAbortControllers,
        gateCoordinator,
        config: DEFAULT_EXECUTOR_CONFIG,
      },
      execution.id,
      'prelaunch-failure-step',
    );

    const { execution: persistedExecution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: execution.id,
    });

    expect(shellAbortControllers.size).toBe(0);
    expect(persistedExecution?.steps['prelaunch-failure-step']?.status).toBe('failed');
    expect(persistedExecution?.steps['prelaunch-failure-step']?.error).toContain('session lookup unavailable');
  });

  it('sets result to empty string on success with no stdout', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'silent-step',
          type: 'shell' as const,
          command: ['node', '-e', '// silent'],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const completedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.steps['silent-step']?.status).toBe('completed');
    expect(asExecutable(execution?.steps['silent-step'])?.result).toBe('');
  });

  it('resolves {{ }} template expressions in command args', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'template-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log("{{ inputs.target }}")'],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const completedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { target: 'world' },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.steps['template-step']?.status).toBe('completed');
    expect(asExecutable(execution?.steps['template-step'])?.result).toBe('world\n');
  });

  it('fails step when cwd is outside workspace root', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'traversal-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log("should not run")'],
          cwd: '/tmp',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const failedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    // Set up a session with a targetWorkingDirectory so the root is well-defined
    // and /tmp falls outside it.
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.steps['traversal-step']?.status).toBe('failed');
    expect(execution?.steps['traversal-step']?.error).toContain('outside workspace root');
  });

  it('uses coordinator session workingDirectory when cwd is omitted', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'cwd-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log(process.cwd())'],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const completedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    // Start execution - coordinator session is created internally without a targetWorkingDirectory.
    // The default executor platform cwd is process.cwd(), so we test against that.
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.steps['cwd-step']?.status).toBe('completed');
    // The output should be the configured default cwd since the session has no targetWorkingDirectory.
    // Shell step result is always a string (stdout); trim whitespace for comparison.
    const cwdResult = asExecutable(execution?.steps['cwd-step'])?.result;
    expect(typeof cwdResult === 'string' ? cwdResult.trim() : cwdResult).toBe(process.cwd());
  });

  it('uses configured platform cwd when the coordinator session has no working directory', async () => {
    await workflowExecutor.destroy();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'workflow-shell-cwd-'));
    cleanupFns.push(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    workflowExecutor = new WorkflowExecutor(MakaioBus, {
      stepCooldownMs: 0,
      stepTimeoutMs: 30_000,
      platformDefaults: { cwd: workspaceRoot },
    });
    await workflowExecutor.init();

    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'configured-cwd-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log(process.cwd())'],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const completedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });
    const cwdResult = asExecutable(execution?.steps['configured-cwd-step'])?.result;
    expect(typeof cwdResult === 'string' ? cwdResult.trim() : cwdResult).toBe(realpathSync(workspaceRoot));
  });

  it('merges step env vars into the child process environment', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'env-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log(process.env.MY_TEST_VAR)'],
          env: { MY_TEST_VAR: 'hello-from-env' },
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const completedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.steps['env-step']?.status).toBe('completed');
    // Shell step result is always a string (stdout); trim whitespace for comparison.
    const envResult = asExecutable(execution?.steps['env-step'])?.result;
    expect(typeof envResult === 'string' ? envResult.trim() : envResult).toBe('hello-from-env');
  });

  it('kills process and fails step on timeout', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'timeout-step',
          type: 'shell' as const,
          command: ['node', '-e', 'setTimeout(() => {}, 60000)'],
          timeoutMs: 500,
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const failedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.steps['timeout-step']?.status).toBe('failed');
    expect(execution?.steps['timeout-step']?.error).toContain('timed out');
  });

  it('fails step when command exits with non-zero and stdout is captured as fallback error', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'stdout-err-step',
          type: 'shell' as const,
          command: ['node', '-e', 'console.log("stdout-only-error"); process.exit(2)'],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const failedExecutions: string[] = [];
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId,
    });

    expect(execution?.steps['stdout-err-step']?.status).toBe('failed');
    // When no stderr, stdout is used as the error message
    expect(execution?.steps['stdout-err-step']?.error).toBe('stdout-only-error');
  });
});
