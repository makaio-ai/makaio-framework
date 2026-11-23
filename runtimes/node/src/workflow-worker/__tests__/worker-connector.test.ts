import { expect, it } from 'vitest';
import { runWorkflowInWorker } from '../worker-entry.js';

it('lets a host connector refuse a parsed run before any workflow module is loaded', async () => {
  const refusal = new Error('host requires runtime registration');
  let executionId: string | undefined;
  const params = {
    kind: 'unbound' as const,
    config: {
      source: { kind: 'path', path: '/never-load-this-module.ts' },
      executionId: 'run-with-connector',
      workflowId: 'connector-workflow',
      cancelSubject: 'workflow.run-with-connector.cancel',
      coordinatorSessionId: 'session',
    },
    manifest: { contributionRefs: [] },
    contributionEntrypoints: [],
  };

  await expect(
    runWorkflowInWorker(params, async ({ config, controller, createConnection }) => {
      executionId = config.executionId;
      expect(controller.signal.aborted).toBe(false);
      const acquired = createConnection('opaque-identity');
      try {
        await acquired.connect(controller.signal);
      } finally {
        await acquired.close();
      }
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(executionId).toBe('run-with-connector');
});
