import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  SubagentSubjects,
  WORKFLOW_CANCELLED_REASON,
  WorkflowNamespace,
  defineWorkflow,
  type ArtifactRevision,
  type StationHandler,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowGateNode,
  type WorkflowIterateNode,
  type WorkflowParallelNode,
  type WorkflowRunContext,
  type WorkflowSequenceNode,
  type WorkflowStationNode,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDbForBus } from './shared.js';
import { resolveWorkflowArtifactBinding } from '../artifact-context/artifact-binding.js';
import { WorkflowSubjects } from '../namespace.js';

/**
 * Create a minimal {@link WorkflowWorkerConfig} for testing.
 * @param overrides - Partial config fields merged on top of defaults.
 * @returns A valid WorkflowWorkerConfig stub.
 */
function makeWorkerConfig(overrides?: Partial<WorkflowWorkerConfig>): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'workflow-1' },
    executionId: 'wfx-1',
    workflowId: 'workflow-1',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    context: { repoPath: '/repo', makaioHome: '/home/.makaio', os: 'linux', arch: 'x64' },
    env: {},
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

/**
 * Create a minimal artifact revision for artifact RPC stubs.
 * @param revision - Revision identifier to assign.
 * @param data - Artifact data payload.
 * @param ref - Artifact kind and ID to assign.
 * @returns Stub artifact revision.
 */
function makeArtifactRevision(
  revision: string,
  data: Record<string, unknown>,
  ref: { readonly kind: string; readonly id: string } = { kind: 'workflow-report', id: 'artifact-report-1' },
): ArtifactRevision {
  return {
    kind: ref.kind,
    id: ref.id,
    revision,
    schemaVersion: '1',
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'workflow-execution', id: 'exec-artifact-context' },
    timestamp: Date.now(),
  };
}

describe('runWorkflowOrchestrator artifact bindings', () => {
  it('resolves the workflow artifact binding before station contexts are built', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    bus.registerNamespace(ArtifactNamespace);
    const dbContext = await createTestDbForBus(bus);

    const createdArtifacts: ArtifactRevision[] = [];
    const revisedArtifacts: ArtifactRevision[] = [];

    // Artifact materialization is a host/provider seam. This test owns the
    // orchestrator contract and uses real Drizzle workflow storage; provider
    // packages own implementation-backed create/revise coverage.
    bus.on(ArtifactSubjects.create, (ctx) => {
      const revision = makeArtifactRevision('rev-0', ctx.payload.data);
      createdArtifacts.push(revision);
      ctx.setResult({ artifact: revision });
    });
    bus.on(ArtifactSubjects.revise, (ctx) => {
      const revision = makeArtifactRevision('rev-1', ctx.payload.revision.data);
      revisedArtifacts.push(revision);
      ctx.setResult({ artifact: revision });
    });

    const workflow = defineWorkflow('artifact-context-orchestrator')
      .artifact({
        kind: 'workflow-report',
        schemaVersion: '1',
        scope: { level: 'global' },
        create: '{ status: "draft", title: inputs.title }',
        statusPath: 'status',
      })
      .station('write-report', async (ctx) => {
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateArtifact({
            operation: 'merge',
            data: { status: 'written' },
          });
        }
        return { wroteArtifact: ctx.artifact !== undefined };
      });

    try {
      const result = await runWorkflowOrchestrator({
        config: {
          source: { kind: 'path', path: '/workflows/report.ts' },
          executionId: 'exec-artifact-context',
          workflowId: workflow.id,
          inputs: { title: 'Runtime report' },
          config: {},
          triggerPayload: {},
          scope: { type: 'global' },
          context: {
            repoPath: '/repo',
            makaioHome: '/home/.makaio',
            os: 'linux',
            arch: 'arm64',
          },
          env: {},
          busAuth: { kind: 'none' },
          coordinatorSessionId: 'session-artifact-context',
          cancelSubject: 'workflow.exec-artifact-context.cancel',
          suspensionStrategy: 'wait-in-process',
        },
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(createdArtifacts).toHaveLength(1);
      expect(createdArtifacts[0]?.data).toEqual({ status: 'draft', title: 'Runtime report' });
      expect(revisedArtifacts).toHaveLength(1);
      expect(revisedArtifacts[0]?.data).toEqual({ status: 'written', title: 'Runtime report' });

      const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, {
        executionId: 'exec-artifact-context',
      });
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, {
        executionId: 'exec-artifact-context',
      });

      expect(execution?.status).toBe('completed');
      expect(frames).toEqual([
        expect.objectContaining({
          nodeId: 'write-report',
          nodeType: 'station',
          status: 'completed',
          output: { wroteArtifact: true },
        }),
      ]);
    } finally {
      dbContext.cleanup();
    }
  });

  it('prefers a start-supplied artifact reference over definition resolve/create expressions', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(ArtifactNamespace);

    const queriedRefs: Array<{ kind: string; ids: string[] }> = [];
    const createdArtifacts: ArtifactRevision[] = [];
    const startArtifactRef = { kind: 'workflow-report', id: 'artifact-from-start' };
    const existingArtifact = makeArtifactRevision('rev-existing', { status: 'existing' }, startArtifactRef);

    // Artifact materialization is a provider seam outside the framework
    // workflow engine package. This framework-level test owns the contract:
    // artifact binding must issue the start-supplied ref on the Artifact RPC.
    // Provider-backed create/query behavior is covered by provider packages.
    bus.on(ArtifactSubjects.query, (ctx) => {
      if (ctx.payload.kind === undefined) {
        throw new Error('Artifact query must include the explicit artifact kind.');
      }
      queriedRefs.push({ kind: ctx.payload.kind, ids: [...(ctx.payload.ids ?? [])] });
      ctx.setResult({ artifacts: [existingArtifact] });
    });
    bus.on(ArtifactSubjects.create, (ctx) => {
      const created = makeArtifactRevision('rev-created', ctx.payload.data);
      createdArtifacts.push(created);
      ctx.setResult({ artifact: created });
    });

    const workflow = defineWorkflow('artifact-ref-start-priority')
      .artifact({
        kind: 'workflow-report',
        schemaVersion: '1',
        scope: { level: 'global' },
        resolve: '{ kind: "workflow-report", id: "definition-ref" }',
        create: '{ status: "new" }',
      })
      .station('noop', async () => null);
    const definition = workflow.definition;
    const execution = {
      id: 'exec-start-artifact-ref',
      workflowId: definition.id,
      status: 'running',
      inputs: {},
      startedAt: Date.now(),
      scope: { type: 'global' },
    } satisfies WorkflowExecution;
    const runContext = {
      executionId: execution.id,
      workflowId: definition.id,
      source: { kind: 'definition', workflowId: definition.id },
      definitionSnapshot: definition,
      workerManifest: { packages: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      artifactRef: startArtifactRef,
      coordinatorSessionId: 'session-start-artifact-ref',
      cancelSubject: 'workflow.exec-start-artifact-ref.cancel',
      context: { repoPath: '/repo', makaioHome: '/home/.makaio', os: 'linux', arch: 'arm64' },
      env: {},
      createdAt: Date.now(),
      suspensionStrategy: 'wait-in-process',
    } satisfies WorkflowRunContext;

    const binding = await resolveWorkflowArtifactBinding({ definition, execution, runContext, bus });

    expect(binding?.current.id).toBe('artifact-from-start');
    expect(queriedRefs).toEqual([{ kind: 'workflow-report', ids: ['artifact-from-start'] }]);
    expect(createdArtifacts).toEqual([]);
  });
});

