import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  type ArtifactRevision,
  type IWorkflowRunner,
  type WorkflowRunnerCompletion,
  type WorkflowStationNode,
  type WorkflowWorkerConfig,
  serializeArtifactRef,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition } from './shared.js';

describe('workflow public artifact subjects', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }
  });

  it('persists the requested artifact reference when starting through the public start subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-start-artifact-ref',
      name: 'Public Start Artifact Ref',
      root: { id: 'public-start-artifact-ref-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const artifactRef = { kind: 'implementation-plan', id: 'artifact-start-1' };
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef,
    });

    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });

    expect(runContext?.artifactRef).toEqual(artifactRef);

    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
    expect(execution?.artifactRef).toEqual(artifactRef);
  });

  it('emits artifactRef on execution.started and filters listExecutions by artifactRef', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-artifact-ref-filter',
      name: 'Artifact Ref Filter',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const artifactRef = { kind: 'workpiece', id: 'wp-filter-1' };
    const startedRefs: Array<unknown> = [];
    const unsub = MakaioBus.on(WorkflowSubjects.execution.started, (ctx) => {
      startedRefs.push(ctx.payload.artifactRef);
    });
    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        artifactRef,
      });
      await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id }); // no ref — must not match

      const { executions } = await MakaioBus.request(WorkflowSubjects.listExecutions, { artifactRef });

      expect(executions.map((execution) => execution.id)).toEqual([executionId]);
      expect(startedRefs).toContainEqual(artifactRef);
    } finally {
      unsub();
    }
  });

  it('batch-fetches executions by artifact refs via public subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-batch-artifact-ref',
      name: 'Batch Artifact Ref',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const refA = { kind: 'workpiece', id: 'wp-batch-a' };
    const refB = { kind: 'workpiece', id: 'wp-batch-b' };
    const refMiss = { kind: 'workpiece', id: 'wp-batch-miss' };

    const { executionId: idA } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef: refA,
    });
    const { executionId: idB } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef: refB,
    });

    const { executionsByRef } = await MakaioBus.request(WorkflowSubjects.listExecutionsByArtifactRefs, {
      refs: [refA, refB, refMiss],
      limitPerRef: 10,
    });

    expect(executionsByRef[serializeArtifactRef(refA)]?.map((e) => e.id)).toEqual([idA]);
    expect(executionsByRef[serializeArtifactRef(refB)]?.map((e) => e.id)).toEqual([idB]);
    expect(executionsByRef[serializeArtifactRef(refMiss)]).toBeUndefined();
  });

  it('passes start artifact references through isolated runner configuration', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const queriedRefs: Array<{ kind: string; ids: string[] }> = [];
    const capturedConfigs: WorkflowWorkerConfig[] = [];
    const workflowRunner: IWorkflowRunner = {
      async run(config, signal): Promise<WorkflowRunnerCompletion> {
        capturedConfigs.push(config);
        if (config.definition === undefined) {
          throw new Error('Definition-backed runner config must include a workflow definition snapshot.');
        }
        const result = await runWorkflowOrchestrator({
          config,
          loaded: {
            definition: config.definition,
            runtimeHandlers: new Map([['noop', async () => null]]),
          },
          bus: MakaioBus,
          signal,
        });
        return { state: 'uncommitted', result };
      },
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner });
    MakaioBus.registerNamespace(ArtifactNamespace);

    const startArtifactRef = { kind: 'workflow-report', id: 'artifact-from-start' };
    const existingArtifact = {
      kind: startArtifactRef.kind,
      id: startArtifactRef.id,
      revision: 'rev-existing',
      schemaVersion: 1,
      scope: { level: 'global' },
      data: { status: 'existing' },
      relations: [],
      actor: { kind: 'workflow-execution', id: 'exec-existing', displayName: 'Workflow Engine' },
      timestamp: Date.now(),
      createdAt: Date.now(),
    } satisfies ArtifactRevision;
    setup.cleanupFns.push(
      MakaioBus.on(ArtifactSubjects.query, (ctx) => {
        if (ctx.payload.kind === undefined) {
          throw new Error('Artifact query must include the explicit artifact kind.');
        }
        queriedRefs.push({ kind: ctx.payload.kind, ids: [...(ctx.payload.ids ?? [])] });
        ctx.setResult({ artifacts: [existingArtifact] });
      }),
    );

    const noopNode: WorkflowStationNode = { id: 'noop', type: 'station', prompt: 'Noop' };
    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-start-artifact-ref-runner',
        name: 'Public Start Artifact Ref Runner',
        root: {
          id: 'public-start-artifact-ref-runner-root',
          type: 'sequence',
          nodes: [noopNode],
        },
      }),
      artifact: {
        kind: 'workflow-report',
        schemaVersion: 1,
        scope: { level: 'global' },
        resolve: '{ kind: "workflow-report", id: "definition-ref" }',
        create: '{ status: "created" }',
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef: startArtifactRef,
    });

    await expect(completedPromise).resolves.toBe(executionId);
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]?.artifactRef).toEqual(startArtifactRef);
    expect(queriedRefs).toEqual([{ kind: 'workflow-report', ids: ['artifact-from-start'] }]);
  });
});
