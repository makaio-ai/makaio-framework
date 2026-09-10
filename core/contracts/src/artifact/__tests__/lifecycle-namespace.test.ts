import { describe, expect, it } from 'vitest';
import { getFullSubjectForSubjectDefinition } from '@makaio/core';
import { createBusInstance, defineSubjectExtension } from '@makaio/bus-core';
import { z } from 'zod';
import {
  ARTIFACT_LIFECYCLE_REJECTED_CODE,
  advanceArtifactLifecycle,
  ArtifactLifecycleError,
  initialArtifactLifecycle,
  type ArtifactLifecycleCurrent,
  type ArtifactLifecycleTransitionCommand,
  type ArtifactLifecycleTransitionIntent,
} from '../lifecycle.js';
import { toArtifactLifecycleFailure } from '../lifecycle-namespace.js';
import { ArtifactNamespace, ArtifactSchemas, ArtifactSubjects } from '../namespace.js';

const artifact = { kind: 'question', id: 'question-1' };
const actor = { kind: 'agent', id: 'reviewer-1' };
const situation = { kind: 'handover' as const, source: { kind: 'ticket', ref: 'ticket-42' } };
const intent = { artifact, expectedVersion: 1, state: 'resolved', situation };
const entry = {
  artifact,
  operation: 'transitioned',
  lifecycle: { category: 'interaction', state: 'resolved', version: 2 },
  previousState: 'open',
  observedRevision: 'content-7',
  actor,
  situation,
  timestamp: 1789000000000,
};
const initialized = {
  artifact,
  operation: 'initialized',
  lifecycle: { category: 'interaction', state: 'open', version: 1 },
  observedRevision: 'content-1',
  actor,
  timestamp: 1788990000000,
};

