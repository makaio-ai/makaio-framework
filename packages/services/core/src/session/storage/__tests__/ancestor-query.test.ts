import { describe, it, expect } from 'vitest';
import { createSession, useDrizzleTestLifecycle } from './shared.js';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { getSessionAncestorChain } from '../ancestor-query.js';

describe('getSessionAncestorChain', () => {
  const ctx = useDrizzleTestLifecycle();

  it('should return empty array for root session', async () => {
    const root = createSession({
      sessionId: 'root',
      parentSessionId: undefined,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: root.sessionId,
      session: root,
    });

    const chain = await getSessionAncestorChain(ctx.db, 'root');
    expect(chain).toEqual(['root']);
  });

  it('should return chain for nested forks', async () => {
    const root = createSession({ sessionId: 'root' });
    const fork1 = createSession({
      sessionId: 'fork1',
      parentSessionId: 'root',
      rootSessionId: 'root',
    });
    const fork2 = createSession({
      sessionId: 'fork2',
      parentSessionId: 'fork1',
      rootSessionId: 'root',
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: root.sessionId,
      session: root,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: fork1.sessionId,
      session: fork1,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: fork2.sessionId,
      session: fork2,
    });

    const chain = await getSessionAncestorChain(ctx.db, 'fork2');
    expect(chain).toEqual(['fork2', 'fork1', 'root']);
  });
});
