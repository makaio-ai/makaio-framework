import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import type { ReportOperationInput } from '../../execution-attempt-repository.js';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { nextIds, preparationAttempt, RUNTIME_INCARNATION_ID, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

type Harness = ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>;
type OwnerEndpoint = 'registration' | 'readiness' | 'admission' | 'Preparation report';
const OWNER_ENDPOINTS: readonly OwnerEndpoint[] = ['registration', 'readiness', 'admission', 'Preparation report'];

/**
 * Submit an otherwise valid runtime request with the supplied owner and attempt identity.
 * @param repository - Controller receiving the request.
 * @param endpoint - Owner-bearing endpoint to exercise.
 * @param report - Existing Preparation correlation, including the identity under test.
 * @returns The endpoint's decision.
 */
async function submitOwnerRequest(
  repository: Harness['repository'],
  endpoint: OwnerEndpoint,
  report: ReportOperationInput,
): Promise<{ readonly kind: string }> {
  const ids = { executionId: report.executionId, executionAttemptId: report.executionAttemptId };
  switch (endpoint) {
    case 'registration':
      return repository.registerRuntime({ ...ids, runtimeIncarnationId: RUNTIME_INCARNATION_ID });
    case 'readiness':
      return repository.markRuntimeReady({
        ...ids,
        runtimeGeneration: report.runtimeGeneration,
        readyAt: new Date().toISOString(),
      });
    case 'admission':
      return repository.admitOperation({
        ...ids,
        runtimeGeneration: report.runtimeGeneration,
        operationKind: 'workspace-preparation',
        admissionKey: 'prepare',
      });
    case 'Preparation report':
      return repository.reportOperation(report);
  }
}

/**
 * Register runtime endpoint identity isolation requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerRuntimeIdentityCases(getHarness: () => Harness): void {
  const cases = OWNER_ENDPOINTS.flatMap((endpoint) =>
    (['unknown attempt', 'foreign owner'] as const).map((identity) => ({ endpoint, identity })),
  );
  it.each(cases)('refuses $identity at $endpoint without changing either real attempt', async ({
    endpoint,
    identity,
  }) => {
    const harness = getHarness();
    const report = await preparationAttempt(harness.repository);
    const foreign = nextIds();
    await harness.repository.createAttempt({
      ...foreign,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const original = await harness.repository.recovery.getAttemptWithAllocation(report.executionAttemptId);
    const other = await harness.repository.recovery.getAttemptWithAllocation(foreign.executionAttemptId);
    const rejected =
      identity === 'unknown attempt'
        ? { ...report, executionAttemptId: `${report.executionAttemptId}-unknown` }
        : { ...report, executionId: foreign.executionId };

    expect(await submitOwnerRequest(harness.peer, endpoint, rejected)).toEqual({ kind: 'not-found' });
    expect(await harness.peer.recovery.getAttemptWithAllocation(report.executionAttemptId)).toEqual(original);
    expect(await harness.peer.recovery.getAttemptWithAllocation(foreign.executionAttemptId)).toEqual(other);
    expect(await harness.repository.reportOperation(report)).toEqual({
      kind: 'accepted',
      binding: report.result.binding,
    });
  });

  it('refuses completion of an unknown attempt without releasing a real Preparation slot', async () => {
    const harness = getHarness();
    const report = await preparationAttempt(harness.repository);
    const original = await harness.repository.recovery.getAttemptWithAllocation(report.executionAttemptId);

    expect(
      await harness.peer.completeOperation({
        executionAttemptId: `${report.executionAttemptId}-unknown`,
        operationId: report.operationId,
        runtimeGeneration: report.runtimeGeneration,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(await harness.peer.recovery.getAttemptWithAllocation(report.executionAttemptId)).toEqual(original);
    expect(await harness.repository.reportOperation(report)).toEqual({
      kind: 'accepted',
      binding: report.result.binding,
    });
  });
}