describe('shared lifecycle namespace', () => {
  it('registers additive typed RPC and event subjects on the artifact namespace', () => {
    const subjects = ArtifactSubjects.lifecycle;
    expect([
      getFullSubjectForSubjectDefinition(subjects.get),
      getFullSubjectForSubjectDefinition(subjects.history),
      getFullSubjectForSubjectDefinition(subjects.transition),
      `${subjects.committed.$meta.namespace}.${subjects.committed.subject}`,
      `${subjects.rejected.$meta.namespace}.${subjects.rejected.subject}`,
    ]).toEqual([
      'artifact.lifecycle.get',
      'artifact.lifecycle.history',
      'artifact.lifecycle.transition',
      'artifact.lifecycle.committed',
      'artifact.lifecycle.rejected',
    ]);
    expect(Object.keys(subjects).sort()).toEqual(['committed', 'get', 'history', 'rejected', 'transition']);
    expect(getFullSubjectForSubjectDefinition(ArtifactSubjects.resolve)).toBe('artifact.resolve');
  });

  it('reads current state without pretending that records or legacy artifacts have lifecycle states', () => {
    expect(ArtifactSchemas['lifecycle.get'].request.parse({ artifact })).toEqual({ artifact });
    const schema = ArtifactSchemas['lifecycle.get'].response;
    expect(schema.parse({ lifecycle: entry.lifecycle })).toEqual({ lifecycle: entry.lifecycle });
    expect(schema.parse({ lifecycle: { category: 'record' } })).toEqual({ lifecycle: { category: 'record' } });
    for (const lifecycle of [null, {}, { category: 'record', state: 'valid' }, { category: 'interaction' }]) {
      expect(schema.safeParse({ lifecycle }).success).toBe(false);
    }
    expect(schema.safeParse({ lifecycle: { ...entry.lifecycle, state: 'valid' } }).success).toBe(false);
  });

  it('bounds history requests and keeps initialization distinct from transitions', () => {
    const schema = ArtifactSchemas['lifecycle.history'];
    expect(schema.request.parse({ artifact }).limit).toBe(50);
    expect(schema.request.parse({ artifact, afterVersion: 1, limit: 100 }).afterVersion).toBe(1);
    for (const limit of [0, -1, 101, 1.5]) {
      expect(schema.request.safeParse({ artifact, limit }).success).toBe(false);
    }
    for (const afterVersion of [0, -1, 1.5, '1']) {
      expect(schema.request.safeParse({ artifact, afterVersion }).success).toBe(false);
    }
    expect(schema.response.parse({ entries: [initialized, entry], nextCursor: 2 }).entries).toHaveLength(2);
    expect(schema.response.parse({ entries: [entry] })).toEqual({ entries: [entry] });
    expect(schema.response.safeParse({ entries: Array.from({ length: 101 }, () => entry) }).success).toBe(false);
    expect(schema.response.parse({ entries: [] })).toEqual({ entries: [] });
  });

  it('rejects history pages that break contiguous, state-linked order or misreport the cursor', () => {
    const schema = ArtifactSchemas['lifecycle.history'].response;
    const closed = {
      ...entry,
      lifecycle: { category: 'interaction', state: 'closed-without-resolution', version: 2 },
    };
    for (const page of [
      { entries: [entry, initialized] },
      { entries: [initialized, { ...entry, lifecycle: { ...entry.lifecycle, version: 3 } }] },
      { entries: [initialized, { ...entry, artifact: { kind: 'question', id: 'question-2' } }] },
      { entries: [initialized, entry, closed] },
      { entries: [initialized, entry], nextCursor: 1 },
      { entries: [], nextCursor: 1 },
    ]) {
      expect(schema.safeParse(page).success).toBe(false);
    }
  });

  it('requires a concurrency baseline and known assessment basis scoped to the requested artifact', () => {
    const schema = ArtifactSchemas['lifecycle.transition'].request;
    expect(schema.parse(intent)).toEqual(intent);
    expect(schema.safeParse({ ...intent, actor }).success).toBe(false);
    expect(schema.safeParse({ ...intent, expectedVersion: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...intent, expectedVersion: 0 }).success).toBe(false);
    expect(
      schema.parse({ ...intent, situation: { kind: 'revision-assessment', assessedRevision: 'content-7' } }),
    ).toHaveProperty('situation.assessedRevision', 'content-7');
    expect(schema.safeParse({ ...intent, situation: { kind: 'revision-assessment' } }).success).toBe(false);
    expect(schema.safeParse({ ...intent, situation: { ...situation, assessedRevision: 'invented' } }).success).toBe(
      false,
    );
  });

  it('returns only a persisted transition and preserves generic failure details for reactions', () => {
    const response = ArtifactSchemas['lifecycle.transition'].response;
    expect(response.parse({ entry })).toEqual({ entry });
    expect(response.safeParse({ entry: initialized }).success).toBe(false);
    expect(ArtifactSchemas['lifecycle.committed'].parse({ entry })).toEqual({ entry });
    const rejected = {
      transition: intent,
      error: {
        code: 'artifact-lifecycle-rejected',
        message: 'Artifact lifecycle changed since the supplied baseline',
        data: {
          reason: 'lifecycle-version-conflict',
          expectedVersion: 1,
          current: entry.lifecycle,
          requestedState: intent.state,
        },
      },
    };
    expect(ArtifactSchemas['lifecycle.rejected'].parse(JSON.parse(JSON.stringify(rejected)))).toEqual(rejected);
    expect(
      ArtifactSchemas['lifecycle.rejected'].safeParse({ transition: intent, error: rejected.error.message }).success,
    ).toBe(false);
  });
  it('keeps rejection details tied to the transition they reject', () => {
    const versionConflict = {
      transition: intent,
      error: {
        code: 'artifact-lifecycle-rejected',
        message: 'Artifact lifecycle changed since the supplied baseline',
        data: {
          reason: 'lifecycle-version-conflict',
          expectedVersion: 1,
          current: entry.lifecycle,
          requestedState: intent.state,
        },
      },
    };
    expect(ArtifactSchemas['lifecycle.rejected'].parse(versionConflict)).toEqual(versionConflict);
    expect(
      ArtifactSchemas['lifecycle.rejected'].safeParse({
        ...versionConflict,
        error: { ...versionConflict.error, data: { ...versionConflict.error.data, expectedVersion: 2 } },
      }).success,
    ).toBe(false);
    expect(
      ArtifactSchemas['lifecycle.rejected'].safeParse({
        ...versionConflict,
        error: {
          ...versionConflict.error,
          data: { ...versionConflict.error.data, current: { ...entry.lifecycle, version: 1 } },
        },
      }).success,
    ).toBe(false);

    const assessmentTransition = {
      ...intent,
      situation: { kind: 'revision-assessment' as const, assessedRevision: 'content-6' },
    };
    const contentConflict = {
      transition: assessmentTransition,
      error: {
        code: 'artifact-lifecycle-rejected',
        message: 'Assessed content revision is no longer current',
        data: { reason: 'content-basis-conflict', assessedRevision: 'content-6', currentRevision: 'content-7' },
      },
    };
    expect(ArtifactSchemas['lifecycle.rejected'].parse(contentConflict)).toEqual(contentConflict);
    expect(
      ArtifactSchemas['lifecycle.rejected'].safeParse({
        ...contentConflict,
        error: {
          ...contentConflict.error,
          data: { ...contentConflict.error.data, assessedRevision: 'content-5' },
        },
      }).success,
    ).toBe(false);
    expect(
      ArtifactSchemas['lifecycle.rejected'].safeParse({
        ...contentConflict,
        error: {
          ...contentConflict.error,
          data: { ...contentConflict.error.data, currentRevision: 'content-6' },
        },
      }).success,
    ).toBe(false);
  });
  it('derives committed and rejected payloads from the real transition engine', () => {
    const baseline = { artifact, actor, timestamp: 1789000000001, observedRevision: 'content-7' };
    const open = initialArtifactLifecycle('interaction');
    const command: ArtifactLifecycleTransitionCommand = { ...intent, state: 'resolved', situation, actor };
    const resolved = advanceArtifactLifecycle({ current: open, currentRevision: 'content-7', command });
    const persisted = { ...baseline, operation: 'transitioned', lifecycle: resolved, previousState: 'open', situation };
    expect(ArtifactSchemas['lifecycle.transition'].response.parse({ entry: persisted })).toEqual({ entry: persisted });
    expect(ArtifactSchemas['lifecycle.committed'].parse({ entry: persisted })).toEqual({ entry: persisted });

    const resolveIntent: ArtifactLifecycleTransitionIntent = { ...intent, state: 'resolved', situation };
    const attempts: Array<{ current: ArtifactLifecycleCurrent; transition: ArtifactLifecycleTransitionIntent }> = [
      { current: resolved, transition: resolveIntent },
      { current: open, transition: { ...resolveIntent, state: 'open' } },
      { current: initialArtifactLifecycle('knowledge'), transition: { ...resolveIntent, state: 'retired' } },
      { current: initialArtifactLifecycle('record'), transition: resolveIntent },
      {
        current: open,
        transition: { ...resolveIntent, situation: { kind: 'revision-assessment', assessedRevision: 'content-6' } },
      },
    ];
    const reasons = attempts.map(({ current, transition }) => {
      try {
        advanceArtifactLifecycle({ current, currentRevision: 'content-7', command: { ...transition, actor } });
        throw new Error('Expected lifecycle rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactLifecycleError);
        if (!(error instanceof ArtifactLifecycleError)) throw error;
        const payload = { transition, error: toArtifactLifecycleFailure(error) };
        expect(payload.error.code).toBe(ARTIFACT_LIFECYCLE_REJECTED_CODE);
        expect(ArtifactSchemas['lifecycle.rejected'].parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
        return error.data.reason;
      }
    });
    expect(reasons).toEqual([
      'lifecycle-version-conflict',
      'invalid-transition',
      'precondition-failed',
      'invalid-transition',
      'content-basis-conflict',
    ]);
  });

  it('rejects stateful non-version rejections that contradict the baseline or the matrix', () => {
    const schema = ArtifactSchemas['lifecycle.rejected'];
    const reopen = { ...intent, state: 'open' };
    const rejectedReopen = (data: Record<string, unknown>) => ({
      transition: reopen,
      error: { code: ARTIFACT_LIFECYCLE_REJECTED_CODE, message: 'rejected', data: { requestedState: 'open', ...data } },
    });
    const open = { category: 'interaction', state: 'open', version: 1 };
    // Reported current state must carry the supplied baseline version.
    expect(schema.safeParse(rejectedReopen({ reason: 'invalid-transition', current: entry.lifecycle })).success).toBe(
      false,
    );
    // open -> open is refused by the matrix: a valid invalid-transition, never a precondition failure.
    expect(schema.parse(rejectedReopen({ reason: 'invalid-transition', current: open }))).toMatchObject({
      error: { data: { current: open } },
    });
    expect(schema.safeParse(rejectedReopen({ reason: 'precondition-failed', current: open })).success).toBe(false);
    // open -> resolved passes the matrix: a valid precondition failure, never an invalid transition.
    const resolveFailure = (reason: string) => ({
      transition: intent,
      error: {
        code: ARTIFACT_LIFECYCLE_REJECTED_CODE,
        message: 'rejected',
        data: { reason, current: open, requestedState: intent.state },
      },
    });
    expect(schema.parse(resolveFailure('precondition-failed'))).toMatchObject({ error: { data: { current: open } } });
    expect(schema.safeParse(resolveFailure('invalid-transition')).success).toBe(false);
  });

  it('emits real events with host extensions without using reserved RPC payload keys', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(ArtifactNamespace);
    const committed = defineSubjectExtension(ArtifactSubjects.lifecycle.committed, {
      repositoryId: z.string().min(1),
    }).register(bus);
    const received: unknown[] = [];
    const offCommitted = bus.on(committed, (ctx) => {
      received.push(ctx.payload);
    });
    const offRejected = bus.on(ArtifactSubjects.lifecycle.rejected, (ctx) => {
      received.push(ctx.payload);
    });
    const committedPayload = {
      ...ArtifactSchemas['lifecycle.committed'].parse({ entry }),
      repositoryId: 'repository-1',
    };
    const rejectedPayload = ArtifactSchemas['lifecycle.rejected'].parse({
      transition: intent,
      error: {
        code: 'artifact-lifecycle-rejected',
        message: 'Artifact lifecycle changed since the supplied baseline',
        data: {
          reason: 'lifecycle-version-conflict',
          expectedVersion: 1,
          current: entry.lifecycle,
          requestedState: intent.state,
        },
      },
    });
    try {
      await bus.emit(committed, committedPayload);
      await bus.emit(ArtifactSubjects.lifecycle.rejected, rejectedPayload);
      expect(received).toEqual([committedPayload, rejectedPayload]);
    } finally {
      offCommitted();
      offRejected();
    }
  });
});
