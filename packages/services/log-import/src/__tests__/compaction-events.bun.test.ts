import { afterEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { SessionEventStorageSubjects } from '@makaio/services-core/session';
import { appendSessionCompactedEvent } from '../compaction-events.js';

describe('appendSessionCompactedEvent', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    MakaioBus.__resetHandlers?.();
  });

  it('appends the event when it does not already exist', async () => {
    const appended: unknown[] = [];

    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.getByIds, (ctx) => {
        ctx.setResult({ events: [] });
      }),
    );
    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.append, (ctx) => {
        appended.push(ctx.payload.event);
        ctx.setResult({ success: true });
      }),
    );

    await appendSessionCompactedEvent(MakaioBus, {
      sessionId: 'parent',
      eventId: 'session-compacted:parent:child',
      timestamp: 123,
      trigger: 'manual',
      preTokens: 42,
      summary: 'summary',
      compressChildSessionId: 'child',
    });

    expect(appended).toHaveLength(1);
  });

  it('does nothing when the deterministic event already exists', async () => {
    let appendCalls = 0;

    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.getByIds, (ctx) => {
        ctx.setResult({
          events: [
            {
              sessionId: ctx.payload.sessionId,
              eventId: ctx.payload.eventIds[0],
              timestamp: 123,
              type: 'session.compacted',
              payload: {},
            },
          ],
        });
      }),
    );
    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.append, () => {
        appendCalls += 1;
      }),
    );

    await appendSessionCompactedEvent(MakaioBus, {
      sessionId: 'parent',
      eventId: 'session-compacted:parent:child',
      timestamp: 123,
      trigger: 'manual',
      preTokens: 42,
      summary: 'summary',
      compressChildSessionId: 'child',
    });

    expect(appendCalls).toBe(0);
  });

  it('treats a duplicate append race as success when the event exists on recheck', async () => {
    let getByIdsCalls = 0;

    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.getByIds, (ctx) => {
        getByIdsCalls += 1;
        if (getByIdsCalls === 1) {
          ctx.setResult({ events: [] });
          return;
        }

        ctx.setResult({
          events: [
            {
              sessionId: ctx.payload.sessionId,
              eventId: ctx.payload.eventIds[0],
              timestamp: 123,
              type: 'session.compacted',
              payload: {},
            },
          ],
        });
      }),
    );
    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.append, () => {
        throw new Error('UNIQUE constraint failed: session_events.event_id');
      }),
    );

    await expect(
      appendSessionCompactedEvent(MakaioBus, {
        sessionId: 'parent',
        eventId: 'session-compacted:parent:child',
        timestamp: 123,
        trigger: 'manual',
        preTokens: 42,
        summary: 'summary',
        compressChildSessionId: 'child',
      }),
    ).resolves.toBeUndefined();
  });
});
