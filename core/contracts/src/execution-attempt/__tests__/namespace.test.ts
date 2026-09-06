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

  it('carries exactly the five static subjects', () => {
    expect(Object.keys(ExecutionAttemptSchemas)).toStrictEqual([
      'runtime.register',
      'runtime.ready',
      'operation.admit',
      'operation.admitted',
      'operation.deliver',
    ]);
  });

  it('registers every subject token under the execution-attempt namespace', () => {
    const tokens = [
      ExecutionAttemptSubjects.runtime.register,
      ExecutionAttemptSubjects.runtime.ready,
      ExecutionAttemptSubjects.operation.admit,
      ExecutionAttemptSubjects.operation.admitted,
      ExecutionAttemptSubjects.operation.deliver,
    ];

    expect(tokens.map((token) => token.$meta.namespace)).toStrictEqual(Array<string>(5).fill('execution-attempt'));
    expect(tokens.map((token) => token.subject)).toStrictEqual([
      'runtime.register',
      'runtime.ready',
      'operation.admit',
      'operation.admitted',
      'operation.deliver',
    ]);
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
        operationKind: 'workspace-preparation',
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
  it('admits exactly the two operation kinds of this slice', () => {
    expect(ExecutionAttemptOperationKindSchema.options).toStrictEqual(['runtime-probe', 'workflow-run']);
  });
});

describe('ExecutionAttemptAnnouncedOperationKindSchema', () => {
  it('is the operation vocabulary without the runtime probe', () => {
    expect(ExecutionAttemptAnnouncedOperationKindSchema.options).toStrictEqual(['workflow-run']);
  });
});
