import { expect, it } from 'vitest';
import type { ExecutionAttemptControlConclusion, WorkflowRunResult } from '@makaio/contracts';
import type { ReportAttemptControlInput } from '../../attempt-control-evidence.js';
import { makeTestWorkflowResult } from '../attempt-fixtures.js';
import {
  admitTestOperation,
  allocateAttempt,
  nextIds,
  preparationAttempt,
  readyAttempt,
  registerTestRuntime,
  RUNTIME_INCARNATION_ID,
} from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

type Harness = ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>;

/**
 * Construct bounded runtime evidence without conflating it with provider cleanup.
 * @param ids - Exact owner and Attempt scope.
 * @param runtimeGeneration - Registered runtime generation.
 * @param status - Final technical conclusion, including negative findings.
 * @returns An admission-boundary observation for an idle cancelled runtime.
 */
function reportFor(
  ids: { executionId: string; executionAttemptId: string },
  runtimeGeneration: number,
  status: ExecutionAttemptControlConclusion['status'] = 'achieved',
): ReportAttemptControlInput {
  return {
    ...ids,
    runtimeGeneration,
    runtimeIncarnationId: RUNTIME_INCARNATION_ID,
    controlRevision: 1,
    requestKey: 'stop',
    conclusion: {
      status,
      boundary: 'admission-closed',
      evidence: {
        source: 'runtime',
        summary: 'Observed only the declared runtime boundary',
        observedAt: '2026-09-10T12:00:00.000Z',
      },
    },
  };
}

/**
 * Register independent delivery and scoped final-report persistence requirements.
 * @param getHarness - Two real repositories sharing an isolated store.
 */
