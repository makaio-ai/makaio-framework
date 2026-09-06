import { describe, expect, it } from 'vitest';
import {
  evaluateAttemptReachability,
  evaluateOperationAdmission,
  evaluateOperationCompletion,
  evaluateRuntimeReadiness,
  evaluateRuntimeRegistration,
  type AdmitOperationInput,
  type AttemptControlState,
  type AttemptReachability,
} from '../execution-attempt-repository.js';

const STORED_AT = '2026-09-06T12:00:00.000Z';
const FALLBACK_AT = '2026-09-06T13:00:00.000Z';
const IDS = { executionId: 'owner', executionAttemptId: 'attempt' };
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
    expect(evaluateOperationAdmission(control, { ...ADMISSION, runtimeGeneration: 99 }, FALLBACK_AT)).toEqual({
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
    expect(evaluateOperationAdmission(control, ADMISSION, FALLBACK_AT)).toEqual({
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
      ),
    ).toEqual({ kind: 'gate-closed' });
    expect(evaluateOperationAdmission(Object.freeze({ ...CONTROL, runtimeReadyAt: null }), stale, FALLBACK_AT)).toEqual(
      { kind: 'not-ready' },
    );
    expect(evaluateOperationAdmission(CONTROL, stale, FALLBACK_AT)).toEqual({
      kind: 'stale-generation',
      runtimeGeneration: 7,
    });
  });

  it('permits a probe without readiness but still fences its generation', () => {
    const control = Object.freeze({ ...CONTROL, runtimeReadyAt: null });
    const probe: AdmitOperationInput = Object.freeze({ ...ADMISSION, operationKind: 'runtime-probe' });
    expect(evaluateOperationAdmission(control, probe, FALLBACK_AT)).toBeNull();
    expect(evaluateOperationAdmission(control, { ...probe, runtimeGeneration: 99 }, FALLBACK_AT)).toEqual({
      kind: 'stale-generation',
      runtimeGeneration: 7,
    });
    expect(evaluateOperationAdmission(CONTROL, ADMISSION, FALLBACK_AT)).toBeNull();
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
