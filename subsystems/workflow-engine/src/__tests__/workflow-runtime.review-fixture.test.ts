import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { codeStep, defineWorkflow, WorkflowNamespace } from '@makaio/contracts';
import { executeSequence } from '../runtime/primitive-runtime.js';
import { createLocalTestRuntimeContext, registerInMemoryFrameStore } from './shared.js';

describe('review workflow fixture — parallel branch outputs in WorkLog', () => {
  it('each parallel delegate branch output is individually accessible in the parallel output', async () => {
    const bus = createBusInstance();
    registerInMemoryFrameStore(bus);
    bus.registerNamespace(WorkflowNamespace);

    const specFindings = [{ id: 's1', severity: 'info' as const, message: 'Spec OK' }];
    const qualityFindings = [{ id: 'q1', severity: 'warning' as const, message: 'Quality warning' }];
    const testCoverageFindings = [{ id: 'c1', severity: 'info' as const, message: 'Coverage OK' }];

    let capturedBranchOutputs: Record<string, { status: string; value?: unknown }> | undefined;

    const built = defineWorkflow('review-workflow')
      .parallel('review-delegates', { mode: 'all-settled' }, [
        codeStep('spec-review', () => ({ findings: specFindings })),
        codeStep('quality-review', () => ({ findings: qualityFindings })),
        codeStep('test-coverage-review', () => ({ findings: testCoverageFindings })),
      ])
      .codeStep('aggregate', (ctx) => {
        const parallelResult = ctx.previousSteps['review-delegates'] as
          | { output: { branches: Record<string, { status: string; value?: unknown }> } }
          | undefined;
        capturedBranchOutputs = parallelResult?.output?.branches;
        return null;
      });

    const runtimeCtx = createLocalTestRuntimeContext(
      'exec-review-worklog-test',
      'review-workflow',
      built.definition,
      {
        id: 'exec-review-worklog-test',
        workflowId: 'review-workflow',
        status: 'running',
        inputs: {},
        startedAt: Date.now(),
        scope: { type: 'global' },
      },
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
    );

    const outcome = await executeSequence(createTestCall(), built.definition.root, runtimeCtx, {
      inputs: {},
      trigger: {},
      frames: {},
      previousSteps: {},
    });

    expect(outcome.status).toBe('completed');
    expect(capturedBranchOutputs).toBeDefined();

    // Each branch should be fulfilled with delegate output.
    expect(capturedBranchOutputs?.['spec-review']).toMatchObject({ status: 'fulfilled' });
    expect(capturedBranchOutputs?.['quality-review']).toMatchObject({ status: 'fulfilled' });
    expect(capturedBranchOutputs?.['test-coverage-review']).toMatchObject({ status: 'fulfilled' });

    // Raw findings accessible per branch.
    const specBranch = capturedBranchOutputs?.['spec-review'] as { status: string; value?: { findings: unknown[] } };
    expect(specBranch.value?.findings).toHaveLength(1);
    expect((specBranch.value?.findings[0] as { id: string })?.id).toBe('s1');
  });
});
