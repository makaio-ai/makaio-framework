import { expect, it } from 'vitest';
import { type ExecutionAttemptInstruction, type WorkflowRunResult } from '@makaio/contracts';
import { RuntimeOutcomeFenceMismatchError } from '../../execution-attempt-repository.js';
import { makeTestInstruction, makeTestWorkflowResult } from '../attempt-fixtures.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';
import {
  nextIds,
  TEST_BOOTSTRAP_TIMEOUT_MS,
  preparationAttempt,
  registerTestRuntime,
  proveTestReadiness,
  admitTestOperation,
  readyAttempt,
} from './attempt-helpers.js';

/**
 * Register the instruction requirements of the repository port.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerInstructionCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('checks runtime generation at commit without rejecting historical canonical duplicates', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const result = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'failed'));
    const staleSubmission = { ...ids, result, runtimeFence: { runtimeGeneration, operationId: null } };
    // Validation may have finished on one controller before a second controller
    // replaces the runtime. Only the commit's own durable read decides.
    const replacementGeneration = await registerTestRuntime(harness.peer, ids, 'replacement-before-commit');
    await expect(harness.repository.commitOutcome(staleSubmission)).rejects.toThrow(RuntimeOutcomeFenceMismatchError);
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      settlementKind: null,
      runtimeGeneration: replacementGeneration,
    });
    expect(
      await harness.peer.commitOutcome({
        ...ids,
        result,
        runtimeFence: { runtimeGeneration: replacementGeneration, operationId: null },
      }),
    ).toMatchObject({ kind: 'accepted' });
    expect(await harness.repository.commitOutcome(staleSubmission)).toMatchObject({ kind: 'duplicate' });
    expect(
      await harness.repository.commitOutcome({
        ...staleSubmission,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
      }),
    ).toEqual({ kind: 'conflict' });
  });

  it('checks the active operation atomically before a new runtime outcome is committed', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const result = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed'));
    const operationId = await admitTestOperation(harness.peer, ids, runtimeGeneration, 'workload-invocation', 'invoke');
    for (const staleOperationId of [null, 'another-operation']) {
      await expect(
        harness.repository.commitOutcome({
          ...ids,
          result,
          runtimeFence: { runtimeGeneration, operationId: staleOperationId },
        }),
      ).rejects.toThrow(RuntimeOutcomeFenceMismatchError);
    }
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      settlementKind: null,
      activeOperationId: operationId,
    });
    expect(
      await harness.repository.commitOutcome({ ...ids, result, runtimeFence: { runtimeGeneration, operationId } }),
    ).toMatchObject({ kind: 'accepted' });
  });

  it('preserves superseded-attempt precedence over a stale runtime fence', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    await harness.peer.createAttempt({
      ...ids,
      executionAttemptId: `${ids.executionAttemptId}-replacement`,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    expect(
      await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
        runtimeFence: { runtimeGeneration: runtimeGeneration + 1, operationId: null },
      }),
    ).toEqual({ kind: 'fenced' });
  });

  it('snapshots its instruction without retaining or freezing owner input', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const instruction = makeTestInstruction({ workload: { kind: 'test', version: '1', input: { value: 'original' } } });
    await harness.repository.createAttempt({ ...ids, instruction, bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS });
    instruction.workload.input = { value: 'changed' };
    expect(await harness.repository.getInstruction(ids)).toMatchObject({ workload: { input: { value: 'original' } } });
    const stored = await harness.repository.getInstruction(ids);
    expect(Object.isFrozen(stored?.workload.input)).toBe(true);
    expect(await harness.repository.getInstruction({ ...ids, executionId: 'other-owner' })).toBeNull();
    expect(await harness.repository.getInstruction({ ...ids, executionAttemptId: 'missing' })).toBeNull();
    const invalid = { ...instruction, revision: '' } satisfies ExecutionAttemptInstruction;
    await expect(
      harness.repository.createAttempt({
        executionId: ids.executionId,
        executionAttemptId: `${ids.executionAttemptId}-invalid`,
        instruction: invalid,
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
    ).rejects.toThrow();
    expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).not.toBeNull();
    expect(await harness.peer.getActiveAttempt(`${ids.executionId}-foreign`, ids.executionAttemptId)).toBeNull();

    expect(
      await harness.peer.commitOutcome({
        ...ids,
        result: harness.peer.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
      }),
    ).toMatchObject({ kind: 'accepted' });
    expect(await harness.repository.getInstruction(ids)).toEqual(stored);
    const replacement = { executionId: ids.executionId, executionAttemptId: `${ids.executionAttemptId}-replacement` };
    const replacementInstruction = makeTestInstruction({ id: 'replacement-assignment' });
    await harness.peer.createAttempt({
      ...replacement,
      instruction: replacementInstruction,
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    // Historical reads retain the original snapshot instead of resolving current owner context.
    expect(await harness.repository.getInstruction(ids)).toEqual(stored);
    expect(await harness.repository.getInstruction(replacement)).toEqual(replacementInstruction);
    expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toBeNull();
    expect(
      await harness.repository.getActiveAttempt(replacement.executionId, replacement.executionAttemptId),
    ).toMatchObject({
      executionAttemptId: replacement.executionAttemptId,
    });
  });

  it('admits a workspace-less invocation without inventing a preparation result', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    expect(
      await harness.repository.admitOperation({
        ...ids,
        runtimeGeneration,
        operationKind: 'workspace-preparation',
        admissionKey: 'unneeded',
      }),
    ).toEqual({ kind: 'preparation-not-required' });
    expect(
      await harness.repository.admitOperation({
        ...ids,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'invoke',
      }),
    ).toMatchObject({ kind: 'admitted' });
  });

  it('requires a preparation result and replays its receipt after invocation and settlement', async () => {
    const harness = getHarness();
    const repository = harness.repository;
    const report = await preparationAttempt(repository);
    expect(await repository.completeOperation(report)).toEqual({ kind: 'result-required' });
    expect(await repository.reportOperation(report)).toEqual({ kind: 'accepted', binding: report.result.binding });
    const record = await repository.getActiveAttempt(report.executionId, report.executionAttemptId);
    expect(record).toMatchObject({
      activeOperationId: null,
      lastCompletedOperationId: report.operationId,
      preparationReceipts: [
        { operationId: report.operationId, runtimeGeneration: report.runtimeGeneration, result: report.result },
      ],
    });
    expect(
      await repository.admitOperation({
        ...report,
        operationKind: 'workspace-preparation',
        admissionKey: 'prepare-again',
      }),
    ).toEqual({ kind: 'preparation-already-completed' });
    const invocation = await repository.admitOperation({
      ...report,
      operationKind: 'workload-invocation',
      admissionKey: 'invoke',
    });
    expect(invocation.kind).toBe('admitted');
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    if (invocation.kind !== 'admitted') throw new Error('Expected Invocation');
    expect(await repository.completeOperation({ ...report, operationId: invocation.operationId })).toEqual({
      kind: 'result-required',
    });
    await repository.commitOutcome({
      ...report,
      result: repository.canonicalizeOutcome(makeTestWorkflowResult(report.executionId, 'completed')),
    });
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    expect((await repository.getActiveAttempt(report.executionId, report.executionAttemptId))?.activeOperationId).toBe(
      invocation.operationId,
    );
  });

  it('acknowledges historical receipts without preparing the replacement runtime', async () => {
    const harness = getHarness();
    const repository = harness.repository;
    const report = await preparationAttempt(repository);
    await repository.reportOperation(report);
    const runtimeGeneration = await registerTestRuntime(repository, report, 'replacement');
    await proveTestReadiness(repository, report, runtimeGeneration);
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    expect(
      await repository.reportOperation({
        ...report,
        result: { ...report.result, binding: { workspaceRoot: '/changed', sourceRoots: [] } },
      }),
    ).toEqual({ kind: 'conflict' });
    expect(await repository.reportOperation({ ...report, operationId: 'unaccepted-old-operation' })).toEqual({
      kind: 'stale-generation',
    });
    expect(
      await repository.admitOperation({
        ...report,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'invoke-replacement',
      }),
    ).toEqual({ kind: 'preparation-required' });
    const operationId = await admitTestOperation(
      repository,
      report,
      runtimeGeneration,
      'workspace-preparation',
      'prepare-replacement',
    );
    const replacementReport = {
      ...report,
      runtimeGeneration,
      operationId,
      result: { ...report.result, binding: { workspaceRoot: '/scratch/replacement', sourceRoots: [] } },
    };
    expect(await repository.reportOperation(replacementReport)).toEqual({
      kind: 'accepted',
      binding: replacementReport.result.binding,
    });
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    expect(
      (await repository.getActiveAttempt(report.executionId, report.executionAttemptId))?.preparationReceipts,
    ).toHaveLength(2);
    expect(
      await repository.admitOperation({
        ...report,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'invoke-replacement',
      }),
    ).toMatchObject({ kind: 'admitted' });
  });
}
