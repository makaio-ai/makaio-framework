import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { preparationAttempt } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register durable isolation requirements for accepted Preparation receipts.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerPreparationIsolationCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('retains an accepted Preparation receipt after caller aliases are mutated', async () => {
    const harness = getHarness();
    const report = await preparationAttempt(harness.repository, [{ id: 'source', path: 'source' }]);
    const originalReport = structuredClone(report);
    const originalBinding = structuredClone(report.result.binding);

    expect(await harness.repository.reportOperation(report)).toEqual({
      kind: 'accepted',
      binding: originalBinding,
    });

    const sourceRoot = report.result.binding.sourceRoots[0];
    if (sourceRoot === undefined) throw new Error('Expected the Preparation fixture to bind one source root');
    Reflect.set(report.result.binding, 'workspaceRoot', '/mutated-workspace');
    Reflect.set(sourceRoot, 'path', '/mutated-workspace/source');
    Reflect.set(report.result.binding.sourceRoots, 0, { id: 'replacement-source', path: '/replacement' });

    expect(
      (await harness.peer.getActiveAttempt(originalReport.executionId, originalReport.executionAttemptId))
        ?.preparationReceipts,
    ).toEqual([
      {
        operationId: originalReport.operationId,
        runtimeGeneration: originalReport.runtimeGeneration,
        result: originalReport.result,
      },
    ]);
    expect(await harness.peer.reportOperation(originalReport)).toEqual({
      kind: 'duplicate',
      binding: originalBinding,
    });
  });
}
