import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  FrameworkContractNamespaces,
  SubagentSubjects,
  WORKFLOW_CANCELLED_REASON,
  WorkflowNamespace,
  defineWorkflow,
  codeStep,
  type ArtifactRevision,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowRunContext,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDbForBus, registerInMemoryFrameStore } from './shared.js';
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
    env: {},
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
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
    slug: ref.id,
    revision,
    schemaVersion: 1,
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'workflow-execution', id: 'exec-artifact-context' },
    timestamp: Date.now(),
  };
}

describe('runWorkflowOrchestrator artifact bindings', () => {
  it('returns the artifact revision bound at startup after a Code Step writes a newer revision', async () => {
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
        schemaVersion: 1,
        scope: { level: 'global' },
        create: '{ status: config.initialStatus, title: inputs.title }',
        statusPath: 'status',
      })
      .codeStep('write-report', async (ctx) => {
        const title =
          typeof ctx.inputs === 'object' && ctx.inputs !== null && 'title' in ctx.inputs
            ? (ctx.inputs.title ?? null)
            : null;
        const result = await ctx.request({
          subject: 'artifact.revise',
          payload: {
            previous: { refClass: 'artifact', kind: 'workflow-report', id: 'artifact-report-1', revision: 'rev-0' },
            revision: {
              kind: 'workflow-report',
              schemaVersion: 1,
              scope: { level: 'global' },
              data: { status: 'written', title },
              relations: [],
              actor: { kind: 'workflow-execution', id: ctx.executionId },
            },
          },
        });
        if (!result.ok) throw new Error(result.code);
        return { wroteArtifact: true };
      });

    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config: {
          source: { kind: 'path', path: '/workflows/report.ts' },
          materializationSpec: {
            kind: 'local-directory',
            workspaceId: 'workspace-orchestrator',
            rootDigest: 'sha256-report',
            sourcePath: 'workflows/report.ts',
          },
          executionId: 'exec-artifact-context',
          workflowId: workflow.id,
          inputs: { title: 'Runtime report' },
          config: { initialStatus: 'draft' },
          triggerPayload: {},
          scope: { type: 'global' },
          env: {},
          busAuth: { kind: 'none' },
          coordinatorSessionId: 'session-artifact-context',
          cancelSubject: 'workflow.exec-artifact-context.cancel',
        },
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(result).toMatchObject({
        status: 'completed',
        artifact: expect.objectContaining({
          kind: 'workflow-report',
          id: 'artifact-report-1',
          revision: 'rev-0',
          data: { status: 'draft', title: 'Runtime report' },
        }),
      });
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
          nodeType: 'code-step',
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
        schemaVersion: 1,
        scope: { level: 'global' },
        resolve: '{ kind: "workflow-report", id: "definition-ref" }',
        create: '{ status: "new" }',
      })
      .codeStep('noop', async () => null);
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
      workerManifest: { contributionRefs: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      artifactRef: startArtifactRef,
      coordinatorSessionId: 'session-start-artifact-ref',
      cancelSubject: 'workflow.exec-start-artifact-ref.cancel',
      env: {},
      createdAt: Date.now(),
    } satisfies WorkflowRunContext;

    const binding = await resolveWorkflowArtifactBinding({
      call: createTestCall(),
      definition,
      execution,
      runContext,
      bus,
    });

    expect(binding?.current.id).toBe('artifact-from-start');
    expect(queriedRefs).toEqual([{ kind: 'workflow-report', ids: ['artifact-from-start'] }]);
    expect(createdArtifacts).toEqual([]);
  });
});

