import { describe, expect, it } from 'vitest';
import {
  evaluateAttemptCancellation,
  snapshotAttemptOutcomeControl,
  snapshotRequestAttemptCancellationInput,
  snapshotRequestExecutionCancellationInput,
  type ExecutionAttemptCancellationIntent,
} from '../execution-attempt-repository.js';

const REQUEST = {
  executionId: 'owner',
  executionAttemptId: 'attempt',
  requestKey: 'request',
  reason: 'operator',
};
const ACCEPTED_AT = '2026-09-09T12:00:00.000Z';
const RETRIED_AT = '2026-09-09T13:00:00.000Z';
const WINNER: ExecutionAttemptCancellationIntent = {
  requestKey: REQUEST.requestKey,
  controlRevision: 1,
  requestedAt: ACCEPTED_AT,
  reason: REQUEST.reason,
};

describe('cancellation request snapshots', () => {
  it('retains scalar request values without normalizing identities or explanations', () => {
    const input = { ...REQUEST, requestKey: ' request ', reason: '' };
    const snapshot = snapshotRequestAttemptCancellationInput(input);
    input.requestKey = 'changed';
    input.reason = 'changed';
    expect(snapshot).toEqual({ ...REQUEST, requestKey: ' request ', reason: '' });
  });

  it.each([
    'executionId',
    'executionAttemptId',
    'requestKey',
  ] as const)('rejects an empty %s before storage work', (field) => {
    expect(() => snapshotRequestAttemptCancellationInput({ ...REQUEST, [field]: '' })).toThrow(
      `${field} must be a non-empty string`,
    );
  });

  it('shares owner validation and omits an absent reason', () => {
    expect(() => snapshotRequestExecutionCancellationInput({ executionId: '' })).toThrow(
      'executionId must be a non-empty string',
    );
    expect(snapshotRequestExecutionCancellationInput({ executionId: 'owner' })).toEqual({ executionId: 'owner' });
  });
});

describe('winning cancellation decision', () => {
  it('creates the first receipt at revision one using the store instant', () => {
    expect(evaluateAttemptCancellation(null, REQUEST, ACCEPTED_AT)).toEqual({ kind: 'accepted', intent: WINNER });
  });

  it('replays the winning request without advancing its revision or timestamp', () => {
    const decision = evaluateAttemptCancellation(WINNER, REQUEST, RETRIED_AT);
    expect(decision).toEqual({ kind: 'replayed', intent: WINNER });
    if (decision.kind !== 'replayed') throw new Error('Expected the original winning receipt');
    expect(decision.intent).not.toBe(WINNER);
  });

  it('rejects contradictory reuse of the winning key without altering its receipt', () => {
    const before = { ...WINNER };
    expect(evaluateAttemptCancellation(WINNER, { ...REQUEST, reason: 'changed' }, RETRIED_AT)).toEqual({
      kind: 'conflict',
    });
    expect(WINNER).toEqual(before);
  });

  it('returns the winner for a different key without accepting a new command', () => {
    expect(
      evaluateAttemptCancellation(WINNER, { requestKey: 'another-request', reason: 'different' }, RETRIED_AT),
    ).toEqual({ kind: 'replayed', intent: WINNER });
  });

  it('preserves the distinction between an absent and an empty explanation', () => {
    const first = evaluateAttemptCancellation(null, { requestKey: 'request' }, ACCEPTED_AT);
    if (first.kind !== 'accepted') throw new Error('Expected first acceptance');
    expect(first.intent).not.toHaveProperty('reason');
    expect(evaluateAttemptCancellation(first.intent, { requestKey: 'request', reason: '' }, RETRIED_AT)).toEqual({
      kind: 'conflict',
    });
  });
});

describe('outcome control observation', () => {
  it('records known revision zero when no cancellation preceded the commit', () => {
    expect(snapshotAttemptOutcomeControl(null)).toEqual({ controlRevision: 0, cancellation: null });
  });

  it('detaches the winning receipt so later mutable state cannot rewrite the observation', () => {
    const cancellation = { ...WINNER };
    const observation = snapshotAttemptOutcomeControl(cancellation);
    cancellation.reason = 'changed after commit';
    expect(observation).toEqual({ controlRevision: 1, cancellation: WINNER });
    expect(observation.cancellation).not.toBe(cancellation);
  });
});
