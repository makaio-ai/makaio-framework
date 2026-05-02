/**
 * Tests for targetWorkingDirectory in fork handler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { createForkHandlerContext, type ForkHandlerTestContext } from './shared.js';

describe('fork-handler - targetWorkingDirectory', () => {
  let ctx: ForkHandlerTestContext;

  beforeEach(() => {
    ctx = createForkHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  it('should pass targetWorkingDirectory from fork request to session.create', async () => {
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
        busCtx.setResult({ sessionId: 'new-fork-with-cwd' });
      }),
    );

    await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      fromMessageId: 'fork-point-msg',
      targetWorkingDirectory: '/custom/cwd',
    });

    expect(createdSessionPayload).toMatchObject({
      parentSessionId: 'source-session',
      forkPointMessageId: 'fork-point-msg',
      branchKind: 'fork',
      targetWorkingDirectory: '/custom/cwd',
    });
  });

  it('should create session without targetWorkingDirectory when not provided', async () => {
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
        busCtx.setResult({ sessionId: 'new-fork-no-cwd' });
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
    expect((createdSessionPayload as { targetWorkingDirectory?: string }).targetWorkingDirectory).toBeUndefined();
  });
});
