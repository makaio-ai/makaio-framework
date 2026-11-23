import { createBusInstance } from '@makaio/bus-core';
import { ReviewSubjects, WorkflowSubjects, type Party, type WorkflowDefinition } from '@makaio/contracts';
import { AutomationTriggerBindingRuntime, AutomationTriggerRegistry } from '@makaio/services-core/automation-trigger';
import { WorkflowStorageSubjects, WorkflowTriggerReconciler } from '@makaio/subsystem-workflow-engine';
import { createTestCall } from '@makaio/test-utils';
import { expect, it } from 'vitest';
import { CODERABBIT_REVIEW_POSTED_TRIGGER_KIND, createCodeRabbitReviewPostedTrigger } from '../automation-trigger.js';

it('preserves each findings arrival principal through the lookup and workflow start', async ({ onTestFinished }) => {
  const bus = createBusInstance();
  const registry = new AutomationTriggerRegistry(bus);
  const runtime = new AutomationTriggerBindingRuntime({
    resolveRegistration: (kind) => registry.resolveRegistration(kind),
  });
  const reconciler = new WorkflowTriggerReconciler(bus, () => runtime);
  const target = { repository: 'owner/repo', prNumber: 7 };
  const workflow: WorkflowDefinition = {
    id: 'review-posted-workflow',
    scope: { type: 'global' },
    root: { type: 'sequence', id: 'root', nodes: [] },
    triggers: [{ kind: CODERABBIT_REVIEW_POSTED_TRIGGER_KIND, params: { repository: target.repository } }],
  };
  const lookups: Party[] = [];
  const starts: Array<{ workflowId: string; principal: Party }> = [];
  const unsubscribe = [
    bus.on(WorkflowStorageSubjects.list, (ctx) => ctx.setResult({ workflows: [workflow] })),
    bus.on(ReviewSubjects.findings.list, (ctx) => {
      lookups.push(ctx.call.principal);
      ctx.setResult({ findings: [] });
    }),
    bus.on(WorkflowSubjects.start, (ctx) => {
      starts.push({ workflowId: ctx.payload.workflowId, principal: ctx.call.principal });
      ctx.setResult({ executionId: 'review-posted-execution' });
    }),
  ];
  onTestFinished(async () => {
    await reconciler.destroy();
    await runtime.close();
    await registry.destroy();
    unsubscribe.forEach((detach) => detach());
  });

  await registry.init();
  await registry.register('coderabbit', [createCodeRabbitReviewPostedTrigger(bus)]);
  await reconciler.init();

  const calls = [
    createTestCall({ principal: { kind: 'test.reviewer', id: 'first-reviewer' } }),
    createTestCall({ principal: { kind: 'test.reviewer', id: 'second-reviewer' } }),
  ];
  for (const call of calls) {
    await bus.emit(call, ReviewSubjects.findings.arrived, {
      target,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 1,
      updated: 0,
    });
  }

  expect(lookups).toEqual(calls.map((call) => call.principal));
  expect(starts).toEqual(calls.map((call) => ({ workflowId: workflow.id, principal: call.principal })));
});
