import { describe, expect, it } from 'vitest';
import { createBusContext, createBusInstance } from '@makaio/bus-core';
import { ExecutionAttemptNamespace, ExecutionAttemptSubjects } from '@makaio/contracts';
import { createRestartableTempDb } from '@makaio/test-utils/drizzle-harness';
import { reconcileAttemptCancellation } from '../attempt-control-delivery.js';
import type { ReportAttemptControlInput } from '../attempt-control-evidence.js';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import { makeTestWorkflowResult, workflowRunResultOutcomeCodec } from '../testing/index.js';
import { admitTestOperation, readyAttempt, RUNTIME_INCARNATION_ID } from '../testing/conformance/attempt-helpers.js';

describe('SQLite Attempt control evidence durability', () => {
  it('recovers report-before-receipt after all connections close and a new Authority takes over', async () => {
    const store = createRestartableTempDb('attempt-control-report-durability');
    try {
      const repository = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
      const ids = { executionId: 'owner', executionAttemptId: 'attempt' };
      const runtimeGeneration = await readyAttempt(repository, ids);
      const operationId = await admitTestOperation(repository, ids, runtimeGeneration, 'workflow-run', 'work');
      await repository.requestAttemptCancellation({ ...ids, requestKey: 'operator-stop' });
      const report: ReportAttemptControlInput = {
        ...ids,
        operationId,
        requestKey: 'operator-stop',
        controlRevision: 1,
        runtimeGeneration,
        runtimeIncarnationId: RUNTIME_INCARNATION_ID,
        conclusion: {
          status: 'unconfirmed',
          boundary: 'workload',
          evidence: {
            source: 'runtime',
            summary: 'Workload stop could not be confirmed',
            observedAt: '2026-09-10T12:00:00.000Z',
          },
        },
      };
      expect(await authority.reportAttemptControl(report)).toEqual({ kind: 'accepted' });
      const snapshot = await authority.readAttemptCancellationControl(ids);
      expect(snapshot).toMatchObject({ evidence: [{ receipt: null, report: { conclusion: report.conclusion } }] });
      await store.closeConnections();

      const restarted = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const recovered = new ExecutionAttemptAuthority(restarted, { bootstrapTimeoutMs: 60_000 });
      expect(await recovered.readAttemptCancellationControl(ids)).toEqual(snapshot);
      expect(await recovered.reportAttemptControl(report)).toEqual({ kind: 'duplicate' });
      expect(
        await recovered.reportAttemptControl({ ...report, conclusion: { ...report.conclusion, status: 'achieved' } }),
      ).toEqual({ kind: 'conflict' });
      const { conclusion: _conclusion, operationId: _operation, ...correlation } = report;
      const receipt = { ...correlation, receivedAt: '2026-09-10T11:59:59.000Z' };
      const { executionId: _owner, ...wireReceipt } = receipt;
      const bus = createBusInstance({ context: createBusContext() });
      bus.registerNamespace(ExecutionAttemptNamespace);
      let deliveries = 0;
      // This real protocol responder confirms delivery, not an actual runtime stop.
      const unregister = bus
        .withFilter({ executionAttemptId: ids.executionAttemptId, runtimeIncarnationId: RUNTIME_INCARNATION_ID })
        .on(ExecutionAttemptSubjects.control.deliver, (ctx) => {
          deliveries += 1;
          ctx.setResult({ decision: 'received', receipt: wireReceipt });
        });
      try {
        expect(await reconcileAttemptCancellation({ bus, authority: recovered }, { ...ids, timeoutMs: 1_000 })).toEqual(
          {
            kind: 'received',
            persistence: { kind: 'accepted' },
          },
        );
        expect(await reconcileAttemptCancellation({ bus, authority: recovered }, { ...ids, timeoutMs: 1_000 })).toEqual(
          { kind: 'evidence-complete' },
        );
        expect(deliveries).toBe(1);
      } finally {
        unregister();
      }
      expect(await recovered.readAttemptSettlement(ids)).toMatchObject({ kind: 'unsettled' });
      await store.closeConnections();

      const finalRepository = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const finalAuthority = new ExecutionAttemptAuthority(finalRepository, { bootstrapTimeoutMs: 60_000 });
      expect(await finalAuthority.recordAttemptControlReceipt(receipt)).toEqual({ kind: 'duplicate' });
      expect(await finalAuthority.readAttemptCancellationControl(ids)).toMatchObject({
        evidence: [{ receipt: { receivedAt: receipt.receivedAt }, report: { conclusion: report.conclusion } }],
      });
    } finally {
      await store.close();
    }
  });

  it('persists the first report after outcome settlement without rewriting its frozen observation', async () => {
    const store = createRestartableTempDb('attempt-control-late-report-durability');
    try {
      const repository = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const ids = { executionId: 'owner', executionAttemptId: 'attempt' };
      const runtimeGeneration = await readyAttempt(repository, ids);
      const operationId = await admitTestOperation(repository, ids, runtimeGeneration, 'workflow-run', 'work');
      const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
      await repository.commitOutcome({ ...ids, result });
      const before = await repository.readAttemptSettlement(ids);
      expect(before).toMatchObject({ kind: 'outcome', controlObservation: { controlRevision: 0, cancellation: null } });
      await repository.requestAttemptCancellation({ ...ids, requestKey: 'cleanup' });
      await store.closeConnections();

      const restarted = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const authority = new ExecutionAttemptAuthority(restarted, { bootstrapTimeoutMs: 60_000 });
      const report: ReportAttemptControlInput = {
        ...ids,
        operationId,
        requestKey: 'cleanup',
        controlRevision: 1,
        runtimeGeneration,
        runtimeIncarnationId: RUNTIME_INCARNATION_ID,
        conclusion: {
          status: 'achieved',
          boundary: 'workload',
          evidence: {
            source: 'runtime',
            summary: 'Workload invocation stopped',
            observedAt: '2026-09-10T12:00:00.000Z',
          },
        },
      };
      expect(await authority.reportAttemptControl(report)).toEqual({ kind: 'accepted' });
      await store.closeConnections();

      const finalRepository = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const finalAuthority = new ExecutionAttemptAuthority(finalRepository, { bootstrapTimeoutMs: 60_000 });
      expect(await finalAuthority.readAttemptSettlement(ids)).toEqual(before);
      expect(await finalAuthority.reportAttemptControl(report)).toEqual({ kind: 'duplicate' });
      expect(await finalAuthority.readAttemptCancellationControl(ids)).toMatchObject({
        evidence: [{ receipt: null, report: { operationId, conclusion: report.conclusion } }],
      });
    } finally {
      await store.close();
    }
  });
});
