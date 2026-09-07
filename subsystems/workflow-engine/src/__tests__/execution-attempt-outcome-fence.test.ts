import { describe, expect, it } from 'vitest';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { RuntimeOutcomeFenceMismatchError, type RuntimeOutcomeFence } from '../execution-attempt-repository.js';
import { submitAttemptOutcome } from '../outcome-convergence.js';
import { allocateTestAttempt } from '../testing/attempt-fixtures.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
import { counterCodec } from './counter-outcome.js';

/**
 * Build a real allocated attempt with a registered, ready runtime.
 * @returns Real authority/repository and a recording owner convergence boundary.
 */
async function createHarness() {
  const repository = createInMemoryAttemptRepository(counterCodec);
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
  const executionId = 'owner';
  const executionAttemptId = await allocateTestAttempt(authority, executionId);
  const identity = { executionId, executionAttemptId };
  expect(await authority.registerRuntime({ ...identity, runtimeIncarnationId: 'first' })).toEqual({
    kind: 'registered',
    runtimeGeneration: 1,
  });
  await authority.markRuntimeReady({ ...identity, runtimeGeneration: 1, readyAt: new Date().toISOString() });
  const converged: number[] = [];
  const convergence = {
    async converge(input: { outcome: number }) {
      converged.push(input.outcome);
    },
  };
  return { repository, authority, identity, converged, convergence };
}

describe('runtime outcome commit fence', () => {
  it('does not commit a delayed startup failure against a replacement or reject its waiter', async () => {
    const { repository, authority, identity, convergence, converged } = await createHarness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtimeFence: RuntimeOutcomeFence = { runtimeGeneration: 1, operationId: null };
    const waiter = authority.waitForOutcome(identity.executionAttemptId);
    let settled = false;
    void waiter?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const submission = submitAttemptOutcome(
      {
        authority,
        convergence,
        validation: {
          async validate() {
            entered.resolve();
            await release.promise;
          },
        },
      },
      { ...identity, outcome: 1, runtimeFence },
    );
    await entered.promise;
    expect(await authority.registerRuntime({ ...identity, runtimeIncarnationId: 'replacement' })).toEqual({
      kind: 'registered',
      runtimeGeneration: 2,
    });
    release.resolve();
    await expect(submission).rejects.toBeInstanceOf(RuntimeOutcomeFenceMismatchError);
    expect(repository.committedOutcomes.has(identity.executionAttemptId)).toBe(false);
    expect(converged).toEqual([]);
    expect(settled).toBe(false);
    expect((await authority.getAttemptControlState(identity.executionAttemptId))?.operationStartGate).toBe('open');

    expect(
      await submitAttemptOutcome(
        { authority, convergence },
        {
          ...identity,
          outcome: 2,
          runtimeFence: { runtimeGeneration: 2, operationId: null },
        },
      ),
    ).toBe('accepted');
    await expect(waiter).resolves.toBe(2);
  });

  it('rechecks the active operation after awaited validation', async () => {
    const { repository, authority, identity, convergence } = await createHarness();
    const admission = await authority.admitOperation({
      ...identity,
      runtimeGeneration: 1,
      operationKind: 'workflow-run',
      admissionKey: 'first-operation',
    });
    if (admission.kind !== 'admitted') throw new Error(`Expected admission, got ${admission.kind}`);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const submission = submitAttemptOutcome(
      {
        authority,
        convergence,
        validation: {
          async validate() {
            entered.resolve();
            await release.promise;
          },
        },
      },
      { ...identity, outcome: 1, runtimeFence: { runtimeGeneration: 1, operationId: admission.operationId } },
    );
    await entered.promise;
    expect(
      await authority.completeOperation({
        executionAttemptId: identity.executionAttemptId,
        operationId: admission.operationId,
        runtimeGeneration: 1,
      }),
    ).toEqual({ kind: 'completed' });
    const next = await authority.admitOperation({
      ...identity,
      runtimeGeneration: 1,
      operationKind: 'workload-invocation',
      admissionKey: 'next-operation',
    });
    if (next.kind !== 'admitted') throw new Error(`Expected admission, got ${next.kind}`);
    release.resolve();
    await expect(submission).rejects.toBeInstanceOf(RuntimeOutcomeFenceMismatchError);
    expect(repository.committedOutcomes.has(identity.executionAttemptId)).toBe(false);
    expect((await authority.getAttemptControlState(identity.executionAttemptId))?.activeOperationId).toBe(
      next.operationId,
    );
  });

  it('retries owner convergence after committed acceptance without re-evaluating a fresh-commit fence', async () => {
    const { authority, identity, convergence, converged } = await createHarness();
    const waiter = authority.waitForOutcome(identity.executionAttemptId);
    await expect(
      submitAttemptOutcome(
        {
          authority,
          convergence: {
            async converge() {
              throw new Error('owner temporarily unavailable');
            },
          },
        },
        { ...identity, outcome: 1, runtimeFence: { runtimeGeneration: 1, operationId: null } },
      ),
    ).rejects.toThrow('owner temporarily unavailable');
    // Canonical acceptance has already won. A duplicate still converges that stored
    // answer; a conflicting value remains conflict rather than a runtime-fence error.
    expect(
      await submitAttemptOutcome(
        { authority, convergence },
        {
          ...identity,
          outcome: 1,
          runtimeFence: { runtimeGeneration: 99, operationId: 'obsolete' },
        },
      ),
    ).toBe('duplicate');
    expect(converged).toEqual([1]);
    await expect(waiter).resolves.toBe(1);
  });

  it('snapshots the expected runtime slot before asynchronous owner validation', async () => {
    const { authority, identity, convergence } = await createHarness();
    const runtimeFence = { runtimeGeneration: 1, operationId: null };
    const submission = submitAttemptOutcome(
      {
        authority,
        convergence,
        validation: {
          async validate() {
            await authority.registerRuntime({ ...identity, runtimeIncarnationId: 'replacement' });
            runtimeFence.runtimeGeneration = 2;
          },
        },
      },
      { ...identity, outcome: 1, runtimeFence },
    );
    await expect(submission).rejects.toBeInstanceOf(RuntimeOutcomeFenceMismatchError);
  });
});
