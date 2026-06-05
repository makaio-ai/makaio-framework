import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  SubagentSubjects,
  WORKFLOW_CANCELLED_REASON,
  WorkflowNamespace,
  defineWorkflow,
  type ArtifactRevision,
  type WorkflowExecution,
  type WorkflowRunContext,
} from '@makaio/contracts';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDbForBus } from './shared.js';
import { resolveWorkflowArtifactBinding } from '../artifact-context/artifact-binding.js';
import { WorkflowSubjects } from '../namespace.js';

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
