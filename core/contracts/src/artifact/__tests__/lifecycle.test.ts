import { describe, expect, it } from 'vitest';
import {
  advanceArtifactLifecycle,
  ArtifactLifecycleCurrentSchema,
  ArtifactLifecycleError,
  ArtifactLifecycleHistoryEntrySchema,
  ArtifactLifecycleRejectionSchema,
  ArtifactLifecycleSituationSchema,
  ArtifactLifecycleTransitionCommandSchema,
  ArtifactLifecycleTransitionIntentSchema,
  initialArtifactLifecycle,
  type ArtifactLifecycleCurrent,
  type ArtifactLifecycleTransitionCommand,
} from '../lifecycle.js';
import { ArtifactLifecycleStateSchema, type ArtifactLifecycleState } from '../kind-registration.js';

const artifact = { kind: 'plan', id: 'plan-1' };
const actor = { kind: 'agent', id: 'reviewer' };
const situation = { kind: 'revision-assessment' as const, assessedRevision: 'r1' };
const intent = {
  artifact,
  situation,
  state: 'decided' as const,
  expectedVersion: 1,
};
const command: ArtifactLifecycleTransitionCommand = { ...intent, actor };

function advance(current: ArtifactLifecycleCurrent, state: ArtifactLifecycleState, extra = {}) {
  return advanceArtifactLifecycle({ current, currentRevision: 'r1', command: { ...command, state, ...extra } });
}

function rejection(action: () => unknown) {
  try {
    action();
    throw new Error('Expected lifecycle rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactLifecycleError);
    if (!(error instanceof ArtifactLifecycleError)) throw error;
    return ArtifactLifecycleRejectionSchema.parse(JSON.parse(JSON.stringify(error.data)));
  }
}

describe('shared artifact lifecycle', () => {
  it('initializes category states without inventing a record lifecycle', () => {
    expect(initialArtifactLifecycle('knowledge')).toEqual({ category: 'knowledge', state: 'valid', version: 1 });
    expect(initialArtifactLifecycle('commitment')).toEqual({ category: 'commitment', state: 'proposed', version: 1 });
    expect(initialArtifactLifecycle('interaction')).toEqual({ category: 'interaction', state: 'open', version: 1 });
    expect(initialArtifactLifecycle('record')).toEqual({ category: 'record' });
    expect(ArtifactLifecycleCurrentSchema.safeParse({ category: 'record', state: 'valid' }).success).toBe(false);
    expect(ArtifactLifecycleCurrentSchema.safeParse({ category: 'knowledge', state: 'open', version: 1 }).success).toBe(
      false,
    );
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ArtifactLifecycleCurrentSchema.safeParse({ category: 'knowledge', state: 'valid', version }).success).toBe(
        false,
      );
    }
    expect(
      ArtifactLifecycleCurrentSchema.safeParse({ category: 'knowledge', state: 'retired', version: 1 }).success,
    ).toBe(false);
    expect(
      ArtifactLifecycleCurrentSchema.safeParse({ category: 'knowledge', state: 'valid', version: 2 }).success,
    ).toBe(true);
  });

  it('keeps every terminal state closed against any successor', () => {
    const terminal = [
      { category: 'knowledge', state: 'retired', version: 2 },
      { category: 'commitment', state: 'fulfilled', version: 3 },
      { category: 'commitment', state: 'revoked', version: 3 },
      { category: 'interaction', state: 'resolved', version: 2 },
      { category: 'interaction', state: 'closed-without-resolution', version: 2 },
    ] as const;
    const states = ArtifactLifecycleStateSchema.options;
    for (const current of terminal) {
      for (const state of states) {
        expect(rejection(() => advance(current, state, { expectedVersion: current.version }))).toMatchObject({
          reason: 'invalid-transition',
          current,
          requestedState: state,
        });
      }
    }
  });

  it('allows precisely the initial commitment path and rejects skipped approval or reopening', () => {
    const proposed = initialArtifactLifecycle('commitment');
    const decided = advance(proposed, 'decided');
    expect(decided).toEqual({ category: 'commitment', state: 'decided', version: 2 });
    expect(advance(decided, 'fulfilled', { expectedVersion: 2 }).version).toBe(3);
    expect(advance(decided, 'revoked', { expectedVersion: 2 }).state).toBe('revoked');
    expect(rejection(() => advance(proposed, 'revoked')).reason).toBe('invalid-transition');
    expect(rejection(() => advance(proposed, 'fulfilled')).reason).toBe('invalid-transition');
    expect(rejection(() => advance(decided, 'proposed', { expectedVersion: 2 })).reason).toBe('invalid-transition');
  });

  it('requires a retirement reason and separates closure with and without resolution', () => {
    const valid = initialArtifactLifecycle('knowledge');
    expect(rejection(() => advance(valid, 'retired')).reason).toBe('precondition-failed');
    expect(advance(valid, 'retired', { reason: 'Experiment finished' }).state).toBe('retired');
    for (const state of ['resolved', 'closed-without-resolution'] as const) {
      expect(advance(initialArtifactLifecycle('interaction'), state).state).toBe(state);
    }
    expect(rejection(() => advance(initialArtifactLifecycle('record'), 'valid')).reason).toBe('invalid-transition');
  });

  it('rejects stale lifecycle versions independently of content assessment', () => {
    const decided = advance(initialArtifactLifecycle('commitment'), 'decided');
    expect(rejection(() => advance(decided, 'fulfilled'))).toMatchObject({
      reason: 'lifecycle-version-conflict',
      expectedVersion: 1,
      current: { version: 2, state: 'decided' },
    });
    expect(
      rejection(() =>
        advance(initialArtifactLifecycle('commitment'), 'decided', {
          situation: { kind: 'revision-assessment', assessedRevision: 'r0' },
        }),
      ),
    ).toEqual({ reason: 'content-basis-conflict', assessedRevision: 'r0', currentRevision: 'r1' });
  });

  it('supports a handover without claiming a human-read revision or trusting unknown situation fields', () => {
    const handover = { kind: 'handover', source: { kind: 'jira', ref: 'site/FACT-1' } };
    expect(advance(initialArtifactLifecycle('commitment'), 'decided', { situation: handover }).state).toBe('decided');
    expect(ArtifactLifecycleSituationSchema.safeParse({ ...handover, assessedRevision: 'r1' }).success).toBe(false);
    expect(ArtifactLifecycleSituationSchema.safeParse({ kind: 'revision-assessment' }).success).toBe(false);
    expect(ArtifactLifecycleSituationSchema.safeParse({ kind: 'unknown' }).success).toBe(false);
    expect(ArtifactLifecycleTransitionIntentSchema.safeParse({ ...intent, reason: ' ' }).success).toBe(false);
    expect(ArtifactLifecycleTransitionIntentSchema.parse({ ...intent, reason: ' trimmed ' }).reason).toBe('trimmed');
    expect(ArtifactLifecycleTransitionIntentSchema.safeParse({ ...intent, actor }).success).toBe(false);
    expect(ArtifactLifecycleTransitionCommandSchema.safeParse(intent).success).toBe(false);
  });
});

