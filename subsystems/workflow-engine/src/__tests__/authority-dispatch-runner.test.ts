import { describe, expect, it } from 'vitest';
import { runAuthorityDispatchedAttempt } from '../authority-dispatch-runner.js';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { submitAttemptOutcome } from '../outcome-convergence.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
import { driveTestAttemptToAllocated, makeTestInstruction } from '../testing/attempt-fixtures.js';
import { workflowAttemptOutcomeCodec, type WorkflowAttemptOutcome } from '../workflow-attempt-outcome.js';

const executionId = 'owner-1';
const outcome: WorkflowAttemptOutcome = { kind: 'technical-failure', stage: 'startup', message: 'Adapter unavailable' };

describe('Authority-dispatched Attempt instruction', () => {
  it('persists the complete instruction before dispatch and returns the canonical owner outcome', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const instruction = makeTestInstruction();
    const completion = await runAuthorityDispatchedAttempt({
      authority,
      executionId,
      instruction,
      dispatch: async (executionAttemptId) => {
        expect(await authority.getInstruction({ executionId, executionAttemptId })).toEqual(instruction);
        instruction.revision = 'changed-after-creation';
        expect((await authority.getInstruction({ executionId, executionAttemptId }))?.revision).toBe('1');
        await submitAttemptOutcome(
          { authority, convergence: { converge: async () => 'projected' } },
          { executionId, executionAttemptId, outcome },
        );
      },
    });
    expect(completion).toEqual({
      outcome,
      acceptance: 'projected',
      controlObservation: { controlRevision: 0, cancellation: null },
    });
    expect([...repository.committedOutcomes.values()]).toEqual([JSON.stringify(outcome)]);
  });

  it('does not dispatch or create an Attempt when the assignment is invalid', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    let dispatched = false;
    await expect(
      runAuthorityDispatchedAttempt({
        authority,
        executionId,
        instruction: makeTestInstruction({ id: '' }),
        dispatch: async () => {
          dispatched = true;
        },
      }),
    ).rejects.toThrow();
    expect(dispatched).toBe(false);
    expect(repository.attempts.size).toBe(0);
  });

  it('retains the existing pre-allocation abandonment behavior', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    await expect(
      runAuthorityDispatchedAttempt({
        authority,
        executionId,
        instruction: makeTestInstruction(),
        dispatch: async () => {
          throw new Error('Dispatch unavailable');
        },
      }),
    ).rejects.toThrow('Dispatch unavailable');
    const attempt = [...repository.attempts.values()][0];
    expect(attempt).toMatchObject({ status: 'settled', settlementKind: 'abandoned' });
    expect(authority.waitForOutcome(attempt!.executionAttemptId)).toBeUndefined();
    expect(repository.committedOutcomes.size).toBe(0);
  });

  it('returns the committed outcome after a lost dispatch acknowledgement instead of abandoning allocated work', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const completion = await runAuthorityDispatchedAttempt({
      authority,
      executionId,
      instruction: makeTestInstruction(),
      dispatch: async (executionAttemptId) => {
        await driveTestAttemptToAllocated(authority, executionAttemptId, executionId);
        await submitAttemptOutcome(
          { authority, convergence: { converge: async () => 'projected' } },
          { executionId, executionAttemptId, outcome },
        );
        throw new Error('Dispatch acknowledgement lost');
      },
    });
    expect(completion).toEqual({
      outcome,
      acceptance: 'projected',
      controlObservation: { controlRevision: 0, cancellation: null },
    });
    expect([...repository.attempts.values()][0]).toMatchObject({ status: 'settled', settlementKind: 'outcome' });
  });
});
