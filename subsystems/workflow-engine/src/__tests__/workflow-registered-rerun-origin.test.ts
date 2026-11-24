import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { WorkflowErrorCode, type WorkflowDefinition } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { waitForRunnerAbort } from './workflow-public-test-utils.js';

describe('registered executable source replay origin', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest({
      workflowRunner: {
        run(_call, config, signal) {
          return waitForRunnerAbort(config, signal);
        },
      },
    });
    setup.cleanupFns.push(
      setup.workflowExecutor.registerWorkflowMaterializationSpecResolver({
        async resolve(_call, { sourcePath }) {
          return {
            kind: 'workspace-snapshot',
            snapshotId: 'registered-replay-origin',
            digest: 'sha256:registered-replay-origin',
            sourcePath,
          };
        },
      }),
    );
  });

  afterEach(async () => teardownWorkflowExecutorTest(setup));

  const cases = [
    {
      kind: 'path',
      originalSource: { kind: 'path', path: 'workflows/v1.ts' },
      currentSource: { kind: 'path', path: 'workflows/v2.ts' },
    },
    {
      kind: 'source',
      originalSource: { kind: 'source', filename: 'v1.ts', source: 'export default {};' },
      currentSource: { kind: 'source', filename: 'v2.ts', source: 'export default {};' },
    },
  ] as const;

  describe.each(cases)('$kind executable source', ({ originalSource, currentSource }) => {
    const original: WorkflowDefinition = {
      ...createWorkflowDefinition({ id: 'registered-executable-replay', name: 'Registered v1' }),
      executableSource: originalSource,
    };
    const current: WorkflowDefinition = { ...original, name: 'Registered v2', executableSource: currentSource };

    it('uses the latest registered definition and keeps the first snapshot', async () => {
      const call = createTestCall();
      await MakaioBus.request(call, WorkflowSubjects.setDefinition, { workflow: original });
      const { executionId } = await MakaioBus.request(call, WorkflowSubjects.start, { workflowId: original.id });
      await MakaioBus.request(call, WorkflowSubjects.setDefinition, { workflow: current });
      const snapshot = await MakaioBus.request(call, WorkflowSubjects.rerun, { executionId, mode: 'snapshot' });
      await expect(MakaioBus.request(call, WorkflowStorageSubjects.getRunContext, snapshot)).resolves.toMatchObject({
        runContext: { workflowId: original.id, source: originalSource, definitionSnapshot: { name: original.name } },
      });

      const replay = await MakaioBus.request(call, WorkflowSubjects.rerun, { executionId, mode: 'current' });
      await expect(MakaioBus.request(call, WorkflowStorageSubjects.getRunContext, replay)).resolves.toMatchObject({
        runContext: { workflowId: original.id, source: currentSource, definitionSnapshot: { name: current.name } },
      });
    });

    it('reports a deleted registered definition', async () => {
      const call = createTestCall();
      await MakaioBus.request(call, WorkflowSubjects.setDefinition, { workflow: original });
      const { executionId } = await MakaioBus.request(call, WorkflowSubjects.start, { workflowId: original.id });
      await expect(MakaioBus.request(call, WorkflowSubjects.deleteDefinition, { id: original.id })).resolves.toEqual({
        deleted: true,
      });
      await expect(
        MakaioBus.request(call, WorkflowSubjects.rerun, { executionId, mode: 'current' }),
      ).rejects.toMatchObject({
        cause: { code: WorkflowErrorCode.DEFINITION_NOT_FOUND, message: `Workflow not found: ${original.id}` },
      });
    });
  });
});