describe('runWorkflowOrchestrator terminal finalization', () => {
  it('persists completed step outputs and the execution error when a later step fails', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);

    const workflow = defineWorkflow('failed-execution-error-persistence')
      .codeStep('inspect', () => ({ findings: 3 }))
      .codeStep('summarize', () => ({ summary: 'three findings' }))
      .codeStep('fail-step', async () => {
        throw new Error('code step failed');
      });

    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config: {
          source: { kind: 'path', path: '/workflows/fail.ts' },
          materializationSpec: {
            kind: 'local-directory',
            workspaceId: 'workspace-orchestrator',
            rootDigest: 'sha256-fail',
            sourcePath: 'workflows/fail.ts',
          },
          executionId: 'exec-failed-error-persistence',
          workflowId: workflow.id,
          inputs: {},
          config: {},
          triggerPayload: {},
          scope: { type: 'global' },
          env: {},
          busAuth: { kind: 'none' },
          coordinatorSessionId: 'session-failed-error-persistence',
          cancelSubject: 'workflow.exec-failed-error-persistence.cancel',
        },
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, {
        executionId: 'exec-failed-error-persistence',
      });
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, {
        executionId: 'exec-failed-error-persistence',
      });

      expect(result).toMatchObject({ status: 'failed', error: 'code step failed' });
      expect(execution).toMatchObject({ status: 'failed', error: 'code step failed' });
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: 'inspect', status: 'completed', output: { findings: 3 } }),
          expect.objectContaining({ nodeId: 'summarize', status: 'completed', output: { summary: 'three findings' } }),
          expect.objectContaining({ nodeId: 'fail-step', status: 'failed' }),
        ]),
      );
    } finally {
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

    const workflow = defineWorkflow('signal-cancel-orchestrator').codeStep('abort-worker', async () => {
      controller.abort();
      await cancellationObserved;
      return { aborted: true };
    });

    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config: {
          source: { kind: 'path', path: '/workflows/cancel.ts' },
          materializationSpec: {
            kind: 'local-directory',
            workspaceId: 'workspace-orchestrator',
            rootDigest: 'sha256-cancel',
            sourcePath: 'workflows/cancel.ts',
          },
          executionId: 'exec-signal-cancel',
          workflowId: workflow.id,
          inputs: {},
          config: {},
          triggerPayload: {},
          scope: { type: 'global' },
          env: {},
          busAuth: { kind: 'none' },
          coordinatorSessionId: 'session-signal-cancel',
          cancelSubject: 'workflow.exec-signal-cancel.cancel',
        },
        loaded: workflow,
        bus,
        signal: controller.signal,
      });

      expect(result.status).toBe('cancelled');
      expect(cancellationEvents).toEqual([
        {
          executionId: 'exec-signal-cancel',
          workflowId: workflow.id,
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

  it('cancels an empty workflow when the worker signal aborts during start checkpointing', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const controller = new AbortController();
    const cancellationEvents: Array<{ executionId: string; reason?: string }> = [];
    const completionEvents: Array<{ executionId: string }> = [];
    const offSetExecutionStart = bus.on(
      WorkflowStorageSubjects.setExecutionStart,
      async (ctx) => {
        controller.abort();
        await ctx.next();
      },
      { priority: 100 },
    );
    const offCancelled = bus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
      cancellationEvents.push(ctx.payload);
    });
    const offCompleted = bus.on(WorkflowSubjects.execution.completed, (ctx) => {
      completionEvents.push(ctx.payload);
    });
    const workflow: WorkflowDefinition = {
      id: 'empty-start-checkpoint-abort',
      root: { id: 'empty-start-checkpoint-abort__root', type: 'sequence', nodes: [] },
      scope: { type: 'global' },
    };

    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config: makeWorkerConfig({
          executionId: 'exec-empty-start-checkpoint-abort',
          workflowId: workflow.id,
          coordinatorSessionId: 'session-empty-start-checkpoint-abort',
        }),
        loaded: { definition: workflow, runtimeHandlers: new Map() },
        bus,
        signal: controller.signal,
      });

      expect(result).toMatchObject({
        executionId: 'exec-empty-start-checkpoint-abort',
        workflowId: workflow.id,
        status: 'cancelled',
        reason: WORKFLOW_CANCELLED_REASON,
      });
      const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, {
        executionId: 'exec-empty-start-checkpoint-abort',
      });
      expect(execution).toMatchObject({
        id: 'exec-empty-start-checkpoint-abort',
        workflowId: workflow.id,
        status: 'cancelled',
      });
      expect(cancellationEvents).toEqual([
        {
          executionId: 'exec-empty-start-checkpoint-abort',
          workflowId: workflow.id,
          reason: WORKFLOW_CANCELLED_REASON,
          completedAt: expect.any(Number),
        },
      ]);
      expect(completionEvents).toEqual([]);
    } finally {
      offCompleted();
      offCancelled();
      offSetExecutionStart();
      dbContext.cleanup();
    }
  });
});