describe('runWorkflowOrchestrator cancellation finalization', () => {
  it('preserves the cancellation reason when a runtime node returns cancelled', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const cancellationEvents: Array<{ executionId: string; reason?: string; completedAt?: number }> = [];
    const unsubscribe = bus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
      cancellationEvents.push(ctx.payload);
    });
    const offResolveAgent = bus.on(WorkflowSubjects.resolveAgent, (ctx) => {
      ctx.setResult({ adapterName: 'test-adapter' });
    });
    const offSpawn = bus.on(SubagentSubjects.spawn, (ctx) => {
      ctx.setResult({ subagentId: 'subagent-cancelled', status: 'spawning' });
    });
    const offAwait = bus.on(SubagentSubjects.await, (ctx) => {
      ctx.setResult({ status: 'cancelled' });
    });

    const workflow = defineWorkflow('subagent-cancel-orchestrator').delegateToAgent('cancelled-subagent', {
      agentId: 'cancel-agent',
    });

    try {
      const result = await runWorkflowOrchestrator({
        config: {
          source: { kind: 'path', path: '/workflows/subagent-cancel.ts' },
          executionId: 'exec-runtime-cancel',
          workflowId: workflow.id,
          inputs: {},
          config: {},
          triggerPayload: {},
          scope: { type: 'global' },
          context: {
            repoPath: '/repo',
            makaioHome: '/home/.makaio',
            os: 'linux',
            arch: 'arm64',
          },
          env: {},
          busAuth: { kind: 'none' },
          coordinatorSessionId: 'session-runtime-cancel',
          cancelSubject: 'workflow.exec-runtime-cancel.cancel',
          suspensionStrategy: 'wait-in-process',
        },
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('cancelled');
      expect(cancellationEvents).toEqual([
        {
          executionId: 'exec-runtime-cancel',
          reason: WORKFLOW_CANCELLED_REASON,
          completedAt: expect.any(Number),
        },
      ]);
    } finally {
      offAwait();
      offSpawn();
      offResolveAgent();
      unsubscribe();
      dbContext.cleanup();
    }
  });

  it('emits execution cancellation once when the worker signal aborts during runtime', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const controller = new AbortController();
    const cancellationEvents: Array<{ executionId: string; reason?: string }> = [];
    let resolveCancellationObserved: () => void = () => {};
    const cancellationObserved = new Promise<void>((resolve) => {
      resolveCancellationObserved = resolve;
    });
    const unsubscribe = bus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
      cancellationEvents.push(ctx.payload);
      resolveCancellationObserved();
    });

    const workflow = defineWorkflow('signal-cancel-orchestrator').station('abort-worker', async () => {
      controller.abort();
      await cancellationObserved;
      return { aborted: true };
    });

    try {
      const result = await runWorkflowOrchestrator({
        config: {
          source: { kind: 'path', path: '/workflows/cancel.ts' },
          executionId: 'exec-signal-cancel',
          workflowId: workflow.id,
          inputs: {},
          config: {},
          triggerPayload: {},
          scope: { type: 'global' },
          context: {
            repoPath: '/repo',
            makaioHome: '/home/.makaio',
            os: 'linux',
            arch: 'arm64',
          },
          env: {},
          busAuth: { kind: 'none' },
          coordinatorSessionId: 'session-signal-cancel',
          cancelSubject: 'workflow.exec-signal-cancel.cancel',
          suspensionStrategy: 'wait-in-process',
        },
        loaded: workflow,
        bus,
        signal: controller.signal,
      });

      expect(result.status).toBe('cancelled');
      expect(cancellationEvents).toEqual([
        {
          executionId: 'exec-signal-cancel',
          reason: WORKFLOW_CANCELLED_REASON,
          completedAt: expect.any(Number),
        },
      ]);

      const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, {
        executionId: 'exec-signal-cancel',
      });
      expect(execution?.status).toBe('cancelled');
      expect(execution?.completedAt).toEqual(expect.any(Number));
    } finally {
      unsubscribe();
      dbContext.cleanup();
    }
  });
});