describe('immutable lifecycle history', () => {
  const base = { artifact, actor, timestamp: 100, observedRevision: 'r1' };
  const initialized = { ...base, operation: 'initialized', lifecycle: initialArtifactLifecycle('commitment') };
  const transitioned = {
    ...base,
    operation: 'transitioned',
    previousState: 'proposed',
    situation,
    lifecycle: { category: 'commitment', state: 'decided', version: 2 },
  };

  it('distinguishes initialization from an attributed transition', () => {
    expect(ArtifactLifecycleHistoryEntrySchema.parse(initialized)).toEqual(initialized);
    expect(ArtifactLifecycleHistoryEntrySchema.parse(transitioned)).toEqual(transitioned);
    expect(ArtifactLifecycleHistoryEntrySchema.safeParse({ ...initialized, situation }).success).toBe(false);
    expect(
      ArtifactLifecycleHistoryEntrySchema.safeParse({ ...initialized, lifecycle: transitioned.lifecycle }).success,
    ).toBe(false);
    expect(ArtifactLifecycleHistoryEntrySchema.safeParse({ ...transitioned, situation: undefined }).success).toBe(
      false,
    );
  });

  it('rejects invalid category paths, skipped states and incorrect versions in persisted history', () => {
    for (const entry of [
      { ...transitioned, previousState: 'open' },
      { ...transitioned, lifecycle: { category: 'commitment', state: 'revoked', version: 2 } },
      { ...transitioned, lifecycle: { ...transitioned.lifecycle, version: 1 } },
      { ...transitioned, lifecycle: { category: 'record' } },
      { ...transitioned, observedRevision: 'r2' },
    ]) {
      expect(ArtifactLifecycleHistoryEntrySchema.safeParse(entry).success).toBe(false);
    }
  });

  it('retains a retirement reason while handover preserves only observed content', () => {
    const entry = {
      ...transitioned,
      previousState: 'valid',
      lifecycle: { category: 'knowledge', state: 'retired', version: 2 },
      situation: { kind: 'handover', source: { kind: 'jira', ref: 'site/FACT-1' } },
      observedRevision: 'r3',
    };
    expect(ArtifactLifecycleHistoryEntrySchema.safeParse(entry).success).toBe(false);
    expect(ArtifactLifecycleHistoryEntrySchema.parse({ ...entry, reason: 'Experiment ended' })).toMatchObject({
      observedRevision: 'r3',
      reason: 'Experiment ended',
      situation: { kind: 'handover' },
    });
  });
});

describe('portable lifecycle rejection details', () => {
  const current = { category: 'commitment', state: 'decided', version: 2 };
  const fixtures = [
    { reason: 'lifecycle-version-conflict', expectedVersion: 1, current, requestedState: 'fulfilled' },
    { reason: 'content-basis-conflict', assessedRevision: 'r1', currentRevision: 'r2' },
    { reason: 'invalid-transition', current: { category: 'record' }, requestedState: 'valid' },
    { reason: 'precondition-failed', current, requestedState: 'fulfilled' },
  ];

  it('requires the information needed to understand each rejection reason', () => {
    for (const fixture of fixtures) {
      expect(ArtifactLifecycleRejectionSchema.parse(fixture)).toEqual(fixture);
      for (const field of Object.keys(fixture)) {
        const incomplete = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== field));
        expect(ArtifactLifecycleRejectionSchema.safeParse(incomplete).success).toBe(false);
      }
    }
  });

  it('rejects version conflicts and preconditions without a stateful baseline', () => {
    expect(
      ArtifactLifecycleRejectionSchema.safeParse({
        reason: 'lifecycle-version-conflict',
        expectedVersion: 1,
        current: { category: 'record' },
        requestedState: 'valid',
      }).success,
    ).toBe(false);
    expect(
      ArtifactLifecycleRejectionSchema.safeParse({
        reason: 'precondition-failed',
        current: { category: 'record' },
        requestedState: 'valid',
      }).success,
    ).toBe(false);
  });

  it('rejects fields from unrelated reasons instead of presenting ambiguous failure details', () => {
    expect(
      ArtifactLifecycleRejectionSchema.safeParse({
        reason: 'content-basis-conflict',
        assessedRevision: 'r1',
        currentRevision: 'r2',
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });
});