describe('runWorkflowOrchestrator node execution', () => {
  it('keeps host fallback out of the public orchestrator options', () => {
    expectTypeOf<Parameters<typeof runWorkflowOrchestrator>[0]>().not.toHaveProperty('allowHostRequestFallback');
  });

  it.each([true, { allowed: true }])('requires a registered subject even with an extra option %j', async (option) => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const subject = 'test-host-only.echo';
    const dispatched: string[] = [];
    const stopObserving = bus.observeMessages((message) => {
      if (message.type === 'request') dispatched.push(`${message.namespace}.${message.subject}`);
    });
    const workflow = defineWorkflow('unregistered-request').codeStep('request', (ctx) =>
      ctx.request({ subject, payload: { message: 'hello' } }),
    );
    const config = makeWorkerConfig({ workflowId: workflow.id });

    try {
      const extraOptions: Record<string, unknown> = { allowHostRequestFallback: option };
      const result = await runWorkflowOrchestrator({
        ...extraOptions,
        call: createTestCall(),
        config,
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId: config.executionId });
      expect(result.status).toBe('completed');
      expect(frames).toMatchObject([{ output: { ok: false, code: 'request-not-granted' } }]);
      expect(dispatched).not.toContain(subject);
    } finally {
      stopObserving();
      dbContext.cleanup();
    }
  });

  it('completes a mixed workflow without sending pause events or gate messages', async () => {
    const bus = createBusInstance();
    bus.registerNamespaces(FrameworkContractNamespaces);
    const removeFrameStore = registerInMemoryFrameStore(bus);
    bus.on(WorkflowStorageSubjects.setExecutionStart, (ctx) => {
      const { id } = ctx.payload.execution;
      ctx.setResult({ id, executionId: id });
    });
    bus.on(WorkflowStorageSubjects.setExecution, (ctx) => ctx.setResult({ id: ctx.payload.execution.id }));
    bus.on(WorkflowSubjects.resolveRole, (ctx) => ctx.setResult({ adapterName: 'claude-code' }));
    bus.on(SubagentSubjects.spawn, (ctx) => ctx.setResult({ subagentId: 'subagent-review', status: 'spawning' }));
    bus.on(SubagentSubjects.await, (ctx) => ctx.setResult({ status: 'completed', result: 'review complete' }));

    const subjects: string[] = [];
    const stopObserving = bus.observeMessages((message) => {
      subjects.push(`${message.namespace}.${message.subject}`);
    });

    const workflow = defineWorkflow('mixed-orchestrator-workflow')
      .codeStep('prepare', () => ({ runParallel: true }))
      .agentStep('review', 'reviewer')
      .parallel('parallel-checks', { when: 'frames.prepare.output.runParallel' }, [
        codeStep('check-draft', () => true),
        codeStep('check-sources', () => true),
      ])
      .iterate('scan-items', ({ index }) => index ?? -1, { collection: 'inputs.items' })
      .iterateChain(
        'count-items',
        [codeStep('increment', ({ previous }) => (typeof previous === 'number' ? previous + 1 : 1))],
        { collection: 'inputs.items' },
      )
      .loop('finish', [codeStep('verify', () => true)], {
        maxRounds: 2,
        check: { handler: 'verified', evaluate: () => ({ kind: 'pass' }) },
      });
    const config = makeWorkerConfig({ workflowId: workflow.id, inputs: { items: ['first', 'second'] } });

    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config,
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId: config.executionId });
      const completedRootNodes = frames
        .filter((frame) => frame.parentFrameId === undefined && frame.status === 'completed')
        .map((frame) => frame.nodeId);
      const gateSubjects = subjects.filter(
        (subject) =>
          /^workflow\.(?:gate\.|listGateInstances$)/.test(subject) ||
          /^storage:workflow\.(?:.*Gate|pauseRunningExecution$|cancelPausedExecution$)/.test(subject),
      );

      expect(result.status).toBe('completed');
      expect(completedRootNodes).toEqual([
        'prepare',
        'review',
        'parallel-checks',
        'scan-items',
        'count-items',
        'finish',
      ]);
      expect(subjects).toContain('workflow.execution.completed');
      expect(subjects).not.toContain('workflow.execution.paused');
      expect(gateSubjects).toEqual([]);
    } finally {
      stopObserving();
      removeFrameStore();
    }
  });
});