describe('runWorkflowOrchestrator gate parking (exit-and-redispatch)', () => {
  it('persists paused execution and returns paused result for remote gate parking', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    const workflow = defineWorkflow('park-orchestrator').gate('approval', {
      prompt: 'Continue?',
      autoAction: 'reject',
      timeoutMs: null,
    });

    try {
      const result = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-park-orchestrator',
          workflowId: workflow.id,
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: 'paused',
        pausedAtGateId: 'approval',
        pausedAtFrameId: expect.any(String),
      });
      const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, {
        executionId: 'wfx-park-orchestrator',
      });
      expect(execution?.status).toBe('paused');
      expect(execution?.completedAt).toBeUndefined();
    } finally {
      dbContext.cleanup();
    }
  });
});

describe('runWorkflowOrchestrator resume-skip (exit-and-redispatch)', () => {
  /**
   * Register the minimum execution persistence handler needed to observe
   * resume-frame loading failures without a full storage backend.
   * @param bus - Isolated workflow test bus.
   */
  function registerSetExecutionOnly(bus: ReturnType<typeof createBusInstance>): void {
    bus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
      ctx.setResult({ id: ctx.payload.execution.id });
    });
  }

  it('skips completed frames on resumed remote execution and preserves expression context', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    const analyze = vi.fn(async () => ({ findings: 3 }));
    const implement = vi.fn(async () => ({ sawFindings: 3 }));

    const workflow = defineWorkflow('resume-skip')
      .station('analyze', analyze)
      .gate('approve', { prompt: 'Approve?', autoAction: 'reject', timeoutMs: null })
      .station('implement', implement);

    try {
      // Seed a minimal execution row so the FK constraint on frames is satisfied.
      await bus.request(WorkflowStorageSubjects.setExecution, {
        execution: {
          id: 'wfx-resume-skip',
          workflowId: workflow.id,
          status: 'running',
          inputs: {},
          startedAt: 1,
          scope: { type: 'global' },
        },
      });
      // Seed a completed 'analyze' frame from the prior run.
      await bus.request(WorkflowStorageSubjects.setFrame, {
        executionId: 'wfx-resume-skip',
        frame: {
          frameId: 'frame-analyze',
          nodeId: 'analyze',
          nodeType: 'station',
          path: ['frame-analyze'],
          status: 'completed',
          output: { findings: 3 },
          startedAt: 1,
          completedAt: 2,
        },
      });
      // Seed a waiting 'approve' frame from the prior run.
      await bus.request(WorkflowStorageSubjects.setFrame, {
        executionId: 'wfx-resume-skip',
        frame: {
          frameId: 'frame-approve',
          nodeId: 'approve',
          nodeType: 'gate',
          path: ['frame-approve'],
          status: 'waiting',
          startedAt: 3,
        },
      });
      // Seed the gate instance with 'resumed' status so the gate executor returns immediately.
      await bus.request(WorkflowStorageSubjects.setGateInstance, {
        gate: {
          executionId: 'wfx-resume-skip',
          nodeId: 'approve',
          frameId: 'frame-approve',
          schema: {},
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { approved: true },
          createdAt: 3,
          resolvedAt: 4,
        },
      });

      const result = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-resume-skip',
          workflowId: workflow.id,
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      // The 'analyze' station was already completed in the prior run — must not re-execute.
      expect(analyze).not.toHaveBeenCalled();
      // The 'implement' station sees the analyze output from the resumed frame context.
      expect(implement).toHaveBeenCalledOnce();
      // Verify that 'implement' received the resumed 'analyze' output in its step context.
      expect(implement).toHaveBeenCalledWith(
        expect.objectContaining({
          previousSteps: expect.objectContaining({
            analyze: expect.objectContaining({ output: { findings: 3 } }),
          }),
        }),
      );
    } finally {
      dbContext.cleanup();
    }
  });

  it('fails exit-based redispatch when frame storage is unavailable', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    registerSetExecutionOnly(bus);

    const analyze = vi.fn(async () => ({ findings: 3 }));
    const workflow = defineWorkflow('resume-frame-storage-unavailable').station('analyze', analyze);

    const result = await runWorkflowOrchestrator({
      config: makeWorkerConfig({
        executionId: 'wfx-resume-frame-storage-unavailable',
        workflowId: workflow.id,
        suspensionStrategy: 'exit-and-redispatch',
      }),
      loaded: workflow,
      bus,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failed');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('fails exit-based redispatch when a completed frame checkpoint cannot persist', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    registerSetExecutionOnly(bus);
    bus.on(WorkflowStorageSubjects.listFrames, (ctx) => {
      ctx.setResult({ frames: [] });
    });
    bus.on(WorkflowStorageSubjects.setFrame, (ctx) => {
      if (ctx.payload.frame.status === 'completed') {
        throw new Error('completed frame checkpoint failed');
      }
      ctx.setResult({ frameId: ctx.payload.frame.frameId });
    });

    const analyze = vi.fn(async () => ({ findings: 3 }));
    const workflow = defineWorkflow('resume-completed-frame-storage-fails')
      .station('analyze', analyze)
      .gate('approve', { prompt: 'Approve?', autoAction: 'reject', timeoutMs: null });
    const suspendedGateIds: string[] = [];
    bus.on(WorkflowSubjects.gate.suspended, (ctx) => {
      suspendedGateIds.push(ctx.payload.nodeId);
    });

    const result = await runWorkflowOrchestrator({
      config: makeWorkerConfig({
        executionId: 'wfx-completed-frame-storage-fails',
        workflowId: workflow.id,
        suspensionStrategy: 'exit-and-redispatch',
      }),
      loaded: workflow,
      bus,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failed');
    expect(analyze).toHaveBeenCalledOnce();
    expect(suspendedGateIds).toEqual([]);
  });

  it('fails exit-based redispatch when frame loading throws', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    registerSetExecutionOnly(bus);
    bus.on(WorkflowStorageSubjects.listFrames, () => {
      throw new Error('frame load failed');
    });

    const analyze = vi.fn(async () => ({ findings: 3 }));
    const workflow = defineWorkflow('resume-frame-load-fails').station('analyze', analyze);

    const result = await runWorkflowOrchestrator({
      config: makeWorkerConfig({
        executionId: 'wfx-resume-frame-load-fails',
        workflowId: workflow.id,
        suspensionStrategy: 'exit-and-redispatch',
      }),
      loaded: workflow,
      bus,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: 'failed' });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('preserves the original execution start timestamp on exit-based redispatch', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const completedEvents: Array<{ totalDuration: number }> = [];
    const offCompleted = bus.on(WorkflowSubjects.execution.completed, (ctx) => {
      completedEvents.push({ totalDuration: ctx.payload.totalDuration });
    });

    const workflow = defineWorkflow('resume-preserve-started-at').station('analyze', async () => ({ findings: 3 }));
    const executionId = 'wfx-resume-preserve-started-at';
    const startedAt = Date.now() - 5_000;
    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: workflow.id,
      coordinatorSessionId: 'session-resume-preserve-started-at',
      status: 'running',
      inputs: {},
      config: {},
      startedAt,
      triggerPayload: {},
      scope: { type: 'global' },
    };

    try {
      await bus.request(WorkflowStorageSubjects.setExecution, { execution });

      const result = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId,
          workflowId: workflow.id,
          coordinatorSessionId: execution.coordinatorSessionId,
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      const { execution: stored } = await bus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(result.status).toBe('completed');
      expect(stored?.startedAt).toBe(startedAt);
      expect(completedEvents[0]?.totalDuration).toBeGreaterThanOrEqual(5_000);
    } finally {
      offCompleted();
      dbContext.cleanup();
    }
  });

  it('preserves the original execution start timestamp for immediate redispatch completion', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const workflow: WorkflowDefinition = {
      id: 'resume-empty-preserve-started-at',
      root: { id: 'resume-empty-preserve-started-at__root', type: 'sequence', nodes: [] },
      scope: { type: 'global' },
    };
    const executionId = 'wfx-resume-empty-preserve-started-at';
    const startedAt = Date.now() - 5_000;
    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: workflow.id,
      coordinatorSessionId: 'session-resume-empty-preserve-started-at',
      status: 'running',
      inputs: {},
      config: {},
      startedAt,
      triggerPayload: {},
      scope: { type: 'global' },
    };

    try {
      await bus.request(WorkflowStorageSubjects.setExecution, { execution });

      const result = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId,
          workflowId: workflow.id,
          coordinatorSessionId: execution.coordinatorSessionId,
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: { definition: workflow, runtimeHandlers: new Map() },
        bus,
        signal: new AbortController().signal,
      });

      const { execution: stored } = await bus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(result.status).toBe('completed');
      expect(stored?.startedAt).toBe(startedAt);
    } finally {
      dbContext.cleanup();
    }
  });

  it('reuses structural iterate frames to resume a repeated gate by frame ID', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    const after = vi.fn(async () => ({ continued: true }));
    const approveGate = {
      id: 'approve',
      type: 'gate',
      prompt: 'Approve item {{ index }}?',
      autoAction: 'reject',
      timeoutMs: null,
    } satisfies WorkflowGateNode;
    const fanout = {
      id: 'fanout',
      type: 'iterate',
      collection: 'inputs.items',
      body: {
        id: 'fanout__body',
        type: 'sequence',
        nodes: [approveGate],
      } satisfies WorkflowSequenceNode,
    } satisfies WorkflowIterateNode;
    const afterNode = { id: 'after', type: 'station', prompt: 'After approval' } satisfies WorkflowStationNode;
    const workflow = {
      id: 'resume-iterate-repeated-gate',
      root: {
        id: 'resume-iterate-repeated-gate__root',
        type: 'sequence',
        nodes: [fanout, afterNode],
      },
      scope: { type: 'global' },
    } satisfies WorkflowDefinition;

    const suspendedEvents: Array<{ frameId: string; nodeId: string }> = [];
    const offSuspended = bus.on(WorkflowSubjects.gate.suspended, (ctx) => {
      suspendedEvents.push({ frameId: ctx.payload.frameId, nodeId: ctx.payload.nodeId });
    });

    try {
      await bus.request(WorkflowStorageSubjects.setExecution, {
        execution: {
          id: 'wfx-resume-iterate',
          workflowId: workflow.id,
          status: 'running',
          inputs: { items: ['first', 'second'] },
          startedAt: 1,
          scope: { type: 'global' },
        },
      });
      await bus.request(WorkflowStorageSubjects.setFrame, {
        executionId: 'wfx-resume-iterate',
        frame: {
          frameId: 'frame-fanout',
          nodeId: 'fanout',
          nodeType: 'iterate',
          path: ['frame-fanout'],
          status: 'running',
          attempt: 0,
          startedAt: 1,
        },
      });
      await bus.request(WorkflowStorageSubjects.setFrame, {
        executionId: 'wfx-resume-iterate',
        frame: {
          frameId: 'frame-fanout-item-0',
          nodeId: 'fanout',
          nodeType: 'iterate',
          path: ['frame-fanout', 'frame-fanout-item-0'],
          parentFrameId: 'frame-fanout',
          iteration: 0,
          status: 'completed',
          attempt: 0,
          output: { resumeData: { approved: true, item: 'first' } },
          startedAt: 2,
          completedAt: 3,
        },
      });
      await bus.request(WorkflowStorageSubjects.setFrame, {
        executionId: 'wfx-resume-iterate',
        frame: {
          frameId: 'frame-fanout-item-1',
          nodeId: 'fanout',
          nodeType: 'iterate',
          path: ['frame-fanout', 'frame-fanout-item-1'],
          parentFrameId: 'frame-fanout',
          iteration: 1,
          status: 'running',
          attempt: 0,
          startedAt: 4,
        },
      });
      await bus.request(WorkflowStorageSubjects.setFrame, {
        executionId: 'wfx-resume-iterate',
        frame: {
          frameId: 'frame-approve-item-1',
          nodeId: 'approve',
          nodeType: 'gate',
          path: ['frame-fanout', 'frame-fanout-item-1', 'frame-approve-item-1'],
          parentFrameId: 'frame-fanout-item-1',
          status: 'waiting',
          attempt: 0,
          startedAt: 5,
        },
      });
      await bus.request(WorkflowStorageSubjects.setGateInstance, {
        gate: {
          executionId: 'wfx-resume-iterate',
          nodeId: 'approve',
          frameId: 'frame-approve-item-1',
          schema: {},
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { approved: true, item: 'second' },
          createdAt: 5,
          resolvedAt: 6,
        },
      });

      const result = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-resume-iterate',
          workflowId: workflow.id,
          inputs: { items: ['first', 'second'] },
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: { definition: workflow, runtimeHandlers: new Map([['after', after]]) },
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(after).toHaveBeenCalledOnce();
      expect(suspendedEvents).toEqual([]);

      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, {
        executionId: 'wfx-resume-iterate',
      });
      expect(frames.filter((frame) => frame.nodeId === 'approve')).toEqual([
        expect.objectContaining({
          frameId: 'frame-approve-item-1',
          parentFrameId: 'frame-fanout-item-1',
          status: 'completed',
          output: { resumeData: { approved: true, item: 'second' } },
        }),
      ]);
    } finally {
      offSuspended();
      dbContext.cleanup();
    }
  });

  it('cancels parallel siblings when an exit-based branch parks at a gate', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    const sideEffects: string[] = [];
    const side = vi.fn(
      async (ctx: { readonly signal: AbortSignal }): Promise<null> =>
        new Promise((resolve) => {
          setTimeout(() => {
            if (!ctx.signal.aborted) {
              sideEffects.push('side-effect');
            }
            resolve(null);
          }, 10);
        }),
    );

    const approvalGate = {
      id: 'approve',
      type: 'gate',
      prompt: 'Approve?',
      autoAction: 'reject',
      timeoutMs: null,
    } satisfies WorkflowGateNode;
    const sideNode = { id: 'side', type: 'station', prompt: 'Side effect' } satisfies WorkflowStationNode;
    const parallelNode = {
      id: 'fanout',
      type: 'parallel',
      mode: 'all-settled',
      branches: {
        approval: {
          id: 'approval-branch',
          type: 'sequence',
          nodes: [approvalGate],
        } satisfies WorkflowSequenceNode,
        side: {
          id: 'side-branch',
          type: 'sequence',
          nodes: [sideNode],
        } satisfies WorkflowSequenceNode,
      },
    } satisfies WorkflowParallelNode;
    const workflow = {
      id: 'parallel-parks-on-gate',
      root: {
        id: 'parallel-parks-on-gate__root',
        type: 'sequence',
        nodes: [parallelNode],
      },
      scope: { type: 'global' },
    } satisfies WorkflowDefinition;

    try {
      const result = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-parallel-pause',
          workflowId: workflow.id,
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: { definition: workflow, runtimeHandlers: new Map([['side', side]]) },
        bus,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: 'paused',
        pausedAtGateId: 'approve',
        pausedAtFrameId: expect.any(String),
      });
      expect(side).toHaveBeenCalledOnce();
      expect(sideEffects).toEqual([]);
    } finally {
      dbContext.cleanup();
    }
  });

  it('keeps paused-sibling branch frames resumable after exit-based parking', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    let slowStartedResolve: () => void = () => {};
    const slowStarted = new Promise<void>((resolve) => {
      slowStartedResolve = resolve;
    });
    const sideEffects: string[] = [];
    const record = vi.fn(async () => {
      sideEffects.push('record');
      return { recorded: true };
    });
    const slow = vi.fn(
      async (ctx: { readonly signal: AbortSignal }): Promise<null> =>
        new Promise((resolve) => {
          slowStartedResolve();
          const timeout = setTimeout(() => {
            resolve(null);
          }, 20);
          if (ctx.signal.aborted) {
            clearTimeout(timeout);
            resolve(null);
            return;
          }
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              resolve(null);
            },
            { once: true },
          );
        }),
    );
    const after = vi.fn(async () => ({ continued: true }));
    const waitForSibling = vi.fn(async () => {
      await slowStarted;
      return null;
    });

    const waitForSiblingNode = {
      id: 'wait-for-sibling',
      type: 'station',
      prompt: 'Wait for sibling to start',
    } satisfies WorkflowStationNode;
    const approvalGate = {
      id: 'approve',
      type: 'gate',
      prompt: 'Approve?',
      autoAction: 'reject',
      timeoutMs: null,
    } satisfies WorkflowGateNode;
    const recordNode = { id: 'record', type: 'station', prompt: 'Record side effect' } satisfies WorkflowStationNode;
    const slowNode = { id: 'slow', type: 'station', prompt: 'Slow sibling work' } satisfies WorkflowStationNode;
    const afterNode = { id: 'after', type: 'station', prompt: 'After approval' } satisfies WorkflowStationNode;
    const parallelNode = {
      id: 'fanout',
      type: 'parallel',
      mode: 'all-settled',
      branches: {
        approval: {
          id: 'approval-branch',
          type: 'sequence',
          nodes: [waitForSiblingNode, approvalGate],
        } satisfies WorkflowSequenceNode,
        side: {
          id: 'side-branch',
          type: 'sequence',
          nodes: [recordNode, slowNode, afterNode],
        } satisfies WorkflowSequenceNode,
      },
    } satisfies WorkflowParallelNode;
    const workflow = {
      id: 'parallel-pause-resumes-sibling-branch',
      root: {
        id: 'parallel-pause-resumes-sibling-branch__root',
        type: 'sequence',
        nodes: [parallelNode],
      },
      scope: { type: 'global' },
    } satisfies WorkflowDefinition;
    const runtimeHandlers = new Map<string, StationHandler>([
      ['wait-for-sibling', waitForSibling],
      ['record', record],
      ['slow', slow],
      ['after', after],
    ]);

    try {
      const firstResult = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-parallel-resume-sibling',
          workflowId: workflow.id,
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: {
          definition: workflow,
          runtimeHandlers,
        },
        bus,
        signal: new AbortController().signal,
      });

      expect(firstResult).toMatchObject({
        status: 'paused',
        pausedAtGateId: 'approve',
        pausedAtFrameId: expect.any(String),
      });
      expect(record).toHaveBeenCalledOnce();
      expect(slow).toHaveBeenCalledOnce();
      expect(after).not.toHaveBeenCalled();
      const firstRunFrames = await bus.request(WorkflowStorageSubjects.listFrames, {
        executionId: 'wfx-parallel-resume-sibling',
      });
      expect(firstRunFrames.frames).toEqual(
        expect.arrayContaining([expect.objectContaining({ nodeId: 'fanout', branchKey: 'side', status: 'running' })]),
      );

      if (firstResult.status !== 'paused') {
        throw new Error('Expected first run to park at approval gate.');
      }
      await bus.request(WorkflowStorageSubjects.setGateInstance, {
        gate: {
          executionId: 'wfx-parallel-resume-sibling',
          nodeId: 'approve',
          frameId: firstResult.pausedAtFrameId,
          schema: {},
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { approved: true },
          createdAt: Date.now(),
          resolvedAt: Date.now(),
        },
      });

      const secondResult = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-parallel-resume-sibling',
          workflowId: workflow.id,
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: {
          definition: workflow,
          runtimeHandlers,
        },
        bus,
        signal: new AbortController().signal,
      });

      expect(secondResult.status).toBe('completed');
      expect(record).toHaveBeenCalledOnce();
      expect(sideEffects).toEqual(['record']);
      expect(after).toHaveBeenCalledOnce();
    } finally {
      dbContext.cleanup();
    }
  });

  it('keeps pause-aborted iterate item frames resumable after exit-based parking', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    let slowStartedResolve: () => void = () => {};
    const slowStarted = new Promise<void>((resolve) => {
      slowStartedResolve = resolve;
    });
    const sideEffects: string[] = [];
    const record = vi.fn(async () => {
      sideEffects.push('record');
      return { recorded: true };
    });
    const slow = vi.fn(
      async (ctx: { readonly signal: AbortSignal }): Promise<null> =>
        new Promise((resolve) => {
          slowStartedResolve();
          const timeout = setTimeout(() => {
            resolve(null);
          }, 20);
          if (ctx.signal.aborted) {
            clearTimeout(timeout);
            resolve(null);
            return;
          }
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              resolve(null);
            },
            { once: true },
          );
        }),
    );
    const after = vi.fn(async () => ({ continued: true }));
    const waitForSibling = vi.fn(async () => {
      await slowStarted;
      return null;
    });

    const waitForSiblingNode = {
      id: 'wait-for-sibling',
      type: 'station',
      prompt: 'Wait for sibling to start',
      when: "item == 'approval'",
    } satisfies WorkflowStationNode;
    const approvalGate = {
      id: 'approve',
      type: 'gate',
      prompt: 'Approve?',
      autoAction: 'reject',
      timeoutMs: null,
      when: "item == 'approval'",
    } satisfies WorkflowGateNode;
    const recordNode = {
      id: 'record',
      type: 'station',
      prompt: 'Record side effect',
      when: "item == 'side'",
    } satisfies WorkflowStationNode;
    const slowNode = {
      id: 'slow',
      type: 'station',
      prompt: 'Slow sibling work',
      when: "item == 'side'",
    } satisfies WorkflowStationNode;
    const afterNode = {
      id: 'after',
      type: 'station',
      prompt: 'After approval',
      when: "item == 'side'",
    } satisfies WorkflowStationNode;
    const iterateNode = {
      id: 'fanout',
      type: 'iterate',
      collection: 'inputs.items',
      concurrency: 2,
      body: {
        id: 'fanout__body',
        type: 'sequence',
        nodes: [waitForSiblingNode, approvalGate, recordNode, slowNode, afterNode],
      } satisfies WorkflowSequenceNode,
    } satisfies WorkflowIterateNode;
    const workflow = {
      id: 'iterate-pause-resumes-sibling-item',
      root: {
        id: 'iterate-pause-resumes-sibling-item__root',
        type: 'sequence',
        nodes: [iterateNode],
      },
      scope: { type: 'global' },
    } satisfies WorkflowDefinition;
    const runtimeHandlers = new Map<string, StationHandler>([
      ['wait-for-sibling', waitForSibling],
      ['record', record],
      ['slow', slow],
      ['after', after],
    ]);

    try {
      const firstResult = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-iterate-resume-sibling',
          workflowId: workflow.id,
          inputs: { items: ['approval', 'side'] },
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: { definition: workflow, runtimeHandlers },
        bus,
        signal: new AbortController().signal,
      });

      expect(firstResult).toMatchObject({
        status: 'paused',
        pausedAtGateId: 'approve',
        pausedAtFrameId: expect.any(String),
      });
      expect(record).toHaveBeenCalledOnce();
      expect(slow).toHaveBeenCalledOnce();
      expect(after).not.toHaveBeenCalled();
      const firstRunFrames = await bus.request(WorkflowStorageSubjects.listFrames, {
        executionId: 'wfx-iterate-resume-sibling',
      });
      expect(firstRunFrames.frames).toEqual(
        expect.arrayContaining([expect.objectContaining({ nodeId: 'fanout', iteration: 1, status: 'running' })]),
      );

      if (firstResult.status !== 'paused') {
        throw new Error('Expected first run to park at approval gate.');
      }
      await bus.request(WorkflowStorageSubjects.setGateInstance, {
        gate: {
          executionId: 'wfx-iterate-resume-sibling',
          nodeId: 'approve',
          frameId: firstResult.pausedAtFrameId,
          schema: {},
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { approved: true },
          createdAt: Date.now(),
          resolvedAt: Date.now(),
        },
      });

      const secondResult = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-iterate-resume-sibling',
          workflowId: workflow.id,
          inputs: { items: ['approval', 'side'] },
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: { definition: workflow, runtimeHandlers },
        bus,
        signal: new AbortController().signal,
      });

      expect(secondResult.status).toBe('completed');
      expect(record).toHaveBeenCalledOnce();
      expect(sideEffects).toEqual(['record']);
      expect(after).toHaveBeenCalledOnce();
    } finally {
      dbContext.cleanup();
    }
  });

  it('stops launching bounded iterate batches when an exit-based item parks at a gate', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    const recordedIndexes: number[] = [];
    const record = vi.fn(async (ctx: { readonly index?: number }) => {
      recordedIndexes.push(ctx.index ?? -1);
      return { index: ctx.index };
    });

    const recordNode = { id: 'record', type: 'station', prompt: 'Record item start' } satisfies WorkflowStationNode;
    const approvalGate = {
      id: 'approve',
      type: 'gate',
      prompt: 'Approve item?',
      autoAction: 'reject',
      timeoutMs: null,
    } satisfies WorkflowGateNode;
    const iterateNode = {
      id: 'fanout',
      type: 'iterate',
      collection: 'inputs.items',
      concurrency: 1,
      body: {
        id: 'fanout__body',
        type: 'sequence',
        nodes: [recordNode, approvalGate],
      } satisfies WorkflowSequenceNode,
    } satisfies WorkflowIterateNode;
    const workflow = {
      id: 'iterate-parks-before-next-batch',
      root: {
        id: 'iterate-parks-before-next-batch__root',
        type: 'sequence',
        nodes: [iterateNode],
      },
      scope: { type: 'global' },
    } satisfies WorkflowDefinition;

    try {
      const result = await runWorkflowOrchestrator({
        config: makeWorkerConfig({
          executionId: 'wfx-iterate-pause-batch',
          workflowId: workflow.id,
          inputs: { items: ['first', 'second'] },
          suspensionStrategy: 'exit-and-redispatch',
        }),
        loaded: { definition: workflow, runtimeHandlers: new Map([['record', record]]) },
        bus,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: 'paused',
        pausedAtGateId: 'approve',
        pausedAtFrameId: expect.any(String),
      });
      expect(record).toHaveBeenCalledOnce();
      expect(recordedIndexes).toEqual([0]);
    } finally {
      dbContext.cleanup();
    }
  });
});
