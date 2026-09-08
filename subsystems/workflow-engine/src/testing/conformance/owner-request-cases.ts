import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import {
  DuplicateExecutionAttemptError,
  type EnsureExecutionAttemptPersistenceInput,
} from '../../execution-attempt-repository.js';
import { makeTestInstruction, makeTestWorkflowResult } from '../attempt-fixtures.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

type GetHarness = () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>;

/**
 * Build a fresh owner demand and Authority-supplied candidate.
 * @returns Valid input with an opaque owner-scoped key.
 */
function request(): EnsureExecutionAttemptPersistenceInput {
  return {
    ...nextIds(),
    requestKey: 'initial-demand',
    instruction: makeTestInstruction(),
    bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
  };
}

/**
 * Register replayable owner-request requirements against both controllers.
 * @param getHarness - Current suite's initialized realization.
 */
export function registerOwnerRequestCases(getHarness: GetHarness): void {
  registerRequestRaces(getHarness);
  registerRequestAtomicity(getHarness);
  registerHistoricalRequests(getHarness);
  registerRequestSnapshots(getHarness);
}

/**
 * Register concurrent request uniqueness and owner-scoping checks.
 * @param getHarness - Current suite's initialized realization.
 */
function registerRequestRaces(getHarness: GetHarness): void {
  it('creates one attempt for concurrent and sequential same-owner request replays', async () => {
    const { repository, peer } = getHarness();
    const input = request();
    const contender = { ...input, executionAttemptId: `${input.executionAttemptId}-contender` };
    const decisions = await Promise.all([repository.ensureAttempt(input), peer.ensureAttempt(contender)]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['created', 'replayed']);
    const winner = decisions.find((decision) => decision.kind === 'created');
    if (winner?.kind !== 'created') throw new Error('Expected one created attempt');
    for (const controller of [repository, peer]) {
      expect(await controller.ensureAttempt(input)).toEqual({ kind: 'replayed', attempt: winner.attempt });
      expect(await controller.getActiveAttempt(input.executionId, winner.attempt.executionAttemptId)).toEqual(
        winner.attempt,
      );
      const unusedId =
        winner.attempt.executionAttemptId === input.executionAttemptId
          ? contender.executionAttemptId
          : input.executionAttemptId;
      expect(await controller.readAttemptSettlement({ ...input, executionAttemptId: unusedId })).toEqual({
        kind: 'not-found',
      });
    }
  });

  it('commits one winner and one conflict for competing instructions under the same request', async () => {
    const { repository, peer } = getHarness();
    const first = request();
    const second = {
      ...first,
      executionAttemptId: `${first.executionAttemptId}-other`,
      instruction: makeTestInstruction({ revision: '2' }),
    };
    const decisions = await Promise.all([repository.ensureAttempt(first), peer.ensureAttempt(second)]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['conflict', 'created']);
    for (const [index, input] of [first, second].entries()) {
      const decision = decisions[index];
      if (!decision) throw new Error('Expected both request decisions');
      expect(await peer.ensureAttempt(input)).toEqual(
        decision.kind === 'created' ? { kind: 'replayed', attempt: decision.attempt } : { kind: 'conflict' },
      );
      if (decision.kind === 'conflict') {
        expect(await repository.readAttemptSettlement(input)).toEqual({ kind: 'not-found' });
      }
    }
  });

  it('keeps opaque owner and request components independent without delimiter collisions', async () => {
    const { repository, peer } = getHarness();
    const base = request();
    const inputs = [
      { ...base, executionId: `${base.executionId}:part`, requestKey: 'key' },
      {
        ...base,
        executionId: base.executionId,
        requestKey: 'part:key',
        executionAttemptId: `${base.executionAttemptId}-pair`,
      },
      {
        ...base,
        executionId: `${base.executionId}-other`,
        requestKey: 'key',
        executionAttemptId: `${base.executionAttemptId}-owner`,
      },
    ];
    for (const input of inputs)
      expect(await repository.ensureAttempt(input)).toMatchObject({
        kind: 'created',
        attempt: { executionId: input.executionId, executionAttemptId: input.executionAttemptId },
      });
    for (const input of inputs)
      expect(await peer.ensureAttempt(input)).toMatchObject({
        kind: 'replayed',
        attempt: { executionId: input.executionId, executionAttemptId: input.executionAttemptId },
      });
  });
}

