import { describe, expect, it } from 'vitest';
import type { WorkerProvisionRequest, WorkflowWorkerConfig } from '@makaio/contracts';
import { buildWorkflowAttemptInstruction } from '@makaio/subsystem-workflow-engine';
import { createWorkflowLaunchResolver } from '../workflow-launch-resolver.js';
import { makeWorkerConfig } from './fixtures.js';

function request(executionId: string, executionAttemptId: string): WorkerProvisionRequest {
  return {
    executionId,
    executionAttemptId,
    environment: 'piscina',
    runtimeInputs: {
      workerManifest: {
        contributionRefs: [
          {
            packageName: 'example',
            version: '1.0.0',
            entrypoint: 'worker.mjs',
            integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
          },
        ],
      },
      suspensionStrategy: 'exit-and-redispatch',
    },
    connection: {
      busUrl: 'ws://worker.example/bus',
      busAuth: { kind: 'hmac', secret: 'worker-connection-secret' },
      env: { PRIVATE_VALUE: 'resolved-for-this-worker' },
    },
    provisioningStartedAt: '2026-09-09T10:00:00.000Z',
    bootstrapDeadlineAt: '2026-09-09T10:02:00.000Z',
  };
}

function canonicalInstruction(config: WorkflowWorkerConfig) {
  return buildWorkflowAttemptInstruction({
    id: 'instruction-1',
    revision: 'revision-1',
    config,
    preservation: { required: [] },
  });
}

describe('createWorkflowLaunchResolver', () => {
  it('reconstructs workflow semantics from the canonical instruction and runtime connection', async () => {
    const config = makeWorkerConfig({
      source: { kind: 'source', filename: 'workflows/example.ts', source: 'export default {};' },
      triggerPayload: { issue: 'FACT-68' },
      triggerMode: 'await-trigger',
      inputs: { dryRun: false },
      config: { command: 'yarn test' },
    });
    const instruction = canonicalInstruction(config);
    const resolve = createWorkflowLaunchResolver(async () => instruction);

    await expect(resolve(request('wfx-1', 'attempt-1'), new AbortController().signal)).resolves.toMatchObject({
      source: config.source,
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      triggerPayload: config.triggerPayload,
      triggerMode: 'await-trigger',
      inputs: config.inputs,
      config: config.config,
      scope: config.scope,
      coordinatorSessionId: config.coordinatorSessionId,
      cancelSubject: config.cancelSubject,
      terminalAuthority: 'authority',
      suspensionStrategy: 'exit-and-redispatch',
      busUrl: 'ws://worker.example/bus',
      busAuth: { kind: 'hmac', secret: 'worker-connection-secret' },
      env: { PRIVATE_VALUE: 'resolved-for-this-worker' },
    });
  });

  it('rejects a non-workflow instruction before a Piscina worker starts', async () => {
    const resolve = createWorkflowLaunchResolver(async () => ({
      id: 'instruction-2',
      revision: 'revision-1',
      workload: { kind: 'report', version: '1', input: { format: 'markdown' } },
      preservation: { required: [] },
    }));

    await expect(resolve(request('wfx-1', 'attempt-2'), new AbortController().signal)).rejects.toThrow(
      'does not target the supported workflow workload adapter',
    );
  });
});
