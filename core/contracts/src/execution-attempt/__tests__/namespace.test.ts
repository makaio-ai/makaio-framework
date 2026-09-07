import { describe, expect, it } from 'vitest';
import { FrameworkContractNamespaces } from '../../namespace-catalog.js';
import {
  ExecutionAttemptOperationDeliverySchema,
  ExecutionAttemptAnnouncedOperationKindSchema,
  ExecutionAttemptOperationKindSchema,
  ExecutionAttemptOperationReceiptSchema,
  ExecutionAttemptSchemas,
  ExecutionAttemptSubjects,
} from '../index.js';

const ATTEMPT_ID = 'attempt-1';
const OPERATION_ID = 'operation-1';
const ACCEPTED_AT = '2026-09-04T10:00:00.000Z';

describe('ExecutionAttempt namespace', () => {
  it('is a member of FrameworkContractNamespaces', () => {
    const names = FrameworkContractNamespaces.map((ns) => ns.name);
    expect(names).toContain('execution-attempt');
  });

  it('carries the static Attempt subjects without a separate readiness producer', () => {
    expect(Object.keys(ExecutionAttemptSchemas)).toStrictEqual([
      'bootstrap.awaitStart',
      'runtime.register',
      'runtime.ready',
      'operation.admit',
      'operation.admitted',
      'operation.deliver',
      'instruction.get',
      'operation.report',
      'outcome.submit',
    ]);
  });

  it('registers every subject token under the execution-attempt namespace', () => {
    const tokens = [
      ExecutionAttemptSubjects.bootstrap.awaitStart,
      ExecutionAttemptSubjects.runtime.register,
      ExecutionAttemptSubjects.runtime.ready,
      ExecutionAttemptSubjects.operation.admit,
      ExecutionAttemptSubjects.operation.admitted,
      ExecutionAttemptSubjects.operation.deliver,
      ExecutionAttemptSubjects.instruction.get,
      ExecutionAttemptSubjects.operation.report,
      ExecutionAttemptSubjects.outcome.submit,
    ];

    expect(tokens.map((token) => token.$meta.namespace)).toStrictEqual(Array<string>(9).fill('execution-attempt'));
    expect(tokens.map((token) => token.subject)).toStrictEqual([
      'bootstrap.awaitStart',
      'runtime.register',
      'runtime.ready',
      'operation.admit',
      'operation.admitted',
      'operation.deliver',
      'instruction.get',
      'operation.report',
      'outcome.submit',
    ]);
  });
});

describe('bootstrap.awaitStart contract', () => {
  const schema = ExecutionAttemptSchemas['bootstrap.awaitStart'];

  it('accepts only an attempt identity, never caller-selected authorization or timing', () => {
    expect(schema.request.parse({ executionAttemptId: ATTEMPT_ID })).toEqual({ executionAttemptId: ATTEMPT_ID });
    for (const extra of [{ executionId: 'owner' }, { timeoutMs: 123 }, { providerId: 'provider' }]) {
      expect(schema.request.safeParse({ executionAttemptId: ATTEMPT_ID, ...extra }).success).toBe(false);
    }
    expect(schema.request.safeParse({ executionAttemptId: '' }).success).toBe(false);
  });

  it('keeps permission and pending responses free of secrets, allocation and runtime fences', () => {
    for (const status of ['permitted', 'pending']) {
      expect(schema.response.parse({ status })).toEqual({ status });
      for (const extra of [{ busAuthSecret: 'secret' }, { runtimeGeneration: 1 }, { allocationRef: {} }]) {
        expect(schema.response.safeParse({ status, ...extra }).success).toBe(false);
      }
    }
  });

  it('requires a closed non-secret refusal vocabulary', () => {
    for (const reason of [
      'not-found',
      'resolved',
      'fenced',
      'allocation-terminated',
      'gate-closed',
      'bootstrap-expired',
    ]) {
      expect(schema.response.parse({ status: 'refused', reason })).toEqual({ status: 'refused', reason });
    }
    expect(schema.response.safeParse({ status: 'refused' }).success).toBe(false);
    expect(schema.response.safeParse({ status: 'refused', reason: 'provider-mismatch' }).success).toBe(false);
    expect(schema.response.safeParse({ status: 'refused', reason: 'fenced', runtimeEnv: {} }).success).toBe(false);
  });
});

