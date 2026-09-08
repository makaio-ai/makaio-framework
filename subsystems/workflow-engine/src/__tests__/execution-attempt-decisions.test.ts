import { describe, expect, it } from 'vitest';
import {
  evaluateAttemptReachability,
  evaluateOperationAdmission,
  evaluateOperationCompletion,
  evaluatePreparationReport,
  evaluateProvisionerIncarnationLoss,
  evaluateRuntimeReadiness,
  evaluateRuntimeRegistration,
  type AdmitOperationInput,
  type AttemptControlState,
  type AttemptExecutionState,
  type AttemptReachability,
  type ReportOperationInput,
} from '../execution-attempt-repository.js';

const STORED_AT = '2026-09-06T12:00:00.000Z';
const FALLBACK_AT = '2026-09-06T13:00:00.000Z';
const IDS = { executionId: 'owner', executionAttemptId: 'attempt' };
const EXECUTION: AttemptExecutionState = {
  instruction: {
    id: 'instruction',
    revision: '1',
    workload: { kind: 'test', version: '1', input: {} },
    preservation: { required: [] },
  },
  preparationReceipts: [],
};
const WORKSPACE_EXECUTION: AttemptExecutionState = {
  ...EXECUTION,
  instruction: {
    ...EXECUTION.instruction,
    workspace: {
      provisioning: 'create',
      custody: 'disposable',
      sourceRoots: [{ id: 'sources', path: 'sources' }],
      setup: [],
    },
  },
};
const REPORT: ReportOperationInput = {
  ...IDS,
  runtimeGeneration: 7,
  operationId: 'preparation',
  result: {
    kind: 'workspace-prepared',
    binding: { workspaceRoot: '/workspace', sourceRoots: [{ id: 'sources', path: '/workspace/sources' }] },
  },
};
const PREPARED_EXECUTION: AttemptExecutionState = {
  ...WORKSPACE_EXECUTION,
  preparationReceipts: [{ operationId: REPORT.operationId, runtimeGeneration: 7, result: REPORT.result }],
};
const CONTROL: AttemptControlState = Object.freeze({
  runtimeGeneration: 7,
  runtimeIncarnationId: 'incarnation',
  runtimeReadyAt: STORED_AT,
  operationStartGate: 'open',
  activeOperationId: null,
  activeOperationKind: null,
  activeOperationKey: null,
  activeOperationGeneration: null,
  activeOperationAdmittedAt: null,
  lastCompletedOperationId: null,
});
const BUSY: AttemptControlState = Object.freeze({
  ...CONTROL,
  activeOperationId: 'operation',
  activeOperationKind: 'workflow-run',
  activeOperationKey: 'key',
  activeOperationGeneration: 5,
  activeOperationAdmittedAt: STORED_AT,
});
const ADMISSION: AdmitOperationInput = Object.freeze({
  ...IDS,
  runtimeGeneration: 7,
  operationKind: 'workflow-run',
  admissionKey: 'key',
});

describe('attempt reachability precedence', () => {
  const cases: ReadonlyArray<readonly [AttemptReachability, string | null]> = [
    [{ matchesExecution: false, settled: true, active: false, allocated: false }, 'not-found'],
    [{ matchesExecution: true, settled: true, active: false, allocated: false }, 'resolved'],
    [{ matchesExecution: true, settled: false, active: false, allocated: false }, 'fenced'],
    [{ matchesExecution: true, settled: false, active: true, allocated: false }, 'not-allocated'],
    [{ matchesExecution: true, settled: false, active: true, allocated: true }, null],
  ];

  it.each(cases)('evaluates %j as %s without modifying facts', (facts, expected) => {
    const before = { ...facts };
    expect(evaluateAttemptReachability(Object.freeze(facts))?.kind ?? null).toBe(expected);
    expect(facts).toEqual(before);
  });
});