/**
 * Register rejection atomicity without reserved keys or predecessor changes.
 * @param getHarness - Current suite's initialized realization.
 */
function registerRequestAtomicity(getHarness: GetHarness): void {
  it.each<Partial<EnsureExecutionAttemptPersistenceInput>>([
    { executionId: '' },
    { requestKey: '' },
    { executionAttemptId: '' },
    { bootstrapTimeoutMs: 0 },
    { bootstrapTimeoutMs: Number.POSITIVE_INFINITY },
    { instruction: makeTestInstruction({ revision: '' }) },
  ])('rejects invalid owner requests before consuming keys or fencing predecessors: %j', async (invalid) => {
    const { repository, peer } = getHarness();
    const first = request();
    const predecessor = await repository.createAttempt(first);
    const input = { ...first, executionAttemptId: `${first.executionAttemptId}-next` };
    await expect(peer.ensureAttempt({ ...input, ...invalid })).rejects.toThrow();
    expect(await repository.getActiveAttempt(first.executionId, first.executionAttemptId)).toEqual(predecessor);
    expect(await peer.readAttemptSettlement(input)).toEqual({ kind: 'not-found' });
    expect(await repository.ensureAttempt(input)).toMatchObject({ kind: 'created' });
  });

  it('preserves a predecessor and leaves a colliding candidate request unbound', async () => {
    const { repository, peer } = getHarness();
    const input = request();
    const predecessor = await repository.createAttempt(input);
    await expect(peer.ensureAttempt(input)).rejects.toThrow(DuplicateExecutionAttemptError);
    expect(await repository.getActiveAttempt(input.executionId, input.executionAttemptId)).toEqual(predecessor);
    const fresh = { ...input, executionAttemptId: `${input.executionAttemptId}-fresh` };
    expect(await peer.ensureAttempt(fresh)).toMatchObject({
      kind: 'created',
      attempt: { executionAttemptId: fresh.executionAttemptId },
    });
    expect(await repository.ensureAttempt(input)).toMatchObject({
      kind: 'replayed',
      attempt: { executionAttemptId: fresh.executionAttemptId },
    });
  });
}

/**
 * Register historical replay checks across settlement and replacement.
 * @param getHarness - Current suite's initialized realization.
 */
function registerHistoricalRequests(getHarness: GetHarness): void {
  it.each([
    'completed',
    'failed',
  ] as const)('replays an old %s outcome without reopening its gate or replacing a successor', async (status) => {
    const { repository, peer } = getHarness();
    const input = request();
    await repository.ensureAttempt(input);
    expect(
      await repository.commitOutcome({
        ...input,
        result: repository.canonicalizeOutcome(makeTestWorkflowResult(input.executionId, status)),
      }),
    ).toMatchObject({ kind: 'accepted' });
    const settled = await peer.readAttemptSettlement(input);
    if (settled.kind !== 'outcome') throw new Error('Expected durable outcome');
    expect(await peer.ensureAttempt(input)).toEqual({ kind: 'replayed', attempt: settled.attempt });
    const successor = {
      ...input,
      requestKey: 'successor',
      executionAttemptId: `${input.executionAttemptId}-successor`,
    };
    await Promise.all([repository.ensureAttempt(input), peer.ensureAttempt(successor)]);
    const historical = await repository.readAttemptSettlement(input);
    expect(historical).toMatchObject({
      kind: 'outcome',
      isCurrentAttempt: false,
      attempt: { operationStartGate: 'closed' },
      result: settled.result,
    });
    if (historical.kind !== 'outcome') throw new Error('Expected historical outcome');
    expect(await peer.ensureAttempt(input)).toEqual({ kind: 'replayed', attempt: historical.attempt });
    expect(await repository.getActiveAttempt(input.executionId, successor.executionAttemptId)).toMatchObject({
      operationStartGate: 'open',
    });
    expect(await repository.getActiveAttempt(input.executionId, input.executionAttemptId)).toBeNull();
  });

  it('does not restore an unsettled predecessor when old replay races a fresh demand', async () => {
    const { repository, peer } = getHarness();
    const input = request();
    await repository.ensureAttempt(input);
    const successor = {
      ...input,
      requestKey: 'replacement',
      executionAttemptId: `${input.executionAttemptId}-replacement`,
    };
    await Promise.all([repository.ensureAttempt(input), peer.ensureAttempt(successor)]);
    expect(await repository.readAttemptSettlement(input)).toMatchObject({
      kind: 'unsettled',
      isCurrentAttempt: false,
      attempt: { operationStartGate: 'closed' },
    });
    expect(await repository.ensureAttempt(input)).toMatchObject({
      kind: 'replayed',
      attempt: { operationStartGate: 'closed' },
    });
    expect(await peer.getActiveAttempt(input.executionId, successor.executionAttemptId)).toMatchObject({
      operationStartGate: 'open',
    });
  });
}

