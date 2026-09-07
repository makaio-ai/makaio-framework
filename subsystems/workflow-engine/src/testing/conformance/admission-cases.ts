import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeTestInstruction, makeTestWorkflowResult } from '../attempt-fixtures.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';
import {
  nextIds,
  TEST_BOOTSTRAP_TIMEOUT_MS,
  RUNTIME_INCARNATION_ID,
  allocateAttempt,
  registerTestRuntime,
  proveTestReadiness,
  admitTestOperation,
  readyAttempt,
} from './attempt-helpers.js';

/**
 * Register the admission requirements of the repository port.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerAdmissionCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('never refuses a worker outcome that races an admission', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const result = makeTestWorkflowResult(ids.executionId);

    const [admission, commit] = await Promise.all([
      harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-against-outcome',
        runtimeGeneration,
      }),
      harness.peer.commitOutcome({ ...ids, result: harness.peer.canonicalizeOutcome(result) }),
    ]);

    // Admission never gates the canonical answer: whichever order the two
    // reach durable state in, the worker's outcome is accepted and the
    // admission is either in before the settlement or refused by it.
    expect(commit).toEqual({
      kind: 'accepted',
      outcome: result,
      text: harness.repository.canonicalizeOutcome(result).text,
    });
    expect(['admitted', 'resolved']).toContain(admission.kind);
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
        status: 'settled',
        settlementKind: 'outcome',
        operationStartGate: 'closed',
      });
    }
  });

  it('advances the runtime generation once for two concurrent reports of one incarnation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const report = { ...ids, runtimeIncarnationId: RUNTIME_INCARNATION_ID };

    const decisions = await Promise.all([
      harness.repository.registerRuntime(report),
      harness.peer.registerRuntime(report),
    ]);

    // The incarnation identifier is the registration idempotency key, so the
    // second report is a replay rather than a second endpoint.
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['duplicate', 'registered']);
    expect(decisions).toContainEqual({ kind: 'duplicate', runtimeGeneration: 1, runtimeReadyAt: null });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: 1,
      runtimeIncarnationId: RUNTIME_INCARNATION_ID,
      runtimeReadyAt: null,
    });
  });

  it('allocates one generation per incarnation when two race for the endpoint', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);

    const decisions = await Promise.all([
      harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-a' }),
      harness.peer.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-b' }),
    ]);

    // Two incarnations claiming one attempt is an anomaly the generation exists
    // for: each registration allocates its own, so the later one fences the
    // earlier one instead of sharing its fence.
    const generations = decisions.flatMap((decision) =>
      decision.kind === 'registered' ? [decision.runtimeGeneration] : [],
    );
    expect(generations.sort()).toEqual([1, 2]);
    const latestIncarnation =
      decisions[0]?.kind === 'registered' && decisions[0].runtimeGeneration === 2
        ? 'runtime-incarnation-a'
        : 'runtime-incarnation-b';
    // Exactly one incarnation owns the endpoint afterwards, with no readiness
    // inherited from the one it displaced.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: 2,
      runtimeIncarnationId: latestIncarnation,
      runtimeReadyAt: null,
      activeOperationId: null,
    });
  });

  it('refuses a completion fenced against a superseded generation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const first = await readyAttempt(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, first, 'runtime-probe', 'probe-1');
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: probe,
        runtimeGeneration: first,
      }),
    ).toEqual({ kind: 'completed' });

    const second = await registerTestRuntime(harness.repository, ids, 'runtime-incarnation-2');
    await proveTestReadiness(harness.repository, ids, second);
    const running = await admitTestOperation(harness.repository, ids, second, 'workflow-run', 'run-1');

    // The superseded runtime answering for an operation it never owned changes
    // nothing: the fence is what tells the two incarnations apart.
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: running,
        runtimeGeneration: first,
      }),
    ).toEqual({ kind: 'stale-generation' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: running,
      activeOperationGeneration: second,
      lastCompletedOperationId: probe,
    });
  });

  it('answers two concurrent admissions of one key with the operation it admitted once', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const command = {
      ...ids,
      operationKind: 'workflow-run',
      admissionKey: 'run-key',
      runtimeGeneration,
    } as const;

    const decisions = await Promise.all([
      harness.repository.admitOperation(command),
      harness.peer.admitOperation(command),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['admitted', 'duplicate']);
    // The retry receives the identifier the first admission was given, which is
    // the only way a caller that lost the reply learns which operation it got.
    const operationIds = decisions.flatMap((decision) =>
      decision.kind === 'admitted' || decision.kind === 'duplicate' ? [decision.operationId] : [],
    );
    expect(operationIds).toHaveLength(2);
    expect(new Set(operationIds).size).toBe(1);
    expect(await harness.peer.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: operationIds[0],
      activeOperationKey: command.admissionKey,
      activeOperationGeneration: runtimeGeneration,
    });
  });

  registerDistinctAdmissionRace(getHarness);

  it('answers an admission on a settled attempt as resolved, over a closed gate', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
    });

    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'after-settlement',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
    // The gate is closed underneath that answer; `resolved` wins because it
    // says why, and the gate only says that it happened.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
  });

  it('refuses an admission while another operation occupies the attempt', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-2',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'operation-active', operationId: running });
  });

  it('refuses a completion for another operation and replays the matching one as duplicate', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');
    const complete = async (operationId: string): Promise<unknown> =>
      harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId,
        runtimeGeneration,
      });

    expect(await complete('operation-nobody-admitted')).toEqual({ kind: 'mismatch', activeOperationId: running });
    expect(await complete(running)).toEqual({ kind: 'completed' });
    // The replay is answered from the last completion, because the active
    // operation it names is gone by then.
    expect(await complete(running)).toEqual({ kind: 'duplicate' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: null,
      activeOperationKind: null,
      activeOperationKey: null,
      activeOperationGeneration: null,
      lastCompletedOperationId: running,
    });
  });

  it('closes the superseded attempt gate in the transaction that moves the pointer', async () => {
    const harness = getHarness();
    const first = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, first);
    const replacement = { executionId: first.executionId, executionAttemptId: `${first.executionAttemptId}-next` };

    await harness.repository.createAttempt({
      ...replacement,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    expect(await harness.repository.getAttemptControlState(first.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
    // The new attempt opens its own gate rather than inheriting anything.
    expect(await harness.repository.getAttemptControlState(replacement.executionAttemptId)).toMatchObject({
      operationStartGate: 'open',
      runtimeGeneration: 0,
    });
    // The fence outranks the gate in the refusal order, so what the superseded
    // attempt reports is why it can never admit again, not merely that it
    // cannot.
    expect(
      await harness.repository.admitOperation({
        ...first,
        operationKind: 'workflow-run',
        admissionKey: 'after-supersession',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'fenced' });
  });

  it('closes the start gate of the pending attempt it abandons', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    expect(await harness.repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId)).toEqual({
      kind: 'abandoned',
    });
    // Abandonment is a terminal settlement and owes the same gate close every
    // other one does, however early it arrives: an attempt whose answer is
    // already fixed never starts work again.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
  });

  it('reports the control state a process that lost its own memory recovers from', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-key');

    const control = await harness.repository.getAttemptControlState(ids.executionAttemptId);
    expect(control).toMatchObject({
      runtimeGeneration,
      runtimeIncarnationId: RUNTIME_INCARNATION_ID,
      operationStartGate: 'open',
      activeOperationId: running,
      activeOperationKind: 'workflow-run',
      activeOperationKey: 'run-key',
      activeOperationGeneration: runtimeGeneration,
      lastCompletedOperationId: null,
    });
    expect(control?.runtimeReadyAt).not.toBeNull();
    // Recovery re-presents the key it recorded rather than admitting again.
    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-key',
        runtimeGeneration,
      }),
    ).toEqual({
      kind: 'duplicate',
      operationId: running,
      runtimeGeneration,
      admittedAt: control?.activeOperationAdmittedAt,
    });
    expect(control?.activeOperationAdmittedAt).toEqual(expect.any(String));
  });
}

/**
 * Register competing admission keys against the one durable operation slot.
 * @param getHarness - Current suite realization.
 */
function registerDistinctAdmissionRace(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('admits exactly one of two competing operation keys across controllers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const command = { ...ids, operationKind: 'workflow-run', runtimeGeneration } as const;

    const decisions = await Promise.all([
      harness.repository.admitOperation({ ...command, admissionKey: 'competing-primary' }),
      harness.peer.admitOperation({ ...command, admissionKey: 'competing-peer' }),
    ]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['admitted', 'operation-active']);
    const winner = decisions.find((decision) => decision.kind === 'admitted');
    if (!winner) throw new Error('Expected exactly one admitted operation');
    expect(decisions).toContainEqual({ kind: 'operation-active', operationId: winner.operationId });
    expect(winner.runtimeGeneration).toBe(runtimeGeneration);
    const winningKey = decisions[0]?.kind === 'admitted' ? 'competing-primary' : 'competing-peer';
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
        activeOperationId: winner.operationId,
        activeOperationKind: 'workflow-run',
        activeOperationKey: winningKey,
        activeOperationGeneration: runtimeGeneration,
        activeOperationAdmittedAt: winner.admittedAt,
      });
    }
  });
}
