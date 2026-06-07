import { describe, expect, it } from 'vitest';
import { WorkflowRunContextSchema } from '@makaio/contracts';
import { buildDefinitionRunnerParamsFromRunContext } from '../workflow-runner-tasks.js';
import { createWorkflowDefinition } from './shared.js';

describe('buildDefinitionRunnerParamsFromRunContext', () => {
  it('preserves durable dispatch metadata when marking a resume dispatch', () => {
    const workflow = createWorkflowDefinition({ id: 'wf-resume-metadata' });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: 'exec-resume-metadata',
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: workflow,
      workerManifest: { packages: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-resume-metadata',
      executionHints: { requirements: { capabilities: ['workflow.remote'] } },
      dispatchMetadata: { poolId: 'pool-original', provider: 'github-actions' },
      cancelSubject: 'workflow.exec-resume-metadata.cancel',
      context: {
        repoPath: '/repo',
        makaioHome: '/home/.makaio',
        os: 'darwin',
        arch: 'arm64',
      },
      env: {},
      createdAt: Date.now(),
      suspensionStrategy: 'exit-and-resume',
    });

    const params = buildDefinitionRunnerParamsFromRunContext(runContext, workflow, { resume: true });

    expect(params.dispatchMetadata).toEqual({
      poolId: 'pool-original',
      provider: 'github-actions',
      resume: true,
    });
  });
});
