import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeTestInstruction } from '../attempt-fixtures.js';
import {
  admitTestOperation,
  allocateAttempt,
  nextIds,
  readyAttempt,
  TEST_BOOTSTRAP_TIMEOUT_MS,
} from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Exercise exact owner-authorized cancellation receipts independently of runtime delivery.
 * @param getHarness - Real repositories sharing one isolated store.
 */
export function registerAttemptCancellationControlCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('accepts exact cancellation before a runtime exists and replays the winning receipt', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const request = { ...ids, requestKey: 'cancel-before-bootstrap', reason: 'operator requested stop' };
    const accepted = await repository.requestAttemptCancellation(request);
    expect(accepted).toEqual({
      kind: 'accepted',
      intent: {
        requestKey: request.requestKey,
        controlRevision: 1,
        requestedAt: expect.any(String),
        reason: request.reason,
      },
    });
    if (accepted.kind !== 'accepted') throw new Error('Expected a cancellation receipt');
    expect(Number.isFinite(Date.parse(accepted.intent.requestedAt))).toBe(true);
    expect(await peer.requestAttemptCancellation(request)).toEqual({ kind: 'replayed', intent: accepted.intent });
    expect(await peer.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: 0,
      operationStartGate: 'closed',
      activeOperationId: null,
    });
    expect(await peer.readAttemptSettlement(ids)).toMatchObject({ kind: 'unsettled' });
  });

  it('rejects conflicting reuse of the winning key but replays other keys without a second revision', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    const request = { ...ids, requestKey: 'winning-key', reason: 'first reason' };
    await repository.requestAttemptCancellation(request);
    const winner = await peer.readCancellation(ids.executionAttemptId);
    expect(await peer.requestAttemptCancellation({ ...request, reason: 'changed reason' })).toEqual({
      kind: 'conflict',
    });
    expect(await peer.requestAttemptCancellation({ ...ids, requestKey: request.requestKey })).toEqual({
      kind: 'conflict',
    });
    expect(
      await peer.requestAttemptCancellation({ ...request, requestKey: 'losing-key', reason: 'other reason' }),
    ).toEqual({ kind: 'replayed', intent: winner });
    await peer.requestCancellation({ executionId: ids.executionId, reason: 'owner-wide replay' });
    expect(await repository.readCancellation(ids.executionAttemptId)).toEqual(winner);
  });

  it('never reopens cancelled admission when an allocated runtime registers afterwards', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'cancel-before-registration' });
    const receipt = await peer.readCancellation(ids.executionAttemptId);
    // Registration establishes an endpoint, not permission to execute. Even
    // its readiness probe must still pass the separately closed start gate.
    expect(await peer.registerRuntime({ ...ids, runtimeIncarnationId: 'late-runtime' })).toEqual({
      kind: 'registered',
      runtimeGeneration: 1,
    });
    expect(
      await repository.admitOperation({
        ...ids,
        runtimeGeneration: 1,
        operationKind: 'runtime-probe',
        admissionKey: 'late-readiness',
      }),
    ).toEqual({ kind: 'gate-closed' });
    expect(await peer.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
      activeOperationId: null,
      runtimeReadyAt: null,
    });
    expect(await peer.readCancellation(ids.executionAttemptId)).toEqual(receipt);
  });

  it('recovers one winning decision after concurrent requests and a lost response', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    const requests = ['controller-a', 'controller-b'].map((requestKey) => ({ ...ids, requestKey, reason: requestKey }));
    const decisions = await Promise.all([
      repository.requestAttemptCancellation(requests[0]!),
      peer.requestAttemptCancellation(requests[1]!),
    ]);
    expect(decisions.map(({ kind }) => kind).sort()).toEqual(['accepted', 'replayed']);
    const winner = await peer.readCancellation(ids.executionAttemptId);
    expect(winner).toMatchObject({ controlRevision: 1 });
    for (const request of requests) {
      expect(await peer.requestAttemptCancellation(request)).toEqual({ kind: 'replayed', intent: winner });
    }
    expect(decisions).toEqual(
      expect.arrayContaining([
        { kind: 'accepted', intent: winner },
        { kind: 'replayed', intent: winner },
      ]),
    );
  });

  it('snapshots request scope before yielding and returns detached receipts', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const other = nextIds();
    await allocateAttempt(repository, ids);
    await allocateAttempt(repository, other);
    const request = { ...ids, requestKey: 'original-key', reason: 'original reason' };
    const expected = { ...request };
    const pending = repository.requestAttemptCancellation(request);
    Object.assign(request, other, { requestKey: 'mutated-key', reason: 'mutated reason' });
    const decision = await pending;
    expect(decision).toMatchObject({
      kind: 'accepted',
      intent: {
        requestKey: expected.requestKey,
        reason: expected.reason,
        controlRevision: 1,
      },
    });
    if (decision.kind !== 'accepted') throw new Error('Expected a cancellation receipt');
    const original = structuredClone(decision.intent);
    Object.assign(decision.intent, { requestKey: 'reader-key', reason: 'reader reason', controlRevision: 99 });
    const replay = await peer.requestAttemptCancellation(expected);
    expect(replay).toEqual({ kind: 'replayed', intent: original });
    if (replay.kind !== 'replayed') throw new Error('Expected cancellation replay');
    Object.assign(replay.intent, { controlRevision: 100 });
    expect(await repository.readCancellation(ids.executionAttemptId)).toEqual(original);
    expect(await peer.readCancellation(other.executionAttemptId)).toBeNull();
    expect(await peer.getAttemptControlState(other.executionAttemptId)).toMatchObject({ operationStartGate: 'open' });
  });

  it('requires the exact owning scope without making historical cleanup depend on the current pointer', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    const successor = { ...ids, executionAttemptId: `${ids.executionAttemptId}-successor` };
    await allocateAttempt(repository, successor);
    const request = { ...ids, requestKey: 'historical-cleanup' };
    expect(await peer.requestAttemptCancellation({ ...request, executionId: 'another-owner' })).toEqual({
      kind: 'not-found',
    });
    expect(await peer.requestAttemptCancellation({ ...request, executionAttemptId: 'missing-attempt' })).toEqual({
      kind: 'not-found',
    });
    expect(await repository.readCancellation(ids.executionAttemptId)).toBeNull();
    expect(await peer.requestAttemptCancellation(request)).toMatchObject({
      kind: 'accepted',
      intent: { controlRevision: 1 },
    });
    expect(await repository.readCancellation(successor.executionAttemptId)).toBeNull();
    expect(await peer.getAttemptControlState(successor.executionAttemptId)).toMatchObject({
      operationStartGate: 'open',
    });
  });

  it.each(['cancel-first', 'admission-first'] as const)('orders cancellation and admission: %s', async (order) => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(repository, ids);
    const operationId =
      order === 'admission-first'
        ? await admitTestOperation(repository, ids, runtimeGeneration, 'workflow-run', 'first-operation')
        : null;
    await peer.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const intent = await repository.readCancellation(ids.executionAttemptId);
    expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
      activeOperationId: operationId,
    });
    expect(await repository.readAttemptSettlement(ids)).toMatchObject({ kind: 'unsettled' });
    if (operationId !== null) {
      expect(
        await repository.completeOperation({
          executionAttemptId: ids.executionAttemptId,
          runtimeGeneration,
          operationId,
        }),
      ).toEqual({ kind: 'completed' });
    }
    expect(
      await repository.admitOperation({
        ...ids,
        runtimeGeneration,
        operationKind: 'workflow-run',
        admissionKey: 'after-cancel',
      }),
    ).toEqual({ kind: 'gate-closed' });
    expect(await peer.readCancellation(ids.executionAttemptId)).toEqual(intent);
  });
}