describe('runWorkflowOrchestrator loop checks', () => {
  it('passes runtimeLoopChecks from loaded workflows into loop execution', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const body = vi.fn(async () => ({ blockers: [] }));
    const check = vi.fn(() => ({ kind: 'pass' as const }));
    const workflow = defineWorkflow('orchestrator-loop').loop('converge', [codeStep('aggregate', body)], {
      maxRounds: 3,
      check: { handler: 'no-open-blockers', evaluate: check },
    });

    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config: makeWorkerConfig({
          executionId: 'wfx-orchestrator-loop',
          workflowId: workflow.id,
        }),
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(body).toHaveBeenCalledOnce();
      expect(check).toHaveBeenCalledOnce();
    } finally {
      dbContext.cleanup();
    }
  });

  it.each([
    { name: 'default exhaustion', onExhausted: undefined, check: 'loop', passed: undefined },
    { name: 'explicit failure', onExhausted: 'fail', check: 'loop', passed: undefined },
    { name: 'completion on exhaustion', onExhausted: 'complete', check: 'loop', passed: false },
    { name: 'passing check', onExhausted: 'fail', check: 'pass', passed: true },
  ] as const)('projects loop output for $name', async ({ onExhausted, check, passed }) => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    const dbContext = await createTestDbForBus(bus);
    const afterLoop = vi.fn();
    const workflow = defineWorkflow('loop-output')
      .loop('review-loop', [codeStep('review', () => 42)], {
        maxRounds: 2,
        onExhausted,
        check: { handler: 'review-done', evaluate: () => ({ kind: check }) },
      })
      .codeStep(
        'after-loop',
        ({ previousSteps }) => {
          afterLoop();
          return previousSteps['review-loop']?.output ?? null;
        },
        { when: `frames['review-loop'].output.passed == ${passed === true}` },
      );
    const executionId = 'wfx-loop-output';
    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config: makeWorkerConfig({ executionId, workflowId: workflow.id }),
        loaded: workflow,
        bus,
        signal: new AbortController().signal,
      });
      if (passed === undefined) {
        expect(result).toMatchObject({
          status: 'failed',
          error: "Loop node 'review-loop' exhausted maxRounds (2) without a passing check",
        });
        expect(afterLoop).not.toHaveBeenCalled();
        return;
      }
      expect(result.status).toBe('completed');
      expect(afterLoop).toHaveBeenCalledOnce();
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId });
      const output = { passed, rounds: passed ? 1 : 2, bodyOutputs: passed ? [42] : [42, 42] };
      expect(frames).toContainEqual(expect.objectContaining({ nodeId: 'after-loop', status: 'completed', output }));
    } finally {
      dbContext.cleanup();
    }
  });

  it('fails clearly when a serialized loop definition has no runtime check handler', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const workflow = defineWorkflow('orchestrator-loop-missing-check').loop(
      'converge',
      [codeStep('aggregate', async () => ({ blockers: [] }))],
      {
        maxRounds: 3,
        check: { handler: 'missing-check', evaluate: () => ({ kind: 'pass' as const }) },
      },
    );

    try {
      const result = await runWorkflowOrchestrator({
        call: createTestCall(),
        config: makeWorkerConfig({
          executionId: 'wfx-orchestrator-loop-missing-check',
          workflowId: workflow.id,
        }),
        loaded: { definition: workflow.definition, runtimeHandlers: workflow.runtimeHandlers },
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('missing loop check handler(s): missing-check');
      }
    } finally {
      dbContext.cleanup();
    }
  });
});

describe('runWorkflowOrchestrator persisted start timestamps', () => {
  it('preserves the original execution start timestamp when starting a worker', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const completedEvents: Array<{ totalDuration: number }> = [];
    const offCompleted = bus.on(WorkflowSubjects.execution.completed, (ctx) => {
      completedEvents.push({ totalDuration: ctx.payload.totalDuration });
    });

    const workflow = defineWorkflow('preserve-started-at').codeStep('analyze', async () => ({ findings: 3 }));
    const executionId = 'wfx-preserve-started-at';
    const startedAt = Date.now() - 5_000;
    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: workflow.id,
      coordinatorSessionId: 'session-preserve-started-at',
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
        call: createTestCall(),
        config: makeWorkerConfig({
          executionId,
          workflowId: workflow.id,
          coordinatorSessionId: execution.coordinatorSessionId,
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

  it('preserves the original execution start timestamp for an empty workflow', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const dbContext = await createTestDbForBus(bus);
    const workflow: WorkflowDefinition = {
      id: 'empty-preserve-started-at',
      root: { id: 'empty-preserve-started-at__root', type: 'sequence', nodes: [] },
      scope: { type: 'global' },
    };
    const executionId = 'wfx-empty-preserve-started-at';
    const startedAt = Date.now() - 5_000;
    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: workflow.id,
      coordinatorSessionId: 'session-empty-preserve-started-at',
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
        call: createTestCall(),
        config: makeWorkerConfig({
          executionId,
          workflowId: workflow.id,
          coordinatorSessionId: execution.coordinatorSessionId,
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
});
