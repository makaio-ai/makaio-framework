import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import type { ReportOperationInput } from '../../execution-attempt-repository.js';
import { leaseAt, makeEvidence, makeTestInstruction, makeTestWorkflowResult } from '../attempt-fixtures.js';
import { preparationAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

type Harness = ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>;
type Refusal = 'resolved' | 'fenced' | 'not-allocated' | 'no-active-operation' | 'operation-mismatch';

/**
 * Reach a report refusal through public transitions without injecting internal state.
 * @param harness - Controllers sharing the attempt's durable state.
 * @param report - Admitted, not yet reported Preparation operation.
 * @param refusal - Reachable refusal to establish.
 * @returns A fresh report that cannot match a historical receipt.
 */
async function reachPreparationRefusal(
  harness: Harness,
  report: ReportOperationInput,
  refusal: Refusal,
): Promise<ReportOperationInput> {
  switch (refusal) {
    case 'resolved':
      expect(
        await harness.repository.commitOutcome({
          executionId: report.executionId,
          executionAttemptId: report.executionAttemptId,
          result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(report.executionId, 'failed')),
        }),
      ).toMatchObject({ kind: 'accepted' });
      break;
    case 'fenced':
      await harness.repository.createAttempt({
        executionId: report.executionId,
        executionAttemptId: `${report.executionAttemptId}-successor`,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      break;
    case 'not-allocated': {
      const takeover = await harness.repository.takeOverProviderOperation({
        executionAttemptId: report.executionAttemptId,
        ownerId: 'preparation-termination-observer',
        observedAt: leaseAt(120_000),
        leaseExpiresAt: leaseAt(180_000),
      });
      if (takeover.kind !== 'claimed') throw new Error(`Expected takeover, got '${takeover.kind}'`);
      expect(
        await harness.repository.recordAllocationTerminated({
          claim: takeover.claim,
          evidence: makeEvidence(),
        }),
      ).toEqual({ kind: 'recorded' });
      break;
    }
    case 'no-active-operation':
      expect(await harness.repository.reportOperation(report)).toEqual({
        kind: 'accepted',
        binding: report.result.binding,
      });
      // A new ID avoids the historical replay that legitimately precedes reachability.
      return { ...report, operationId: `${report.operationId}-unadmitted` };
    case 'operation-mismatch':
      return { ...report, operationId: `${report.operationId}-different` };
  }
  return report;
}

/**
 * Register current Preparation report refusal and state-retention requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerPreparationRefusalCases(getHarness: () => Harness): void {
  const refusals: readonly Refusal[] = [
    'resolved',
    'fenced',
    'not-allocated',
    'no-active-operation',
    'operation-mismatch',
  ];
  it.each(refusals)('retains Preparation receipts and operation state after a %s report refusal', async (refusal) => {
    const harness = getHarness();
    const admittedReport = await preparationAttempt(harness.repository);
    const report = await reachPreparationRefusal(harness, admittedReport, refusal);
    const before = await harness.repository.recovery.getAttemptWithAllocation(report.executionAttemptId);
    const completed = refusal === 'no-active-operation';
    expect(before).toMatchObject({
      activeOperationId: completed ? null : admittedReport.operationId,
      activeOperationKind: completed ? null : 'workspace-preparation',
      preparationReceipts: completed
        ? [
            {
              operationId: admittedReport.operationId,
              runtimeGeneration: admittedReport.runtimeGeneration,
              result: admittedReport.result,
            },
          ]
        : [],
    });

    expect(await harness.peer.reportOperation(report)).toEqual({ kind: refusal });
    expect(await harness.peer.recovery.getAttemptWithAllocation(report.executionAttemptId)).toEqual(before);
  });
}