describe('provisioner incarnation loss applicability', () => {
  const allocationRef = Object.freeze({
    version: 1 as const,
    providerId: 'provider',
    providerData: Object.freeze({ id: 'allocation' }),
  });
  const attempt: Parameters<typeof evaluateProvisionerIncarnationLoss>[0] = Object.freeze({
    executionId: IDS.executionId,
    allocationLifetime: 'provisioner-process-bound',
    provisionerIncarnationId: 'provisioner',
    allocationRef: null,
  });
  const input: Parameters<typeof evaluateProvisionerIncarnationLoss>[1] = Object.freeze({
    executionId: IDS.executionId,
    proof: Object.freeze({
      kind: 'provisioner-incarnation-lost',
      provisionerIncarnationId: 'provisioner',
      evidence: Object.freeze({ source: 'provider', summary: 'Provisioner exited', observedAt: STORED_AT }),
    }),
  });

  it('checks owner identity before lifetime, incarnation, and allocation', () => {
    expect(
      evaluateProvisionerIncarnationLoss(
        Object.freeze({
          ...attempt,
          executionId: 'another-owner',
          allocationLifetime: 'provider-managed',
          provisionerIncarnationId: 'another-provisioner',
          allocationRef,
        }),
        input,
      ),
    ).toEqual({ kind: 'not-found' });
  });

  it.each([
    'provider-managed',
    null,
  ] as const)('reports stored lifetime %s before incarnation and allocation', (allocationLifetime) => {
    expect(
      evaluateProvisionerIncarnationLoss(
        Object.freeze({
          ...attempt,
          allocationLifetime,
          provisionerIncarnationId: 'another-provisioner',
          allocationRef,
        }),
        input,
      ),
    ).toEqual({ kind: 'not-process-bound', allocationLifetime });
  });

  it.each([
    'another-provisioner',
    null,
  ])('reports stored incarnation %s before allocation', (provisionerIncarnationId) => {
    expect(
      evaluateProvisionerIncarnationLoss(
        Object.freeze({
          ...attempt,
          provisionerIncarnationId,
          allocationRef,
        }),
        input,
      ),
    ).toEqual({ kind: 'incarnation-mismatch', provisionerIncarnationId });
  });

  it('returns the stored allocation for an otherwise applicable loss proof', () => {
    expect(evaluateProvisionerIncarnationLoss(Object.freeze({ ...attempt, allocationRef }), input)).toEqual({
      kind: 'allocated',
      allocationRef,
    });
  });

  it('permits the guarded write without modifying the input or attempt', () => {
    const before = structuredClone({ attempt, input });
    expect(evaluateProvisionerIncarnationLoss(attempt, input)).toBeNull();
    expect({ attempt, input }).toEqual(before);
  });
});

describe('runtime registration decisions', () => {
  it('replays the stored incarnation before refusing an active workload', () => {
    expect(evaluateRuntimeRegistration(BUSY, { ...IDS, runtimeIncarnationId: 'incarnation' })).toEqual({
      kind: 'duplicate',
      runtimeGeneration: 7,
      runtimeReadyAt: STORED_AT,
    });
  });

  it('refuses a new incarnation during workload but permits reclaiming an orphaned probe', () => {
    const input = Object.freeze({ ...IDS, runtimeIncarnationId: 'replacement' });
    expect(evaluateRuntimeRegistration(BUSY, input)).toEqual({ kind: 'operation-active', operationId: 'operation' });
    expect(
      evaluateRuntimeRegistration(Object.freeze({ ...BUSY, activeOperationKind: 'runtime-probe' }), input),
    ).toBeNull();
    expect(evaluateRuntimeRegistration(CONTROL, input)).toBeNull();
    expect(input.runtimeIncarnationId).toBe('replacement');
  });
});

