import { describe, expect, it } from 'vitest';
import {
  ExecutionAttemptControlDeliverySchema,
  ExecutionAttemptControlDeliveryResponseSchema,
  ExecutionAttemptControlReceiptSchema,
  ExecutionAttemptControlReportSchema,
  ExecutionAttemptSchemas,
} from '../index.js';

const correlation = {
  executionAttemptId: 'attempt',
  runtimeIncarnationId: 'runtime',
  runtimeGeneration: 1,
  requestKey: 'stop',
  controlRevision: 1,
};
const receivedAt = '2026-09-10T10:00:00Z';

describe('Attempt control wire contracts', () => {
  it('uses separate delivery receipt and final report contracts', () => {
    expect(ExecutionAttemptSchemas['control.deliver'].request).toBe(ExecutionAttemptControlDeliverySchema);
    expect(ExecutionAttemptSchemas['control.deliver'].response).toBe(ExecutionAttemptControlDeliveryResponseSchema);
    expect(ExecutionAttemptSchemas['control.report'].request).toBe(ExecutionAttemptControlReportSchema);
    const receipt = { ...correlation, receivedAt };
    expect(ExecutionAttemptControlReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(ExecutionAttemptControlDeliveryResponseSchema.parse({ decision: 'received', receipt })).toEqual({
      decision: 'received',
      receipt,
    });
    expect(ExecutionAttemptControlDeliveryResponseSchema.safeParse({ decision: 'achieved', receipt }).success).toBe(
      false,
    );
  });

  it('delivers the original accepted Cancel without turning an operation into its address', () => {
    const delivery = {
      executionAttemptId: 'attempt',
      runtimeIncarnationId: 'runtime',
      runtimeGeneration: 1,
      cancellation: { requestKey: 'stop', controlRevision: 1, requestedAt: receivedAt, reason: 'owner request' },
    };
    expect(ExecutionAttemptControlDeliverySchema.parse(delivery)).toEqual(delivery);
    for (const extra of [{ operationId: 'operation' }, { executionId: 'caller-chosen-owner' }, { force: true }]) {
      expect(ExecutionAttemptControlDeliverySchema.safeParse({ ...delivery, ...extra }).success).toBe(false);
    }
    expect(ExecutionAttemptControlDeliverySchema.safeParse({ ...delivery, runtimeGeneration: 0 }).success).toBe(false);
  });

  it.each([
    'achieved',
    'unsupported',
    'unconfirmed',
  ] as const)('keeps %s as a final scoped report, not a receipt', (status) => {
    const report = {
      ...correlation,
      operationId: 'prepare',
      conclusion: {
        status,
        boundary: 'setup-process-group',
        evidence: {
          source: 'posix-setup',
          summary: 'Driver observation',
          observedAt: receivedAt,
        },
      },
    };
    expect(ExecutionAttemptControlReportSchema.parse(report)).toEqual(report);
    expect(ExecutionAttemptControlReceiptSchema.safeParse(report).success).toBe(false);
    expect(ExecutionAttemptControlReportSchema.safeParse({ ...report, outcome: { kind: 'cancelled' } }).success).toBe(
      false,
    );
    expect(
      ExecutionAttemptControlReportSchema.safeParse({
        ...report,
        conclusion: { ...report.conclusion, evidence: { ...report.conclusion.evidence, stack: 'raw stack' } },
      }).success,
    ).toBe(false);
  });
});