/**
 * Register input/output isolation, semantic equality and frozen timing checks.
 * @param getHarness - Current suite's initialized realization.
 */
function registerRequestSnapshots(getHarness: GetHarness): void {
  it('freezes input before awaiting storage and compares instructions independently of member order', async () => {
    const { repository, peer } = getHarness();
    const payload = { alpha: 1, beta: 2, steps: ['first', 'second'] };
    const input = {
      ...request(),
      instruction: makeTestInstruction({ workload: { kind: 'test', version: '1', input: payload } }),
    };
    const pending = repository.ensureAttempt(input);
    payload.alpha = 999;
    payload.steps.reverse();
    const created = await pending;
    if (created.kind !== 'created') throw new Error('Expected new demand');
    const reordered = {
      ...input,
      instruction: makeTestInstruction({
        workload: { kind: 'test', version: '1', input: { steps: ['first', 'second'], beta: 2, alpha: 1 } },
      }),
    };
    expect(await peer.ensureAttempt(reordered)).toEqual({ kind: 'replayed', attempt: created.attempt });
    expect(await peer.ensureAttempt(input)).toEqual({ kind: 'conflict' });
    const reversed = {
      ...reordered,
      instruction: makeTestInstruction({
        workload: { kind: 'test', version: '1', input: { alpha: 1, beta: 2, steps: ['second', 'first'] } },
      }),
    };
    expect(await repository.ensureAttempt(reversed)).toEqual({ kind: 'conflict' });
    created.attempt.instruction.workload.input = { changed: true };
    const replay = await peer.ensureAttempt(reordered);
    expect(replay).toMatchObject({ kind: 'replayed', attempt: { instruction: reordered.instruction } });
    if (replay.kind === 'conflict') throw new Error('Expected replay');
    replay.attempt.instruction.workload.input = { changedAgain: true };
    expect(await repository.ensureAttempt(reordered)).toMatchObject({
      kind: 'replayed',
      attempt: { instruction: reordered.instruction },
    });
  });

  it('preserves original timing even when the new valid host budget would overflow an unused deadline', async () => {
    const { repository, peer } = getHarness();
    const input = request();
    const created = await repository.ensureAttempt(input);
    if (created.kind !== 'created') throw new Error('Expected new demand');
    for (const bootstrapTimeoutMs of [1, Number.MAX_SAFE_INTEGER]) {
      expect(await peer.ensureAttempt({ ...input, bootstrapTimeoutMs })).toEqual({
        kind: 'replayed',
        attempt: created.attempt,
      });
    }
    await expect(peer.ensureAttempt({ ...input, bootstrapTimeoutMs: -1 })).rejects.toThrow();
    expect(await repository.readAttemptSettlement(input)).toMatchObject({ attempt: created.attempt });
  });
}