describe('operation admission decisions', () => {
  it('replays stored operation generation and time before gate, readiness, and generation refusals', () => {
    const control: AttemptControlState = Object.freeze({ ...BUSY, operationStartGate: 'closed', runtimeReadyAt: null });
    expect(
      evaluateOperationAdmission(control, { ...ADMISSION, runtimeGeneration: 99 }, FALLBACK_AT, EXECUTION),
    ).toEqual({
      kind: 'duplicate',
      operationId: 'operation',
      runtimeGeneration: 5,
      admittedAt: STORED_AT,
    });
    expect(control).toEqual({ ...BUSY, operationStartGate: 'closed', runtimeReadyAt: null });
  });

  it('uses realization-supplied fallback facts only when the stored duplicate lacks them', () => {
    const control: AttemptControlState = Object.freeze({
      ...BUSY,
      activeOperationGeneration: null,
      activeOperationAdmittedAt: null,
    });
    expect(evaluateOperationAdmission(control, ADMISSION, FALLBACK_AT, EXECUTION)).toEqual({
      kind: 'duplicate',
      operationId: 'operation',
      runtimeGeneration: 7,
      admittedAt: FALLBACK_AT,
    });
  });

  it('refuses another occupied slot before the closed gate', () => {
    expect(
      evaluateOperationAdmission(
        Object.freeze({ ...BUSY, operationStartGate: 'closed', runtimeReadyAt: null }),
        { ...ADMISSION, admissionKey: 'other', runtimeGeneration: 99 },
        FALLBACK_AT,
        EXECUTION,
      ),
    ).toEqual({ kind: 'operation-active', operationId: 'operation' });
  });

  it('refuses the gate before readiness and readiness before a stale generation', () => {
    const stale = Object.freeze({ ...ADMISSION, runtimeGeneration: 99 });
    expect(
      evaluateOperationAdmission(
        Object.freeze({ ...CONTROL, operationStartGate: 'closed', runtimeReadyAt: null }),
        stale,
        FALLBACK_AT,
        EXECUTION,
      ),
    ).toEqual({ kind: 'gate-closed' });
    expect(
      evaluateOperationAdmission(Object.freeze({ ...CONTROL, runtimeReadyAt: null }), stale, FALLBACK_AT, EXECUTION),
    ).toEqual({ kind: 'not-ready' });
    expect(evaluateOperationAdmission(CONTROL, stale, FALLBACK_AT, EXECUTION)).toEqual({
      kind: 'stale-generation',
      runtimeGeneration: 7,
    });
  });

  it('permits a probe without readiness but still fences its generation', () => {
    const control = Object.freeze({ ...CONTROL, runtimeReadyAt: null });
    const probe: AdmitOperationInput = Object.freeze({ ...ADMISSION, operationKind: 'runtime-probe' });
    expect(evaluateOperationAdmission(control, probe, FALLBACK_AT, EXECUTION)).toBeNull();
    expect(evaluateOperationAdmission(control, { ...probe, runtimeGeneration: 99 }, FALLBACK_AT, EXECUTION)).toEqual({
      kind: 'stale-generation',
      runtimeGeneration: 7,
    });
    expect(evaluateOperationAdmission(CONTROL, ADMISSION, FALLBACK_AT, EXECUTION)).toBeNull();
  });

  it('requires current Preparation for both generic Invocation and the retained workflow operation', () => {
    for (const operationKind of ['workload-invocation', 'workflow-run'] as const) {
      const input = { ...ADMISSION, operationKind };
      expect(evaluateOperationAdmission(CONTROL, input, FALLBACK_AT, WORKSPACE_EXECUTION)).toEqual({
        kind: 'preparation-required',
      });
      expect(evaluateOperationAdmission(CONTROL, input, FALLBACK_AT, PREPARED_EXECUTION)).toBeNull();
      expect(
        evaluateOperationAdmission(
          { ...CONTROL, runtimeGeneration: 8 },
          { ...input, runtimeGeneration: 8 },
          FALLBACK_AT,
          PREPARED_EXECUTION,
        ),
      ).toEqual({ kind: 'preparation-required' });
      expect(evaluateOperationAdmission(CONTROL, input, FALLBACK_AT, EXECUTION)).toBeNull();
    }
  });

  it('refuses unnecessary or repeated Preparation but permits preparation of a replacement runtime', () => {
    const input = { ...ADMISSION, operationKind: 'workspace-preparation' as const, admissionKey: 'fresh-key' };
    expect(evaluateOperationAdmission(CONTROL, input, FALLBACK_AT, EXECUTION)).toEqual({
      kind: 'preparation-not-required',
    });
    expect(evaluateOperationAdmission(CONTROL, input, FALLBACK_AT, WORKSPACE_EXECUTION)).toBeNull();
    expect(evaluateOperationAdmission(CONTROL, input, FALLBACK_AT, PREPARED_EXECUTION)).toEqual({
      kind: 'preparation-already-completed',
    });
    expect(
      evaluateOperationAdmission(
        { ...CONTROL, runtimeGeneration: 8 },
        { ...input, runtimeGeneration: 8 },
        FALLBACK_AT,
        PREPARED_EXECUTION,
      ),
    ).toBeNull();
  });
});