export function registerAttemptControlEvidenceCases(getHarness: () => Harness): void {
  it.each([
    'achieved',
    'unsupported',
    'unconfirmed',
  ] as const)('accepts a final %s report before its delivery receipt without rewriting either fact', async (status) => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const generation = await readyAttempt(repository, ids);
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const report = reportFor(ids, generation, status);
    expect(await repository.reportAttemptControl(report)).toEqual({ kind: 'accepted' });
    const { executionId, conclusion: _conclusion, ...correlation } = report;
    const receivedAt = '2026-09-10T11:59:59.000Z';
    const receipt = { ...correlation, receivedAt };
    expect(await peer.readAttemptCancellationControl(ids)).toMatchObject({
      evidence: [
        {
          controlRevision: 1,
          runtimeGeneration: generation,
          receipt: null,
          report: { ...correlation, conclusion: report.conclusion },
        },
      ],
    });
    expect(await peer.recordAttemptControlReceipt({ executionId, ...receipt })).toEqual({ kind: 'accepted' });
    expect(await peer.reportAttemptControl(report)).toEqual({ kind: 'duplicate' });
    expect(await peer.recordAttemptControlReceipt({ executionId, ...receipt })).toEqual({ kind: 'duplicate' });
    expect(
      await peer.reportAttemptControl({
        ...report,
        conclusion: { ...report.conclusion, status: status === 'achieved' ? 'unconfirmed' : 'achieved' },
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await peer.recordAttemptControlReceipt({ executionId, ...receipt, receivedAt: '2026-09-10T12:01:00.000Z' }),
    ).toEqual({ kind: 'conflict' });
    expect(await repository.readAttemptCancellationControl(ids)).toMatchObject({
      evidence: [{ receipt, report: { ...correlation, conclusion: report.conclusion } }],
    });
    expect(await repository.readAttemptSettlement(ids)).toMatchObject({ kind: 'unsettled' });
  });

  it('retains historical-generation replay without accepting its first late fact for the new runtime', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const generation = await readyAttempt(repository, ids);
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const report = reportFor(ids, generation);
    expect(await repository.reportAttemptControl(report)).toEqual({ kind: 'accepted' });
    const nextGeneration = await registerTestRuntime(repository, ids, 'replacement-runtime');
    const { conclusion: _conclusion, ...correlation } = report;
    expect(await peer.recordAttemptControlReceipt({ ...correlation, receivedAt: '2026-09-10T12:00:00.000Z' })).toEqual({
      kind: 'stale-generation',
    });
    expect(await peer.reportAttemptControl(report)).toEqual({ kind: 'duplicate' });
    const replacement = { ...report, runtimeGeneration: nextGeneration, runtimeIncarnationId: 'replacement-runtime' };
    expect(await peer.reportAttemptControl(replacement)).toEqual({ kind: 'accepted' });
    expect(await repository.readAttemptCancellationControl(ids)).toMatchObject({
      control: { runtimeGeneration: nextGeneration },
      evidence: [
        { runtimeGeneration: generation, receipt: null, report: { runtimeIncarnationId: RUNTIME_INCARNATION_ID } },
        { runtimeGeneration: nextGeneration, receipt: null, report: { runtimeIncarnationId: 'replacement-runtime' } },
      ],
    });
  });

  it('keeps one final conclusion when independent controllers race to report different observations', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const generation = await readyAttempt(repository, ids);
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const reports = [reportFor(ids, generation, 'achieved'), reportFor(ids, generation, 'unconfirmed')];
    const decisions = await Promise.all([
      repository.reportAttemptControl(reports[0]!),
      peer.reportAttemptControl(reports[1]!),
    ]);
    expect(decisions.map(({ kind }) => kind).sort()).toEqual(['accepted', 'conflict']);
    const winner = reports[decisions[0]!.kind === 'accepted' ? 0 : 1]!;
    expect(await peer.reportAttemptControl(winner)).toEqual({ kind: 'duplicate' });
    expect(await repository.readAttemptCancellationControl(ids)).toMatchObject({
      evidence: [{ report: { conclusion: winner.conclusion } }],
    });
  });

  it('snapshots report input and detaches returned evidence from durable storage', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const generation = await readyAttempt(repository, ids);
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const report = reportFor(ids, generation);
    const original = structuredClone(report);
    const pending = repository.reportAttemptControl(report);
    Object.assign(report.conclusion.evidence, { summary: 'mutated before storage yields' });
    expect(await pending).toEqual({ kind: 'accepted' });
    expect(await peer.reportAttemptControl(original)).toEqual({ kind: 'duplicate' });
    const snapshot = await peer.readAttemptCancellationControl(ids);
    if (snapshot?.evidence[0]?.report === null || snapshot?.evidence[0]?.report === undefined) {
      throw new Error('Expected persisted report');
    }
    Object.assign(snapshot.evidence[0].report.conclusion.evidence, { summary: 'mutated by reader' });
    expect(await repository.readAttemptCancellationControl(ids)).toMatchObject({
      evidence: [{ report: { conclusion: original.conclusion } }],
    });
  });

  it('refuses mismatched owner, Cancel, runtime and operation without manufacturing evidence', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const generation = await readyAttempt(repository, ids);
    const operationId = await admitTestOperation(repository, ids, generation, 'workflow-run', 'work');
    const base = reportFor(ids, generation);
    expect(await peer.reportAttemptControl(base)).toEqual({ kind: 'cancel-mismatch' });
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const report = { ...base, operationId, conclusion: { ...base.conclusion, boundary: 'workload' as const } };
    const cases = [
      { change: { executionId: 'wrong-owner' }, kind: 'not-found' },
      { change: { executionAttemptId: 'unknown' }, kind: 'not-found' },
      { change: { requestKey: 'wrong-request' }, kind: 'cancel-mismatch' },
      { change: { controlRevision: 2 }, kind: 'cancel-mismatch' },
      { change: { runtimeGeneration: generation + 1 }, kind: 'stale-generation' },
      { change: { runtimeIncarnationId: 'wrong-runtime' }, kind: 'stale-generation' },
      { change: { operationId: 'wrong-operation' }, kind: 'operation-mismatch' },
    ];
    for (const { change, kind } of cases) {
      expect(await peer.reportAttemptControl({ ...report, ...change })).toEqual({ kind });
      if (kind !== 'operation-mismatch') {
        const { conclusion: _conclusion, operationId: _operation, ...correlation } = { ...report, ...change };
        expect(
          await peer.recordAttemptControlReceipt({ ...correlation, receivedAt: '2026-09-10T12:00:00.000Z' }),
        ).toEqual({ kind });
      }
    }
    expect(await peer.reportAttemptControl(base)).toEqual({ kind: 'operation-mismatch' });
    expect(await peer.reportAttemptControl({ ...base, operationId })).toEqual({ kind: 'operation-mismatch' });
    expect(await peer.readAttemptCancellationControl({ ...ids, executionId: 'wrong-owner' })).toBeNull();
    expect(await peer.readAttemptCancellationControl(ids)).toMatchObject({ evidence: [] });
    expect(await peer.reportAttemptControl(report)).toEqual({ kind: 'accepted' });
    expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: operationId,
    });
  });

  it('accepts a Setup conclusion after Preparation completed without releasing or replacing its binding', async () => {
    const { repository, peer } = getHarness();
    const preparation = await preparationAttempt(repository);
    expect(await repository.reportOperation(preparation)).toMatchObject({ kind: 'accepted' });
    const ids = { executionId: preparation.executionId, executionAttemptId: preparation.executionAttemptId };
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const base = reportFor(ids, preparation.runtimeGeneration);
    const before = await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(
      await peer.reportAttemptControl({
        ...base,
        operationId: preparation.operationId,
        conclusion: { ...base.conclusion, boundary: 'setup-process-group' },
      }),
    ).toEqual({ kind: 'accepted' });
    expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
  });

  it('accepts the first late report after Completed without changing outcome or its frozen control observation', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const generation = await readyAttempt(repository, ids);
    const operationId = await admitTestOperation(repository, ids, generation, 'workflow-run', 'work');
    const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    await repository.commitOutcome({ ...ids, result });
    const settlement = await repository.readAttemptSettlement(ids);
    expect(settlement).toMatchObject({
      kind: 'outcome',
      controlObservation: { controlRevision: 0, cancellation: null },
    });
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const base = reportFor(ids, generation);
    expect(
      await peer.reportAttemptControl({
        ...base,
        operationId,
        conclusion: { ...base.conclusion, boundary: 'workload' },
      }),
    ).toEqual({ kind: 'accepted' });
    expect(await peer.readAttemptSettlement(ids)).toEqual(settlement);
    expect(await peer.commitOutcome({ ...ids, result })).toMatchObject({
      kind: 'duplicate',
      controlObservation: { controlRevision: 0, cancellation: null },
    });
  });

  it('stores a historical Attempt report without affecting its successor or reopening admission', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const generation = await readyAttempt(repository, ids);
    const operationId = await admitTestOperation(repository, ids, generation, 'workflow-run', 'work');
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
    const successor = { ...ids, executionAttemptId: `${ids.executionAttemptId}-next` };
    await allocateAttempt(repository, successor);
    const before = await peer.recovery.getAttemptWithAllocation(successor.executionAttemptId);
    const base = reportFor(ids, generation);
    expect(
      await peer.reportAttemptControl({
        ...base,
        operationId,
        conclusion: { ...base.conclusion, boundary: 'workload' },
      }),
    ).toEqual({ kind: 'accepted' });
    expect(await peer.recovery.getAttemptWithAllocation(successor.executionAttemptId)).toEqual(before);
    expect(await peer.readAttemptCancellationControl(successor)).toMatchObject({ cancellation: null, evidence: [] });
    expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
  });
}
