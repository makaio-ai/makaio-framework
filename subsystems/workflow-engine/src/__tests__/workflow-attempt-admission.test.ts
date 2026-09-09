import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { IWorkflowRunner } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { runAuthorityDispatchedAttempt } from '../authority-dispatch-runner.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createInMemoryAttemptRepository, makeTestInstruction } from '../testing/index.js';
import { workflowAttemptOutcomeCodec } from '../workflow-attempt-outcome.js';
import { createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('workflow owner attempt admission', () => {
  let setup: WorkflowExecutorTestSetup | undefined;
  afterEach(async () => {
    if (setup !== undefined) await teardownWorkflowExecutorTest(setup);
    setup = undefined;
  });

  it.each([
    'cancellation-first',
    'creation-first',
  ] as const)('serializes %s without dispatching uncancellable work', async (order) => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runnerFinished = Promise.withResolvers<void>();
    const authority = new ExecutionAttemptAuthority(
      {
        ...repository,
        async createAttempt(input) {
          if (order === 'creation-first') {
            entered.resolve();
            await release.promise;
          }
          return repository.createAttempt(input);
        },
      },
      { bootstrapTimeoutMs: 60_000 },
    );
    let dispatched = false;
    const runner: IWorkflowRunner = {
      async run(config, _signal, _manifest, options) {
        if (order === 'cancellation-first') {
          entered.resolve();
          await release.promise;
        }
        try {
          if (options?.withAttemptCreation === undefined) throw new Error('Owner admission is required');
          await runAuthorityDispatchedAttempt({
            authority,
            executionId: config.executionId,
            instruction: makeTestInstruction(),
            withAttemptCreation: options.withAttemptCreation,
            async dispatch() {
              dispatched = true;
              throw new Error('Stop before provider side effects');
            },
          });
          throw new Error('Unexpected successful workload');
        } finally {
          runnerFinished.resolve();
        }
      },
    };
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority, workflowRunner: runner });
    const definition = createWorkflowDefinition();
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: definition.id });
    await entered.promise;
    const cancellation = MakaioBus.request(WorkflowSubjects.cancel, { executionId, reason: 'operator' });
    try {
      if (order === 'cancellation-first') await expect(cancellation).resolves.toEqual({ cancelled: true });
      release.resolve();
      await expect(cancellation).resolves.toEqual({ cancelled: true });
      await runnerFinished.promise;
      if (order === 'cancellation-first') {
        expect(repository.attempts.size).toBe(0);
        expect(dispatched).toBe(false);
      } else {
        expect(repository.attempts.size).toBe(1);
        const [attempt] = repository.attempts.values();
        expect(await authority.readCancellation(attempt.executionAttemptId)).toMatchObject({ reason: 'operator' });
        expect(attempt.operationStartGate).toBe('closed');
      }
      expect((await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution).toMatchObject({
        status: 'cancelled',
      });
    } finally {
      release.resolve();
      await cancellation;
    }
  });
});
