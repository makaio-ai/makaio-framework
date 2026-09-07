import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeBeginProvisioningInput, makeTestInstruction } from '../attempt-fixtures.js';
import { RUNTIME_INCARNATION_ID, TEST_BOOTSTRAP_TIMEOUT_MS, nextIds, readyAttempt } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register races between independent authorities that change different portions
 * of one attempt's durable control state.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerMixedAuthorityRaceCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('keeps pending abandonment and provisioning mutually exclusive across controllers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    const [abandonment, provisioning] = await Promise.all([
      harness.repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId),
      harness.peer.beginProvisioning(makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId)),
    ]);

    if (abandonment.kind === 'abandoned') {
      expect(provisioning).toEqual({ kind: 'resolved', allocationRef: null });
      for (const repository of [harness.repository, harness.peer]) {
        expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
          status: 'settled',
          settlementKind: 'abandoned',
          allocationRef: null,
        });
        expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
          operationStartGate: 'closed',
          activeOperationId: null,
        });
        expect(await repository.getProviderOperation(ids.executionAttemptId)).toBeNull();
      }
      return;
    }

    expect(abandonment).toEqual({ kind: 'provisioning' });
    if (provisioning.kind !== 'started') throw new Error(`Expected provisioning to start, got '${provisioning.kind}'`);
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
        status: 'provisioning',
        settlementKind: null,
        allocationRef: null,
      });
      expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
        operationStartGate: 'open',
        activeOperationId: null,
      });
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
        ...provisioning.claim,
        obligation: 'provisioning-resolution',
      });
    }
  });

  it('keeps either the admitted generation-one run or the replacement runtime endpoint', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const firstGeneration = await readyAttempt(harness.repository, ids);
    const command = {
      ...ids,
      operationKind: 'workflow-run',
      admissionKey: 'mixed-authority-workflow-run',
      runtimeGeneration: firstGeneration,
    } as const;

    const [admission, registration] = await Promise.all([
      harness.repository.admitOperation(command),
      harness.peer.registerRuntime({ ...ids, runtimeIncarnationId: 'mixed-authority-replacement' }),
    ]);

    if (admission.kind === 'admitted') {
      expect(registration).toEqual({ kind: 'operation-active', operationId: admission.operationId });
      for (const repository of [harness.repository, harness.peer]) {
        expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
          runtimeGeneration: firstGeneration,
          runtimeIncarnationId: RUNTIME_INCARNATION_ID,
          runtimeReadyAt: expect.any(String),
          activeOperationId: admission.operationId,
          activeOperationKind: 'workflow-run',
          activeOperationGeneration: firstGeneration,
        });
      }
      return;
    }

    expect(registration).toEqual({ kind: 'registered', runtimeGeneration: firstGeneration + 1 });
    // The replacement clears readiness before the admission compares its fence,
    // so the fixed decision order reports the missing proof rather than stale generation.
    expect(admission).toEqual({ kind: 'not-ready' });
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
        runtimeGeneration: firstGeneration + 1,
        runtimeIncarnationId: 'mixed-authority-replacement',
        runtimeReadyAt: null,
        activeOperationId: null,
      });
    }
  });
}
