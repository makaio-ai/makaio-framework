import { describe, expect, it } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtractSubjectPayload } from '@makaio/core';
import { WorkflowRunContextSchema, type WorkflowDefinition, type WorkflowRunContext } from '@makaio/contracts';
import { createTestBusInstance, createTestCall } from '@makaio/test-utils';
import { bootstrapAuthorityLoadedState } from '../authority-state-bootstrap.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition } from './shared.js';

type SetRunContextPayload = ExtractSubjectPayload<typeof WorkflowStorageSubjects.setRunContext>;

function createRunContext(definitionSnapshot?: WorkflowDefinition): WorkflowRunContext {
  return WorkflowRunContextSchema.parse({
    executionId: 'execution-authority-bootstrap',
    workflowId: 'workflow-authority-bootstrap',
    source: { kind: 'path', path: '.factory/workflows/review.ts' },
    materializationSpec: {
      kind: 'workspace-snapshot',
      snapshotId: 'authority-bootstrap-snapshot',
      digest: 'sha256-authority-bootstrap',
      sourcePath: '.factory/workflows/review.ts',
    },
    ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
    inputs: {},
    triggerPayload: {},
    scope: { type: 'global' },
    coordinatorSessionId: 'session-authority-bootstrap',
    cancelSubject: 'workflow.execution-authority-bootstrap.cancel',
    env: {},
    createdAt: Date.now(),
  });
}

function createBus(runContext: WorkflowRunContext): {
  bus: IMakaioBus;
  writes: SetRunContextPayload[];
} {
  const bus = createTestBusInstance();
  const writes: SetRunContextPayload[] = [];
  bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
  bus.on(WorkflowStorageSubjects.setRunContext, (ctx) => {
    writes.push(ctx.payload);
    ctx.setResult({ executionId: runContext.executionId });
  });
  return { bus, writes };
}

function createStatefulDefinition(description = 'authority snapshot'): WorkflowDefinition {
  return {
    ...createWorkflowDefinition({ id: 'workflow-authority-bootstrap', description }),
    state: {
      schema: {
        type: 'object',
        properties: { source: { type: 'string' } },
        required: ['source'],
        additionalProperties: false,
      },
      initial: { source: 'authority' },
    },
  };
}

describe('bootstrapAuthorityLoadedState', () => {
  it('does not trust a worker-loaded definition when the authority has no snapshot', async () => {
    const definition = createStatefulDefinition();
    const { bus, writes } = createBus(createRunContext());

    await expect(
      bootstrapAuthorityLoadedState(createTestCall(), bus, 'execution-authority-bootstrap', definition),
    ).resolves.toBe(false);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.runContext.definitionSnapshot).toBeUndefined();
    expect(writes[0]?.runContext.terminalAuthority).toBe('authority');
    expect(writes[0]?.initialState).toBeUndefined();
  });

  it('retains a canonically equal authority-pinned snapshot', async () => {
    const storedDefinition = createStatefulDefinition();
    const workerDefinition = Object.fromEntries(
      Object.entries({ ...storedDefinition, omittedOptional: undefined }).reverse(),
    ) as WorkflowDefinition;
    const storedRunContext = createRunContext(storedDefinition);
    const { bus, writes } = createBus(storedRunContext);

    await expect(
      bootstrapAuthorityLoadedState(createTestCall(), bus, 'execution-authority-bootstrap', workerDefinition),
    ).resolves.toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.runContext.definitionSnapshot).toBe(storedRunContext.definitionSnapshot);
    expect(writes[0]?.initialState).toEqual(storedDefinition.state?.initial);
  });

  it('rejects a different worker definition before mutating authority state', async () => {
    const storedDefinition = createStatefulDefinition();
    const workerDefinition = createStatefulDefinition('worker replacement');
    const { bus, writes } = createBus(createRunContext(storedDefinition));

    await expect(
      bootstrapAuthorityLoadedState(createTestCall(), bus, 'execution-authority-bootstrap', workerDefinition),
    ).rejects.toThrow("Authority bootstrap definition mismatch for 'execution-authority-bootstrap'");

    expect(writes).toHaveLength(0);
  });
});