describe('runtime.register contract', () => {
  it('accepts a registration report', () => {
    const parsed = ExecutionAttemptSchemas['runtime.register'].request.parse({
      executionAttemptId: ATTEMPT_ID,
      runtimeIncarnationId: 'incarnation-1',
    });

    expect(parsed).toStrictEqual({ executionAttemptId: ATTEMPT_ID, runtimeIncarnationId: 'incarnation-1' });
  });

  it('rejects a registration report with unknown fields', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].request.safeParse({
        executionAttemptId: ATTEMPT_ID,
        runtimeIncarnationId: 'incarnation-1',
        executionId: 'exec-1',
      }).success,
    ).toBe(false);
  });

  it('rejects a registration report without a runtime incarnation', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].request.safeParse({ executionAttemptId: ATTEMPT_ID }).success,
    ).toBe(false);
  });

  it('accepts a ready decision with a generation', () => {
    const parsed = ExecutionAttemptSchemas['runtime.register'].response.parse({
      decision: 'ready',
      runtimeGeneration: 1,
    });

    expect(parsed).toStrictEqual({ decision: 'ready', runtimeGeneration: 1 });
  });

  it('accepts a duplicate decision', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].response.parse({ decision: 'duplicate', runtimeGeneration: 2 })
        .decision,
    ).toBe('duplicate');
  });

  it('accepts a refused decision carrying a probe failure', () => {
    const parsed = ExecutionAttemptSchemas['runtime.register'].response.parse({
      decision: 'refused',
      runtimeGeneration: 0,
      refusalReason: 'probe-failed',
    });

    expect(parsed).toStrictEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'probe-failed' });
  });

  it('rejects a refusal reason outside the register vocabulary', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].response.safeParse({
        decision: 'refused',
        runtimeGeneration: 0,
        refusalReason: 'gate-closed',
      }).success,
    ).toBe(false);
  });

  it('rejects a negative runtime generation', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].response.safeParse({ decision: 'ready', runtimeGeneration: -1 })
        .success,
    ).toBe(false);
  });

  it('rejects a ready decision at generation zero', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].response.safeParse({ decision: 'ready', runtimeGeneration: 0 })
        .success,
    ).toBe(false);
  });

  it('rejects a duplicate decision at generation zero', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].response.safeParse({ decision: 'duplicate', runtimeGeneration: 0 })
        .success,
    ).toBe(false);
  });

  it('rejects a refusal carrying a generation', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].response.safeParse({
        decision: 'refused',
        runtimeGeneration: 1,
        refusalReason: 'fenced',
      }).success,
    ).toBe(false);
  });

  it('rejects a refusal without a reason', () => {
    expect(
      ExecutionAttemptSchemas['runtime.register'].response.safeParse({ decision: 'refused', runtimeGeneration: 0 })
        .success,
    ).toBe(false);
  });
});

describe('runtime.ready contract', () => {
  it('accepts a readiness announcement', () => {
    const parsed = ExecutionAttemptSchemas['runtime.ready'].parse({
      executionAttemptId: ATTEMPT_ID,
      runtimeGeneration: 1,
      acceptedAt: ACCEPTED_AT,
    });

    expect(parsed).toStrictEqual({
      executionAttemptId: ATTEMPT_ID,
      runtimeGeneration: 1,
      acceptedAt: ACCEPTED_AT,
    });
  });

  it('rejects a readiness announcement carrying executionId', () => {
    expect(
      ExecutionAttemptSchemas['runtime.ready'].safeParse({
        executionAttemptId: ATTEMPT_ID,
        runtimeGeneration: 1,
        acceptedAt: ACCEPTED_AT,
        executionId: 'exec-1',
      }).success,
    ).toBe(false);
  });

  it('rejects a readiness announcement at generation zero', () => {
    expect(
      ExecutionAttemptSchemas['runtime.ready'].safeParse({
        executionAttemptId: ATTEMPT_ID,
        runtimeGeneration: 0,
        acceptedAt: ACCEPTED_AT,
      }).success,
    ).toBe(false);
  });
});

