import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { createForkHandlerContext, type ForkHandlerTestContext } from './shared.js';

describe('fork-handler (projection mode)', () => {
  let ctx: ForkHandlerTestContext;

  beforeEach(() => {
    ctx = createForkHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  it('should NOT copy messages to forked session', async () => {
    // Track message.append calls
    const appendedMessages: unknown[] = [];
    ctx.addCleanup(
      MakaioBus.on(MessageStorageSubjects.append, (busCtx) => {
        appendedMessages.push(busCtx.payload);
        busCtx.setResult({ message: { messageId: 'new-msg', ...busCtx.payload.message } });
      }),
    );

    // Mock source session lookup with filter
    ctx.addCleanup(
      MakaioBus.on(
        SessionSubjects.get,
        (busCtx) => {
          busCtx.setResult({
            session: {
              sessionId: 'source-session',
              title: 'Source',
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              status: 'active',
              agents: [],
            },
          });
        },
        { filter: { sessionId: 'source-session' } },
      ),
    );

    ctx.registerMessageGetMock();

    // Mock session creation
    ctx.addCleanup(
      MakaioBus.on(SessionSubjects.create, (busCtx) => {
        busCtx.setResult({ sessionId: 'new-fork-session' });
      }),
    );

    ctx.addCleanup(MakaioBus.on(SessionSubjects.branch.created, () => {}));

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      fromMessageId: 'msg-5',
    });

    expect(result.sessionId).toBe('new-fork-session');
    // Key assertion: NO messages should be copied
    expect(appendedMessages).toHaveLength(0);
  });

  it('should accept branchKind: aside and map name to title', async () => {
    let createdSessionPayload: unknown;

    ctx.setupForkMocks({
      sourceSessionId: 'source-session',
      forkResultSessionId: 'aside-session',
      onCreatePayload: (payload) => {
        createdSessionPayload = payload;
      },
    });

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      branchKind: 'aside',
      name: 'test question',
    });

    expect(result.sessionId).toBe('aside-session');
    expect(createdSessionPayload).toMatchObject({
      branchKind: 'aside',
      title: 'test question',
    });
  });

  it('should set forkPointMessageId on new session', async () => {
    let createdSessionPayload: unknown;

    ctx.addCleanup(
      MakaioBus.on(SessionSubjects.get, (busCtx) => {
        busCtx.setResult({
          session: {
            sessionId: 'source-session',
            title: 'Source',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            status: 'active',
            agents: [],
          },
        });
      }),
    );
    ctx.registerMessageGetMock();
    ctx.addCleanup(MakaioBus.on(SessionSubjects.branch.created, () => {}));

    ctx.addCleanup(
      MakaioBus.on(SessionSubjects.create, (busCtx) => {
        createdSessionPayload = busCtx.payload;
        busCtx.setResult({ sessionId: 'new-fork' });
      }),
    );

    await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      fromMessageId: 'fork-point-msg',
    });

    expect(createdSessionPayload).toMatchObject({
      parentSessionId: 'source-session',
      forkPointMessageId: 'fork-point-msg',
      branchKind: 'fork',
    });
  });
});
