import { expect, it } from 'vitest';
import type { ExecutionAttemptWorkspaceBinding, WorkflowRunResult, WorkspaceRequirement } from '@makaio/contracts';
import { preparationAttempt } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register Preparation source-root binding requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerPreparationBindingCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  const mismatches: ReadonlyArray<{
    readonly description: string;
    readonly sourceRoots: ExecutionAttemptWorkspaceBinding['sourceRoots'];
  }> = [
    { description: 'omits', sourceRoots: [] },
    { description: 'substitutes', sourceRoots: [{ id: 'different-source', path: '/scratch/first/source' }] },
    {
      description: 'adds undeclared roots alongside',
      sourceRoots: [
        { id: 'source', path: '/scratch/first/source' },
        { id: 'extra-source', path: '/scratch/first/extra' },
      ],
    },
  ];

  it.each(
    mismatches,
  )('retains the Preparation slot when the first report $description a requested source root', async ({
    sourceRoots,
  }) => {
    const harness = getHarness();
    const requestedSourceRoots: WorkspaceRequirement['sourceRoots'] = [{ id: 'source', path: 'source' }];
    const report = await preparationAttempt(harness.repository, requestedSourceRoots);
    const mismatched = {
      ...report,
      result: {
        ...report.result,
        binding: { ...report.result.binding, sourceRoots },
      },
    };

    expect(await harness.repository.reportOperation(mismatched)).toEqual({ kind: 'binding-mismatch' });
    expect(await harness.repository.getActiveAttempt(report.executionId, report.executionAttemptId)).toMatchObject({
      preparationReceipts: [],
      activeOperationId: report.operationId,
      activeOperationKind: 'workspace-preparation',
    });
    expect(await harness.repository.reportOperation(report)).toEqual({
      kind: 'accepted',
      binding: report.result.binding,
    });
  });
}