describe('operation.admit contract', () => {
  it('accepts an admission command for the runtime probe', () => {
    const parsed = ExecutionAttemptSchemas['operation.admit'].request.parse({
      executionAttemptId: ATTEMPT_ID,
      operationKind: 'runtime-probe',
      admissionKey: 'probe-1',
      runtimeGeneration: 1,
    });

    expect(parsed.operationKind).toBe('runtime-probe');
  });

  it('rejects an unknown operation kind', () => {
    expect(
      ExecutionAttemptSchemas['operation.admit'].request.safeParse({
        executionAttemptId: ATTEMPT_ID,
        operationKind: 'arbitrary-stage',
        admissionKey: 'key-1',
        runtimeGeneration: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects an admission command without an admission key', () => {
    expect(
      ExecutionAttemptSchemas['operation.admit'].request.safeParse({
        executionAttemptId: ATTEMPT_ID,
        operationKind: 'workflow-run',
        runtimeGeneration: 1,
      }).success,
    ).toBe(false);
  });

  it('accepts an admitted decision with an operation id', () => {
    const parsed = ExecutionAttemptSchemas['operation.admit'].response.parse({
      decision: 'admitted',
      operationId: OPERATION_ID,
    });

    expect(parsed).toStrictEqual({ decision: 'admitted', operationId: OPERATION_ID });
  });

  it('accepts a duplicate decision', () => {
    expect(
      ExecutionAttemptSchemas['operation.admit'].response.parse({ decision: 'duplicate', operationId: OPERATION_ID })
        .decision,
    ).toBe('duplicate');
  });

  it('accepts a refused decision for a closed gate', () => {
    const parsed = ExecutionAttemptSchemas['operation.admit'].response.parse({
      decision: 'refused',
      refusalReason: 'gate-closed',
    });

    expect(parsed).toStrictEqual({ decision: 'refused', refusalReason: 'gate-closed' });
  });

  it('rejects a refusal reason outside the admit vocabulary', () => {
    expect(
      ExecutionAttemptSchemas['operation.admit'].response.safeParse({
        decision: 'refused',
        refusalReason: 'probe-failed',
      }).success,
    ).toBe(false);
  });
});

describe('operation.admitted contract', () => {
  it('accepts an admission announcement', () => {
    const parsed = ExecutionAttemptSchemas['operation.admitted'].parse({
      executionAttemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      operationKind: 'workflow-run',
      runtimeGeneration: 1,
      admittedAt: ACCEPTED_AT,
    });

    expect(parsed.operationKind).toBe('workflow-run');
  });

  it('rejects an admission announcement without an operation id', () => {
    expect(
      ExecutionAttemptSchemas['operation.admitted'].safeParse({
        executionAttemptId: ATTEMPT_ID,
        operationKind: 'workflow-run',
        runtimeGeneration: 1,
        admittedAt: ACCEPTED_AT,
      }).success,
    ).toBe(false);
  });

  it('rejects an admission announcement for the runtime probe', () => {
    expect(
      ExecutionAttemptSchemas['operation.admitted'].safeParse({
        executionAttemptId: ATTEMPT_ID,
        operationId: OPERATION_ID,
        operationKind: 'runtime-probe',
        runtimeGeneration: 1,
        admittedAt: ACCEPTED_AT,
      }).success,
    ).toBe(false);
  });

  it('rejects an admission announcement with unknown fields', () => {
    expect(
      ExecutionAttemptSchemas['operation.admitted'].safeParse({
        executionAttemptId: ATTEMPT_ID,
        operationId: OPERATION_ID,
        operationKind: 'workflow-run',
        runtimeGeneration: 1,
        admittedAt: ACCEPTED_AT,
        adapters: [],
      }).success,
    ).toBe(false);
  });
});

describe('operation.deliver contract', () => {
  it('reuses the exported delivery and receipt schemas', () => {
    expect(ExecutionAttemptSchemas['operation.deliver'].request).toBe(ExecutionAttemptOperationDeliverySchema);
    expect(ExecutionAttemptSchemas['operation.deliver'].response).toBe(ExecutionAttemptOperationReceiptSchema);
  });

  it('accepts a delivery addressed to an incarnation', () => {
    const parsed = ExecutionAttemptOperationDeliverySchema.parse({
      executionAttemptId: ATTEMPT_ID,
      runtimeIncarnationId: 'incarnation-1',
      operationId: OPERATION_ID,
      operationKind: 'runtime-probe',
      runtimeGeneration: 1,
    });

    expect(parsed).toStrictEqual({
      executionAttemptId: ATTEMPT_ID,
      runtimeIncarnationId: 'incarnation-1',
      operationId: OPERATION_ID,
      operationKind: 'runtime-probe',
      runtimeGeneration: 1,
    });
  });

  it('rejects a delivery without a fencing generation', () => {
    expect(
      ExecutionAttemptOperationDeliverySchema.safeParse({
        executionAttemptId: ATTEMPT_ID,
        runtimeIncarnationId: 'incarnation-1',
        operationId: OPERATION_ID,
        operationKind: 'runtime-probe',
      }).success,
    ).toBe(false);
  });

  it('rejects a delivery that names no incarnation', () => {
    // The incarnation is half of the runtime's subscription filter; a delivery
    // without it could be answered by a stale incarnation of the same attempt.
    expect(
      ExecutionAttemptOperationDeliverySchema.safeParse({
        executionAttemptId: ATTEMPT_ID,
        operationId: OPERATION_ID,
        operationKind: 'runtime-probe',
        runtimeGeneration: 1,
      }).success,
    ).toBe(false);
  });

  it('accepts a completed receipt', () => {
    expect(ExecutionAttemptOperationReceiptSchema.parse({ receipt: 'completed' })).toStrictEqual({
      receipt: 'completed',
    });
  });

  it('accepts a duplicate receipt', () => {
    expect(ExecutionAttemptOperationReceiptSchema.parse({ receipt: 'duplicate' }).receipt).toBe('duplicate');
  });

  it('accepts a refused receipt with a delivery refusal reason', () => {
    const parsed = ExecutionAttemptOperationReceiptSchema.parse({
      receipt: 'refused',
      refusalReason: 'stale-generation',
    });

    expect(parsed.refusalReason).toBe('stale-generation');
  });

  it('rejects a refusal reason outside the delivery vocabulary', () => {
    expect(
      ExecutionAttemptOperationReceiptSchema.safeParse({ receipt: 'refused', refusalReason: 'not-found' }).success,
    ).toBe(false);
  });
});

describe('ExecutionAttemptOperationKindSchema', () => {
  it('admits the fixed technical sequence and the existing workflow adapter path', () => {
    expect(ExecutionAttemptOperationKindSchema.options).toStrictEqual([
      'runtime-probe',
      'workflow-run',
      'workspace-preparation',
      'workload-invocation',
    ]);
  });
});

describe('ExecutionAttemptAnnouncedOperationKindSchema', () => {
  it('is the operation vocabulary without the runtime probe', () => {
    expect(ExecutionAttemptAnnouncedOperationKindSchema.options).toStrictEqual([
      'workflow-run',
      'workspace-preparation',
      'workload-invocation',
    ]);
  });
});

describe('instruction and result contracts', () => {
  const instruction = {
    id: 'instruction-1',
    revision: '1',
    workload: { kind: 'test', version: '1', input: { answer: 42 } },
    preservation: { required: [] },
  };
  const binding = { workspaceRoot: '/work/attempt-1', sourceRoots: [] };

  it('returns a frozen instruction without a workflow execution identity', () => {
    expect(ExecutionAttemptSchemas['instruction.get'].response.parse({ decision: 'found', instruction })).toStrictEqual(
      { decision: 'found', instruction },
    );
    expect(
      ExecutionAttemptSchemas['instruction.get'].request.safeParse({
        executionAttemptId: ATTEMPT_ID,
        runtimeGeneration: 0,
      }).success,
    ).toBe(false);
  });

  it('requires the instruction on a found response', () => {
    expect(ExecutionAttemptSchemas['instruction.get'].response.safeParse({ decision: 'found' }).success).toBe(false);
  });

  it('accepts Preparation success with operation and runtime fences', () => {
    const report = {
      executionAttemptId: ATTEMPT_ID,
      runtimeGeneration: 1,
      operationId: OPERATION_ID,
      result: { kind: 'workspace-prepared', binding },
    };
    expect(ExecutionAttemptSchemas['operation.report'].request.parse(report)).toStrictEqual(report);
    expect(
      ExecutionAttemptSchemas['operation.report'].response.parse({ decision: 'duplicate', binding }),
    ).toStrictEqual({ decision: 'duplicate', binding });
  });

  it('does not confuse a failed Preparation with non-terminal success', () => {
    expect(
      ExecutionAttemptSchemas['operation.report'].request.safeParse({
        executionAttemptId: ATTEMPT_ID,
        runtimeGeneration: 1,
        operationId: OPERATION_ID,
        result: { kind: 'technical-failure', stage: 'workspace-preparation', message: 'Setup exited 1' },
      }).success,
    ).toBe(false);
  });

  it('requires a semantic binding in an accepted Preparation response', () => {
    expect(ExecutionAttemptSchemas['operation.report'].response.safeParse({ decision: 'accepted' }).success).toBe(
      false,
    );
  });

  it('accepts a missing-adapter failure before any operation exists', () => {
    const request = {
      executionAttemptId: ATTEMPT_ID,
      runtimeGeneration: 1,
      outcome: { kind: 'technical-failure', stage: 'startup', message: 'Adapter unavailable' },
    };
    expect(ExecutionAttemptSchemas['outcome.submit'].request.parse(request)).toStrictEqual(request);
  });

  it('requires an operation for an Invocation result or Preparation failure', () => {
    for (const outcome of [
      { kind: 'workload-result', result: { answer: 42 } },
      { kind: 'technical-failure', stage: 'workspace-preparation', message: 'Setup exited 1' },
      { kind: 'technical-failure', stage: 'workload-invocation', message: 'Import failed' },
    ]) {
      expect(
        ExecutionAttemptSchemas['outcome.submit'].request.safeParse({
          executionAttemptId: ATTEMPT_ID,
          runtimeGeneration: 1,
          outcome,
        }).success,
      ).toBe(false);
      expect(
        ExecutionAttemptSchemas['outcome.submit'].request.safeParse({
          executionAttemptId: ATTEMPT_ID,
          runtimeGeneration: 1,
          operationId: OPERATION_ID,
          outcome,
        }).success,
      ).toBe(true);
    }
  });

  it('accepts cooperative cancellation with no operation or the operation that stopped', () => {
    const request = {
      executionAttemptId: ATTEMPT_ID,
      runtimeGeneration: 1,
      outcome: { kind: 'cancelled', reason: 'Stopped before invocation' },
    };
    expect(ExecutionAttemptSchemas['outcome.submit'].request.parse(request)).toStrictEqual(request);
    expect(
      ExecutionAttemptSchemas['outcome.submit'].request.parse({ ...request, operationId: OPERATION_ID }),
    ).toStrictEqual({ ...request, operationId: OPERATION_ID });
    expect(
      ExecutionAttemptSchemas['outcome.submit'].request.safeParse({ ...request, runtimeGeneration: 0 }).success,
    ).toBe(false);
  });

  it('keeps terminal ACK vocabulary aligned with canonical outcome acceptance', () => {
    for (const decision of ['accepted', 'duplicate', 'conflict', 'fenced']) {
      expect(ExecutionAttemptSchemas['outcome.submit'].response.parse({ decision })).toStrictEqual({ decision });
    }
  });
});
