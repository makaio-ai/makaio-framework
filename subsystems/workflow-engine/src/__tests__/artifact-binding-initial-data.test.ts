import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  defineWorkflow,
  type ArtifactRevision,
  type WorkflowArtifactBinding,
  type WorkflowRunContext,
} from '@makaio/contracts';
import { resolveWorkflowArtifactBinding } from '../artifact-context/artifact-binding.js';

/**
 * Exercise binding resolution on the real bus while recording its provider requests.
 * @param options - Definition expressions and optional start reference.
 * @returns Resolution entrypoint and recorded provider activity.
 */
function setup(options: { resolve?: string; create?: string; startRef?: boolean; missingRef?: boolean }) {
  const bus = createBusInstance();
  bus.registerNamespace(ArtifactNamespace);
  const binding = {
    kind: 'report',
    schemaVersion: 1,
    scope: { level: 'global' },
    ...(options.resolve !== undefined && { resolve: options.resolve }),
    ...(options.create !== undefined && { create: options.create }),
  } satisfies WorkflowArtifactBinding;
  const definition = defineWorkflow('report-binding')
    .artifact(binding)
    .station('noop', async () => null).definition;
  const existing: ArtifactRevision = {
    kind: 'report',
    id: 'existing-report',
    revision: 'existing-revision',
    schemaVersion: 1,
    scope: { level: 'global' },
    data: { title: 'Existing report' },
    relations: [],
    actor: { kind: 'system', id: 'test' },
    timestamp: 1,
  };
  const createdData: Record<string, unknown>[] = [];
  const queries: unknown[] = [];
  bus.on(ArtifactSubjects.query, (ctx) => {
    queries.push(ctx.payload);
    ctx.setResult({ artifacts: options.missingRef ? [] : [existing] });
  });
  bus.on(ArtifactSubjects.create, (ctx) => {
    createdData.push(ctx.payload.data);
    ctx.setResult({ artifact: { ...existing, id: 'created-report', data: ctx.payload.data } });
  });
  const execution = {
    id: 'execution-1',
    workflowId: definition.id,
    status: 'running' as const,
    inputs: {},
    startedAt: 1,
    scope: { type: 'global' as const },
  };
  const runContext: WorkflowRunContext = {
    executionId: execution.id,
    workflowId: definition.id,
    source: { kind: 'definition', workflowId: definition.id },
    definitionSnapshot: definition,
    workerManifest: { contributionRefs: [] },
    inputs: { title: 'New report' },
    scope: { type: 'global' },
    triggerPayload: {},
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.execution-1.cancel',
    env: {},
    createdAt: 1,
    suspensionStrategy: 'wait-in-process',
    ...(options.startRef && { artifactRef: { kind: existing.kind, id: existing.id } }),
  };
  return {
    resolve: () => resolveWorkflowArtifactBinding({ definition, execution, runContext, bus }),
    createdData,
    queries,
  };
}

describe('workflow artifact binding requires explicit creation data', () => {
  it.each([
    {},
    { resolve: 'null' },
    { resolve: 'inputs.missing' },
    { create: 'inputs.missing' },
    { create: 'null' },
  ])('rejects missing data before any create RPC: %j', async (options) => {
    const fixture = setup(options);
    await expect(fixture.resolve()).rejects.toThrow('requires an existing artifact reference or explicit initial data');
    expect(fixture.createdData).toEqual([]);
  });

  it('resolves a start reference with neither definition expression', async () => {
    const fixture = setup({ startRef: true });
    expect((await fixture.resolve())?.current.id).toBe('existing-report');
    expect(fixture.queries).toEqual([{ kind: 'report', ids: ['existing-report'], currentOnly: true }]);
    expect(fixture.createdData).toEqual([]);
  });

  it('resolves an existing reference without a create expression', async () => {
    const fixture = setup({ resolve: '{ kind: "report", id: "existing-report" }' });
    expect((await fixture.resolve())?.current.id).toBe('existing-report');
    expect(fixture.createdData).toEqual([]);
  });

  it('does not create a replacement when a supplied reference is missing', async () => {
    const fixture = setup({ startRef: true, missingRef: true, create: '{ title: inputs.title }' });
    await expect(fixture.resolve()).rejects.toThrow('could not be resolved');
    expect(fixture.createdData).toEqual([]);
  });

  it('forwards explicit create data for normal Kind validation without synthesizing content', async () => {
    const fixture = setup({ resolve: 'null', create: '{ title: inputs.title }' });
    expect((await fixture.resolve())?.current.data).toEqual({ title: 'New report' });
    expect(fixture.createdData).toEqual([{ title: 'New report' }]);
  });

  it.each(['42', '"text"'])('rejects non-object create expression %s', async (create) => {
    const fixture = setup({ create });
    await expect(fixture.resolve()).rejects.toThrow('must return an object');
    expect(fixture.createdData).toEqual([]);
  });
});
