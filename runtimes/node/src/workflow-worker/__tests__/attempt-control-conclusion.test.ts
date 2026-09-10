import { describe, expect, it } from 'vitest';
import { deriveAttemptControlConclusion, type AttemptControlState } from '../attempt-control-conclusion.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const OBSERVED_AT = new Date('2026-09-10T12:00:01.000Z');

function baseState(overrides: Partial<AttemptControlState> = {}): AttemptControlState {
  return {
    cancelReceived: false,
    admissionPending: false,
    admissionSettled: false,
    admissionRefusalReason: null,
    admittedOperation: null,
    conclusion: null,
    finished: false,
    ...overrides,
  };
}

describe('deriveAttemptControlConclusion', () => {
  it('returns pending when cancel has not been received', () => {
    expect(deriveAttemptControlConclusion(baseState(), NOW)).toBe('pending');
  });

  it('returns pending when admission is still pending (R2 guard)', () => {
    expect(deriveAttemptControlConclusion(baseState({ cancelReceived: true, admissionPending: true }), NOW)).toBe(
      'pending',
    );
  });

  it('returns pending when cancel received but no terminal state reached', () => {
    // Cancel received, no operation admitted, admission unsettled, not finished.
    expect(deriveAttemptControlConclusion(baseState({ cancelReceived: true }), NOW)).toBe('pending');
  });

  it('returns admission-closed/achieved when admission settled without an operation', () => {
    const result = deriveAttemptControlConclusion(
      baseState({ cancelReceived: true, admissionSettled: true, admissionRefusalReason: 'gate-closed' }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('admission-closed');
    expect(result.conclusion.status).toBe('achieved');
    expect(result.operationId).toBeUndefined();
    expect(result.conclusion.evidence.source).toBe('headless-runtime');
    expect(result.conclusion.evidence.summary).toContain('gate-closed');
    expect(result.conclusion.evidence.observedAt).toBe(NOW.toISOString());
  });

  it('returns admission-closed/achieved for a refusal that is not gate-closed', () => {
    const result = deriveAttemptControlConclusion(
      baseState({ cancelReceived: true, admissionSettled: true, admissionRefusalReason: 'preparation-not-required' }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('admission-closed');
    expect(result.conclusion.status).toBe('achieved');
    expect(result.conclusion.evidence.summary).toContain('preparation-not-required');
  });

  it('returns admission-closed/achieved when finished() without admission', () => {
    const result = deriveAttemptControlConclusion(baseState({ cancelReceived: true, finished: true }), NOW);
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('admission-closed');
    expect(result.conclusion.status).toBe('achieved');
    expect(result.conclusion.evidence.summary).toBe('no mutating operation admitted before cancellation');
  });

  it('returns workload/unsupported for workload-invocation', () => {
    const result = deriveAttemptControlConclusion(
      baseState({
        cancelReceived: true,
        admittedOperation: { kind: 'workload-invocation', operationId: 'wl-op-1' },
      }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('workload');
    expect(result.operationId).toBe('wl-op-1');
    expect(result.conclusion.status).toBe('unsupported');
    expect(result.conclusion.evidence.source).toBe('headless-runtime');
  });

  it('returns pending when workspace-preparation is admitted but has not concluded', () => {
    expect(
      deriveAttemptControlConclusion(
        baseState({
          cancelReceived: true,
          admittedOperation: { kind: 'workspace-preparation', operationId: 'prep-1' },
        }),
        NOW,
      ),
    ).toBe('pending');
  });

  it('returns pending when the concluded operation is a different one', () => {
    expect(
      deriveAttemptControlConclusion(
        baseState({
          cancelReceived: true,
          admittedOperation: { kind: 'workspace-preparation', operationId: 'prep-2' },
          conclusion: { kind: 'workspace-preparation', operationId: 'other-op', setup: 'not-started' },
        }),
        NOW,
      ),
    ).toBe('pending');
  });

  it('returns setup-process-group/achieved (headless-runtime) when setup never started', () => {
    const result = deriveAttemptControlConclusion(
      baseState({
        cancelReceived: true,
        admittedOperation: { kind: 'workspace-preparation', operationId: 'prep-3' },
        conclusion: { kind: 'workspace-preparation', operationId: 'prep-3', setup: 'not-started' },
      }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('setup-process-group');
    expect(result.conclusion.status).toBe('achieved');
    expect(result.conclusion.evidence.source).toBe('headless-runtime');
    expect(result.conclusion.evidence.summary).toBe('preparation admitted; setup never started before cancellation');
    expect(result.operationId).toBe('prep-3');
    expect(result.conclusion.evidence.observedAt).toBe(NOW.toISOString());
  });

  it('returns setup-process-group/achieved when the driver proved setup spawned nothing', () => {
    const result = deriveAttemptControlConclusion(
      baseState({
        cancelReceived: true,
        admittedOperation: { kind: 'workspace-preparation', operationId: 'prep-4' },
        conclusion: { kind: 'workspace-preparation', operationId: 'prep-4', setup: 'no-spawn' },
      }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('setup-process-group');
    expect(result.conclusion.status).toBe('achieved');
    expect(result.conclusion.evidence.source).toBe('setup-driver');
    expect(result.conclusion.evidence.summary).toBe('no live setup process group remains under this operation');
    expect(result.conclusion.evidence.observedAt).toBe(NOW.toISOString());
    expect(result.conclusion.evidence.code).toBeUndefined();
  });

  it('returns setup-process-group/unsupported when the driver supplied no observation', () => {
    const result = deriveAttemptControlConclusion(
      baseState({
        cancelReceived: true,
        admittedOperation: { kind: 'workspace-preparation', operationId: 'prep-4b' },
        conclusion: { kind: 'workspace-preparation', operationId: 'prep-4b', setup: 'no-observation' },
      }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('setup-process-group');
    expect(result.conclusion.status).toBe('unsupported');
    expect(result.conclusion.evidence.source).toBe('setup-driver');
    expect(result.conclusion.evidence.summary).toBe('setup driver supplied no process-group observation');
    expect(result.conclusion.evidence.code).toBeUndefined();
  });

  it.each([
    ['signalled-and-quiesced', 'achieved'],
    ['exited', 'achieved'],
    ['signalled-unconfirmed', 'unconfirmed'],
    ['unsignalled-unconfirmed', 'unconfirmed'],
  ] as const)('maps the %s driver outcome onto a %s setup-process-group conclusion', (outcome, status) => {
    const result = deriveAttemptControlConclusion(
      baseState({
        cancelReceived: true,
        admittedOperation: { kind: 'workspace-preparation', operationId: 'prep-5' },
        conclusion: {
          kind: 'workspace-preparation',
          operationId: 'prep-5',
          setup: { outcome, pid: 1234, observedAt: OBSERVED_AT },
        },
      }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.status).toBe(status);
    expect(result.conclusion.boundary).toBe('setup-process-group');
    expect(result.conclusion.evidence.source).toBe('setup-driver');
    expect(result.conclusion.evidence.code).toBe(outcome);
    // The driver's own instant is the observation, not the derivation instant.
    expect(result.conclusion.evidence.observedAt).toBe(OBSERVED_AT.toISOString());
    expect(result.conclusion.evidence.summary.length).toBeGreaterThan(0);
  });

  it('renders the unproven cause into the summary of an unconfirmed stop', () => {
    const result = deriveAttemptControlConclusion(
      baseState({
        cancelReceived: true,
        admittedOperation: { kind: 'workspace-preparation', operationId: 'prep-6' },
        conclusion: {
          kind: 'workspace-preparation',
          operationId: 'prep-6',
          setup: { outcome: 'signalled-unconfirmed', cause: 'ps-unavailable', pid: 42, observedAt: OBSERVED_AT },
        },
      }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.status).toBe('unconfirmed');
    expect(result.conclusion.evidence.summary).toContain('ps unavailable');
    // Durable evidence summaries are bounded by BoundedRecoveryEvidenceSchema.
    expect(result.conclusion.evidence.summary.length).toBeLessThanOrEqual(512);
  });

  it('reports the workload boundary when preparation concluded and the workload was admitted', () => {
    // The last admitted operation is the cancel's evidence scope.
    const result = deriveAttemptControlConclusion(
      baseState({
        cancelReceived: true,
        admittedOperation: { kind: 'workload-invocation', operationId: 'wl-op-2' },
        conclusion: {
          kind: 'workspace-preparation',
          operationId: 'prep-7',
          setup: { outcome: 'exited', pid: 7, observedAt: OBSERVED_AT },
        },
      }),
      NOW,
    );
    expect(result).not.toBe('pending');
    if (result === 'pending') return;
    expect(result.conclusion.boundary).toBe('workload');
    expect(result.operationId).toBe('wl-op-2');
  });
});
