import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { admitTestOperation, allocateAttempt, nextIds, readyAttempt, registerTestRuntime } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register runtime readiness, admission, and completion boundary requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerRuntimeBoundaryCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('returns one canonical readiness instant when peer readiness reports race', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const firstReadyAt = '2026-09-07T10:00:00.000Z';
    const secondReadyAt = '2026-09-07T10:00:01.000Z';

    const decisions = await Promise.all([
      harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: firstReadyAt }),
      harness.peer.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: secondReadyAt }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['duplicate', 'ready']);
    const readyIndex = decisions.findIndex((decision) => decision.kind === 'ready');
    if (readyIndex === -1) throw new Error('Expected one ready decision');
    const acceptedAt = [firstReadyAt, secondReadyAt][readyIndex];
    if (acceptedAt === undefined) throw new Error('Ready decision had no matching input');
    expect(decisions[readyIndex]).toEqual({ kind: 'ready', acceptedAt });
    expect(decisions[(readyIndex + 1) % decisions.length]).toEqual({ kind: 'duplicate', acceptedAt });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeReadyAt: acceptedAt,
    });
  });

  it('reports not-ready before stale generation and stale generation after readiness', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const staleAdmission = {
      ...ids,
      operationKind: 'workflow-run' as const,
      admissionKey: 'stale-generation',
      runtimeGeneration: runtimeGeneration - 1,
    };

    expect(await harness.repository.admitOperation(staleAdmission)).toEqual({ kind: 'not-ready' });
    expect(
      await harness.repository.markRuntimeReady({
        ...ids,
        runtimeGeneration,
        readyAt: '2026-09-07T10:01:00.000Z',
      }),
    ).toMatchObject({ kind: 'ready' });
    expect(await harness.peer.admitOperation(staleAdmission)).toEqual({
      kind: 'stale-generation',
      runtimeGeneration,
    });
    const currentAdmission = await harness.repository.admitOperation({
      ...staleAdmission,
      admissionKey: 'current-generation',
      runtimeGeneration,
    });
    expect(currentAdmission.kind).toBe('admitted');
    if (currentAdmission.kind !== 'admitted') throw new Error('Expected current-generation admission');
    expect(await harness.peer.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: currentAdmission.operationId,
      activeOperationKind: 'workflow-run',
      activeOperationKey: 'current-generation',
      activeOperationGeneration: runtimeGeneration,
    });
  });

  it('completes one peer race once and clears every active operation field', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const operationId = await admitTestOperation(
      harness.repository,
      ids,
      runtimeGeneration,
      'runtime-probe',
      'complete-race',
    );
    const completion = { executionAttemptId: ids.executionAttemptId, operationId, runtimeGeneration };

    const decisions = await Promise.all([
      harness.repository.completeOperation(completion),
      harness.peer.completeOperation(completion),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['completed', 'duplicate']);
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: null,
      activeOperationKind: null,
      activeOperationKey: null,
      activeOperationGeneration: null,
      activeOperationAdmittedAt: null,
      lastCompletedOperationId: operationId,
    });
  });
}
