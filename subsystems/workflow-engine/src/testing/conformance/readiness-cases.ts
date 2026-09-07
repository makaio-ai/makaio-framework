import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeEvidence, makeTestInstruction, makeTestWorkflowResult } from '../attempt-fixtures.js';
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
 * Register the readiness requirements of the repository port.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerReadinessCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('refuses a registration while an operation occupies the attempt', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    // Advancing the generation here would fence the running operation's own
    // completion, so the operation in the way is reported instead.
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'operation-active', operationId: running },
    );
  });

  it('replays registration and readiness during a workload, but fences a stale readiness report first', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'replay-workload');
    const before = await harness.repository.getAttemptControlState(ids.executionAttemptId);

    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: RUNTIME_INCARNATION_ID })).toEqual({
      kind: 'duplicate',
      runtimeGeneration,
      runtimeReadyAt: before?.runtimeReadyAt,
    });
    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'duplicate', acceptedAt: before?.runtimeReadyAt });
    expect(
      await harness.repository.markRuntimeReady({
        ...ids,
        runtimeGeneration: runtimeGeneration + 1,
        readyAt: new Date().toISOString(),
      }),
    ).toEqual({ kind: 'stale-generation' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toEqual(before);
  });

  it('reports settlement before replaying the last completed operation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const operationId = await admitTestOperation(
      harness.repository,
      ids,
      runtimeGeneration,
      'workflow-run',
      'complete',
    );
    const completion = { executionAttemptId: ids.executionAttemptId, operationId, runtimeGeneration };
    expect(await harness.repository.completeOperation(completion)).toEqual({ kind: 'completed' });
    expect(await harness.repository.completeOperation(completion)).toEqual({ kind: 'duplicate' });
    const settlement = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
    });
    expect(settlement.kind).toBe('accepted');
    expect(await harness.repository.completeOperation(completion)).toEqual({ kind: 'resolved' });
  });

  it('admits the bounded probe before readiness and refuses every other kind', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);

    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-before-readiness',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'not-ready' });
    // The probe is what proves readiness, so requiring readiness of it would
    // make readiness unreachable.
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: probe,
      activeOperationKind: 'runtime-probe',
      runtimeReadyAt: null,
    });
  });

  it('refuses readiness while an operation occupies the attempt', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');

    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'operation-active', operationId: probe });
  });

  it('refuses readiness for an attempt superseded after its probe completed', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: probe,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'completed' });

    // A newer attempt for the same execution moves the active pointer between
    // the probe's completion and the readiness write. The generation still
    // matches, so only the active-attempt fence can see the endpoint is gone.
    await allocateAttempt(harness.repository, {
      executionId: ids.executionId,
      executionAttemptId: `${ids.executionAttemptId}-successor`,
    });

    expect(
      await harness.peer.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-after-supersession' }),
    ).toEqual({ kind: 'fenced' });
    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'fenced' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      runtimeReadyAt: null,
      activeOperationId: null,
      operationStartGate: 'closed',
    });
  });

  it('releases an in-flight superseded probe without allowing the old runtime to become ready', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');
    await harness.peer.createAttempt({
      executionId: ids.executionId,
      executionAttemptId: `${ids.executionAttemptId}-successor`,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    // Completion is deliberately not active-attempt fenced: the old probe
    // still owns a slot that must be released, even after its successor wins.
    expect(
      await harness.peer.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: probe,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'completed' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: null,
      activeOperationKind: null,
      activeOperationKey: null,
      activeOperationGeneration: null,
      activeOperationAdmittedAt: null,
      lastCompletedOperationId: probe,
    });
    expect(
      await harness.peer.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'fenced' });
  });

  it('clears readiness when a new incarnation takes the endpoint', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const first = await readyAttempt(harness.repository, ids);
    const second = await registerTestRuntime(harness.repository, ids, 'runtime-incarnation-2');

    expect(second).toBe(first + 1);
    // Readiness was proven by the incarnation this one replaces, and says
    // nothing about the new one.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: second,
      runtimeIncarnationId: 'runtime-incarnation-2',
      runtimeReadyAt: null,
    });

    await proveTestReadiness(harness.repository, ids, second);
    const running = await admitTestOperation(harness.repository, ids, second, 'workflow-run', 'run-1');
    // A third incarnation arriving mid-operation is refused, however ready the
    // attempt was a moment ago.
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-3' })).toEqual(
      { kind: 'operation-active', operationId: running },
    );
  });

  it('answers resolved for a settled attempt that still carries a leftover operation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    const commit = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
    });

    expect(commit.kind).toBe('accepted');
    // The settlement keeps the active operation on purpose: it is what lets a
    // late completion learn that nobody is waiting for it any more.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: running,
      operationStartGate: 'closed',
    });
    // The precedence that matters: `resolved` outranks `operation-active`, so
    // neither caller is told to wait for an operation nothing will complete.
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'resolved' },
    );
    expect(
      await harness.peer.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'resolved' });
    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'after-settlement',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: running,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
  });

  it('refuses registration and admission once the allocation is confirmed terminated, before settlement', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    await proveTestReadiness(harness.repository, ids, runtimeGeneration);

    // Termination is durable on the operation row before the attempt settles;
    // in that window the attempt still carries its allocation reference while
    // nothing can run on it any more.
    const termination = await harness.repository.recordAllocationTerminated({
      claim,
      evidence: makeEvidence({ summary: 'provider reported the allocation terminated' }),
    });
    expect(termination).toEqual({ kind: 'recorded' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      operationStartGate: 'open',
    });

    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'not-allocated' },
    );
    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'after-termination',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'not-allocated' });
    // Nothing moved: the generation the dead allocation held is still the
    // current one, and no operation occupies the attempt.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      runtimeIncarnationId: RUNTIME_INCARNATION_ID,
      activeOperationId: null,
    });

    // Settlement then takes over with its own answer.
    const settlement = await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });
    expect(settlement).toEqual({ kind: 'recorded' });
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'resolved' },
    );
  });

  it('refuses readiness once the allocation is confirmed terminated, even after the probe completed', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');

    // Termination lands while the probe is in flight. The probe still
    // completes — completion is claim-independent — but the readiness it
    // would prove belongs to an allocation nothing can run on any more.
    expect(
      await harness.repository.recordAllocationTerminated({
        claim,
        evidence: makeEvidence({ summary: 'provider reported the allocation terminated' }),
      }),
    ).toEqual({ kind: 'recorded' });
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: probe,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'completed' });

    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'not-allocated' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      runtimeReadyAt: null,
      activeOperationId: null,
    });
  });

  it('reclaims a probe orphaned by a dead handshake when a new incarnation registers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const firstGeneration = await registerTestRuntime(harness.repository, ids);
    const orphan = await admitTestOperation(harness.repository, ids, firstGeneration, 'runtime-probe', 'probe-1');
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: orphan,
      activeOperationKind: 'runtime-probe',
    });

    // The handshake that admitted the probe never completed it. The next
    // incarnation takes the endpoint anyway: the probe is the authority's own
    // operation, not workload, and the new generation clears it.
    const registration = await harness.repository.registerRuntime({
      ...ids,
      runtimeIncarnationId: 'runtime-incarnation-2',
    });
    expect(registration).toEqual({ kind: 'registered', runtimeGeneration: firstGeneration + 1 });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: firstGeneration + 1,
      runtimeIncarnationId: 'runtime-incarnation-2',
      runtimeReadyAt: null,
      activeOperationId: null,
      activeOperationKind: null,
      activeOperationKey: null,
      activeOperationGeneration: null,
    });

    // The dead handshake's own completion is now fenced out rather than
    // completing something the attempt no longer runs.
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: orphan,
        runtimeGeneration: firstGeneration,
      }),
    ).toEqual({ kind: 'not-active' });
  });

  it('does not reclaim a workload operation when a new incarnation registers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'operation-active', operationId: running },
    );
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      activeOperationId: running,
      activeOperationKind: 'workflow-run',
    });
  });
}