describe('operation completion decisions', () => {
  const input = Object.freeze({ executionAttemptId: 'attempt', operationId: 'operation', runtimeGeneration: 5 });

  it('replays the last completion before examining an absent, reused, or stale active slot', () => {
    expect(
      evaluateOperationCompletion(Object.freeze({ ...CONTROL, lastCompletedOperationId: 'operation' }), input),
    ).toEqual({ kind: 'duplicate' });
    expect(
      evaluateOperationCompletion(
        Object.freeze({
          ...BUSY,
          lastCompletedOperationId: 'operation',
          activeOperationId: 'next',
          activeOperationGeneration: 99,
        }),
        input,
      ),
    ).toEqual({ kind: 'duplicate' });
  });

  it('checks active presence, identity, and then generation without mutating the slot', () => {
    expect(evaluateOperationCompletion(CONTROL, input)).toEqual({ kind: 'not-active' });
    expect(evaluateOperationCompletion(Object.freeze({ ...BUSY, activeOperationId: 'other' }), input)).toEqual({
      kind: 'mismatch',
      activeOperationId: 'other',
    });
    expect(evaluateOperationCompletion(BUSY, { ...input, runtimeGeneration: 99 })).toEqual({
      kind: 'stale-generation',
    });
    expect(evaluateOperationCompletion(BUSY, input)).toBeNull();
    expect(BUSY.activeOperationId).toBe('operation');
  });

  it('keeps Preparation and Invocation active until their semantic result is accepted', () => {
    for (const activeOperationKind of ['workspace-preparation', 'workload-invocation'] as const) {
      expect(evaluateOperationCompletion({ ...BUSY, activeOperationKind }, input)).toEqual({ kind: 'result-required' });
    }
    expect(evaluateOperationCompletion({ ...BUSY, activeOperationKind: 'runtime-probe' }, input)).toBeNull();
  });
});

