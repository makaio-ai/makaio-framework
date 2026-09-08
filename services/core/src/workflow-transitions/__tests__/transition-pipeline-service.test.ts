import { describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, WorkflowSubjects, type ArtifactRevision } from '@makaio/contracts';
import { TransitionPipelineService } from '../transition-pipeline-service.js';

function makeArtifact(overrides: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return {
    kind: 'implementation-plan',
    id: 'artifact-1',
    revision: 'rev-1',
    schemaVersion: 1,
    scope: { level: 'global' },
    data: { status: 'draft' },
    relations: [],
    actor: { kind: 'agent', id: 'agent-1' },
    timestamp: 1000,
    ...overrides,
  };
}

describe('TransitionPipelineService', () => {
  it('awaits async artifact event handlers before bus.emit resolves', async () => {
    const bus: IMakaioBus = createBusInstance();
    const service = new TransitionPipelineService(bus);
    await service.init();

    let handled = false;
    service.actionRegistry.register('pkg-transition', {
      'pkg-transition.capture': () => ({
        async execute() {
          await Promise.resolve();
          handled = true;
        },
      }),
    });
    service.ruleRegistry.register('pkg-transition', [
      {
        id: 'pkg-transition.capture-created',
        on: 'artifact.created',
        action: { type: 'pkg-transition.capture' },
        enabled: true,
      },
    ]);

    await bus.emit(ArtifactSubjects.created, { artifact: makeArtifact() });

    expect(handled).toBe(true);
    await service.destroy();
  });

  it('resolves status changed artifact refs before evaluating transition rules', async () => {
    const bus: IMakaioBus = createBusInstance();
    const service = new TransitionPipelineService(bus);
    const artifactRef = {
      refClass: 'artifact',
      kind: 'implementation-plan',
      id: 'artifact-1',
      revision: 'rev-7',
    } as const;
    const artifact = makeArtifact({
      revision: artifactRef.revision,
      scope: { level: 'project', ids: { projectId: 'workflow-api' } },
      data: { status: 'triage', branch: 'workflow-api' },
    });
    let resolvedRef: unknown;
    const capturedStart = new Promise<unknown>((resolve) => {
      bus.on(WorkflowSubjects.start, (ctx) => {
        resolve(ctx.payload);
        ctx.setResult({ executionId: 'wfx-status-transition' });
      });
    });
    bus.on(ArtifactSubjects.resolve, (ctx) => {
      resolvedRef = ctx.payload.ref;
      ctx.setResult({ artifact });
    });
    await service.init();

    service.ruleRegistry.register('pkg-transition', [
      {
        id: 'pkg-transition.start-from-status',
        on: 'artifact.status.changed',
        when: {
          $and: [
            { field: 'artifact.data.status', operator: 'triage' },
            { field: 'path', operator: '/data/status' },
            { field: 'current', operator: 'triage' },
          ],
        },
        action: {
          type: 'workflow.start',
          input: {
            workflowId: 'implementation',
            inputExpression:
              '{ artifactId: artifact.id, revision: artifact.revision, projectId: artifact.scope.ids.projectId, branch: artifact.data.branch, previousStatus: previous }',
          },
        },
        enabled: true,
      },
    ]);

    await bus.emit(ArtifactSubjects.status.changed, {
      artifact: artifactRef,
      path: '/data/status',
      previous: 'draft',
      current: 'triage',
    });

    expect(resolvedRef).toStrictEqual(artifactRef);
    await expect(capturedStart).resolves.toMatchObject({
      workflowId: 'implementation',
      input: {
        artifactId: 'artifact-1',
        revision: 'rev-7',
        projectId: 'workflow-api',
        branch: 'workflow-api',
        previousStatus: 'draft',
      },
    });
    await service.destroy();
  });

  it('resolves previous artifact revisions for revised transition rules', async () => {
    const bus: IMakaioBus = createBusInstance();
    const service = new TransitionPipelineService(bus);
    const previousRef = {
      refClass: 'artifact',
      kind: 'implementation-plan',
      id: 'artifact-1',
      revision: 'rev-1',
    } as const;
    const previousArtifact = makeArtifact({
      revision: previousRef.revision,
      data: { status: 'ready', queue: [{ id: 'existing', workflow: 'implementation' }] },
    });
    const revisedArtifact = makeArtifact({
      revision: 'rev-2',
      data: {
        status: 'ready',
        queue: [
          { id: 'existing', workflow: 'implementation' },
          { id: 'new', workflow: 'implementation' },
        ],
      },
    });
    const capturedStart = new Promise<unknown>((resolve) => {
      bus.on(WorkflowSubjects.start, (ctx) => {
        resolve(ctx.payload);
        ctx.setResult({ executionId: 'wfx-revised-transition' });
      });
    });
    bus.on(ArtifactSubjects.resolve, (ctx) => {
      expect(ctx.payload.ref).toStrictEqual(previousRef);
      ctx.setResult({ artifact: previousArtifact });
    });
    await service.init();

    service.ruleRegistry.register('pkg-transition', [
      {
        id: 'pkg-transition.start-from-revised',
        on: 'artifact.revised',
        when: {
          $expr:
            "(artifact.data.queue[.workflow == 'implementation' && !((previousArtifact.data.queue|pluck('id'))|includes(.id))]|length) > 0",
        },
        action: {
          type: 'workflow.start',
          input: {
            workflowId: 'implementation',
            inputExpression:
              "{ queue: artifact.data.queue[.workflow == 'implementation' && !((previousArtifact.data.queue|pluck('id'))|includes(.id))] }",
          },
        },
        enabled: true,
      },
    ]);

    await bus.emit(ArtifactSubjects.revised, {
      previous: previousRef,
      artifact: revisedArtifact,
    });

    await expect(capturedStart).resolves.toMatchObject({
      workflowId: 'implementation',
      input: {
        queue: [{ id: 'new', workflow: 'implementation' }],
      },
    });
    await service.destroy();
  });

  it('skips status transition evaluation when the artifact ref cannot be resolved', async () => {
    const bus: IMakaioBus = createBusInstance();
    const service = new TransitionPipelineService(bus);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let dispatchCount = 0;
    bus.on(ArtifactSubjects.resolve, (ctx) => {
      ctx.setResult({ artifact: null });
    });
    await service.init();
    service.actionRegistry.register('pkg-transition', {
      'pkg-transition.capture': () => ({
        async execute() {
          dispatchCount += 1;
        },
      }),
    });
    service.ruleRegistry.register('pkg-transition', [
      {
        id: 'pkg-transition.capture-status',
        on: 'artifact.status.changed',
        action: { type: 'pkg-transition.capture' },
        enabled: true,
      },
    ]);

    await bus.emit(ArtifactSubjects.status.changed, {
      artifact: { refClass: 'artifact', kind: 'implementation-plan', id: 'artifact-1', revision: 'missing-rev' },
      path: '/data/status',
      previous: 'draft',
      current: 'triage',
    });

    expect(dispatchCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not resolve status transition artifact'));
    warn.mockRestore();
    await service.destroy();
  });
});