describe('Preparation report decisions', () => {
  const reachable: AttemptReachability = { matchesExecution: true, settled: false, active: true, allocated: true };
  const preparing: AttemptControlState = {
    ...CONTROL,
    activeOperationId: 'preparation',
    activeOperationKind: 'workspace-preparation',
    activeOperationKey: 'prepare',
    activeOperationGeneration: 7,
    activeOperationAdmittedAt: STORED_AT,
  };

  it('accepts only the matching active Preparation and requested source-root identities', () => {
    expect(evaluatePreparationReport(reachable, preparing, WORKSPACE_EXECUTION, REPORT)).toBeNull();
    expect(evaluatePreparationReport(reachable, CONTROL, WORKSPACE_EXECUTION, REPORT)).toEqual({
      kind: 'no-active-operation',
    });
    expect(
      evaluatePreparationReport(
        reachable,
        { ...preparing, activeOperationKind: 'workload-invocation' },
        WORKSPACE_EXECUTION,
        REPORT,
      ),
    ).toEqual({ kind: 'operation-mismatch' });
    expect(
      evaluatePreparationReport(reachable, { ...preparing, runtimeGeneration: 8 }, WORKSPACE_EXECUTION, REPORT),
    ).toEqual({ kind: 'stale-generation' });
    expect(evaluatePreparationReport(reachable, preparing, EXECUTION, REPORT)).toEqual({
      kind: 'preparation-not-required',
    });
    expect(
      evaluatePreparationReport(reachable, preparing, WORKSPACE_EXECUTION, {
        ...REPORT,
        result: { kind: 'workspace-prepared', binding: { workspaceRoot: '/workspace', sourceRoots: [] } },
      }),
    ).toEqual({ kind: 'binding-mismatch' });
  });

  it('acknowledges historical semantic replay without reinstalling an obsolete binding', () => {
    const historical = { ...reachable, settled: true, active: false, allocated: false };
    const replacement = { ...CONTROL, runtimeGeneration: 99, activeOperationId: 'later' };
    const reordered: ReportOperationInput = {
      ...REPORT,
      result: {
        binding: { sourceRoots: [{ path: '/workspace/sources', id: 'sources' }], workspaceRoot: '/workspace' },
        kind: 'workspace-prepared',
      },
    };
    expect(evaluatePreparationReport(historical, replacement, PREPARED_EXECUTION, reordered)).toEqual({
      kind: 'duplicate',
      binding: REPORT.result.binding,
    });
    expect(replacement.runtimeGeneration).toBe(99);
    expect(PREPARED_EXECUTION.preparationReceipts).toHaveLength(1);
    expect(
      evaluatePreparationReport({ ...historical, matchesExecution: false }, replacement, PREPARED_EXECUTION, REPORT),
    ).toEqual({ kind: 'not-found' });
  });

  it('preserves the original result on conflicting replay and fences an unaccepted late report', () => {
    expect(
      evaluatePreparationReport(reachable, CONTROL, PREPARED_EXECUTION, {
        ...REPORT,
        result: { ...REPORT.result, binding: { ...REPORT.result.binding, workspaceRoot: '/other' } },
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      evaluatePreparationReport(reachable, CONTROL, PREPARED_EXECUTION, { ...REPORT, runtimeGeneration: 8 }),
    ).toEqual({ kind: 'conflict' });
    expect(evaluatePreparationReport({ ...reachable, active: false }, preparing, WORKSPACE_EXECUTION, REPORT)).toEqual({
      kind: 'fenced',
    });
    expect(evaluatePreparationReport({ ...reachable, settled: true }, preparing, WORKSPACE_EXECUTION, REPORT)).toEqual({
      kind: 'resolved',
    });
  });
});

describe('runtime readiness decisions', () => {
  const input = Object.freeze({ ...IDS, runtimeGeneration: 7, readyAt: FALLBACK_AT });

  it('fences generation before replay and replays the original time before busy refusal', () => {
    expect(evaluateRuntimeReadiness(BUSY, { ...input, runtimeGeneration: 99 })).toEqual({ kind: 'stale-generation' });
    expect(evaluateRuntimeReadiness(BUSY, input)).toEqual({ kind: 'duplicate', acceptedAt: STORED_AT });
  });

  it('requires an idle slot before permitting a readiness write', () => {
    expect(evaluateRuntimeReadiness(Object.freeze({ ...BUSY, runtimeReadyAt: null }), input)).toEqual({
      kind: 'operation-active',
      operationId: 'operation',
    });
    expect(evaluateRuntimeReadiness(Object.freeze({ ...CONTROL, runtimeReadyAt: null }), input)).toBeNull();
    expect(input.readyAt).toBe(FALLBACK_AT);
  });
});
