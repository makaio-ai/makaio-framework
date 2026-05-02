import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { actionRegistry } from '../../session-editor/action-registry.js';
import { registerBuiltInActions, resetBuiltInActionsRegistration } from '../../session-editor/actions/index.js';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { createForkHandlerContext, type ForkHandlerTestContext } from './shared.js';

/**
 * Shared source-message fixture factory for segment-validation tests.
 * @param ids - Ordered message IDs to generate
 * @returns Session messages in ascending order
 */
function createSourceMessages(ids: string[]) {
  return ids.map((messageId, index) => ({
    messageId,
    turnId: null,
    sessionId: 'source-session',
    role: index === 0 ? ('user' as const) : ('assistant' as const),
    contentText: messageId,
    blocks: [],
    timestamp: index + 1,
  }));
}

describe('fork-handler transforms validation', () => {
  let ctx: ForkHandlerTestContext;

  beforeEach(() => {
    actionRegistry.reset();
    resetBuiltInActionsRegistration();
    registerBuiltInActions();
    ctx = createForkHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  it('should accept fork with valid transformation action', async () => {
    ctx.setupForkMocks();

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      transforms: {
        appliedPipeline: [{ actionId: 'strip-tool-outputs' }],
      },
    });

    expect(result.sessionId).toBe('new-fork-session');
  });

  it('should accept fork with removedMessageIds only', async () => {
    ctx.setupForkMocks();

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      transforms: {
        removedMessageIds: ['msg-1', 'msg-2'],
      },
    });

    expect(result.sessionId).toBe('new-fork-session');
  });

  it('should accept fork without transforms', async () => {
    ctx.setupForkMocks();

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
    });

    expect(result.sessionId).toBe('new-fork-session');
  });

  it('should reject pipeline with non-transformation actions', async () => {
    ctx.setupForkMocks();

    await expect(
      MakaioBus.request(SessionSubjects.fork, {
        sourceSessionId: 'source-session',
        transforms: {
          appliedPipeline: [{ actionId: 'messages-to-context' }],
        },
      }),
    ).rejects.toThrow(
      "Action 'messages-to-context' is category 'extraction', " +
        "but only 'transformation' actions are allowed in fork transforms",
    );
  });

  it('should reject pipeline with unknown actions', async () => {
    ctx.setupForkMocks();

    await expect(
      MakaioBus.request(SessionSubjects.fork, {
        sourceSessionId: 'source-session',
        transforms: {
          appliedPipeline: [{ actionId: 'non-existent-action' }],
        },
      }),
    ).rejects.toThrow('Unknown action in pipeline: non-existent-action');
  });

  /**
   * Sets up source session mock, session.create capture, and branch.created capture.
   * @returns Captured payloads for create and branch events
   */
  function setupCapturedForkMocks() {
    const captured: { create: unknown; branch: unknown } = { create: undefined, branch: undefined };

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

    ctx.addCleanup(
      MakaioBus.on(SessionSubjects.create, (busCtx) => {
        captured.create = busCtx.payload;
        busCtx.setResult({ sessionId: 'new-fork-session' });
      }),
    );

    ctx.addCleanup(
      MakaioBus.on(SessionSubjects.branch.created, (busCtx) => {
        captured.branch = busCtx.payload;
      }),
    );

    return captured;
  }

  it('should pass transforms to session.create', async () => {
    const captured = setupCapturedForkMocks();

    const transforms = {
      removedMessageIds: ['msg-1'],
      appliedPipeline: [{ actionId: 'strip-tool-outputs' }],
    };

    await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      transforms,
    });

    expect(captured.create).toMatchObject({
      forkTransforms: transforms,
    });
  });

  it('should include transforms in branch.created event', async () => {
    const captured = setupCapturedForkMocks();

    const transforms = {
      removedMessageIds: ['msg-1'],
      appliedPipeline: [{ actionId: 'strip-tool-outputs' }],
    };

    await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      transforms,
    });

    expect(captured.branch).toMatchObject({
      transforms,
    });
  });

  it('should accept contiguous ordered segments covering the full source message range', async () => {
    ctx.setupForkMocks();
    ctx.addCleanup(
      MakaioBus.on(MessageStorageSubjects.getBySession, (busCtx) => {
        busCtx.setResult({
          messages: createSourceMessages(['m1', 'm2']),
          nextCursor: null,
        });
      }),
    );

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      transforms: {
        segments: [{ fromMessageId: 'm1', toMessageId: 'm2', policy: 'verbatim' }],
      },
    });

    expect(result.sessionId).toBe('new-fork-session');
  });

  it('should reject segments with gaps', async () => {
    ctx.setupForkMocks();
    ctx.addCleanup(
      MakaioBus.on(MessageStorageSubjects.getBySession, (busCtx) => {
        busCtx.setResult({
          messages: createSourceMessages(['m1', 'm2', 'm3']),
          nextCursor: null,
        });
      }),
    );

    await expect(
      MakaioBus.request(SessionSubjects.fork, {
        sourceSessionId: 'source-session',
        transforms: {
          segments: [
            { fromMessageId: 'm1', toMessageId: 'm1', policy: 'verbatim' },
            { fromMessageId: 'm3', toMessageId: 'm3', policy: 'verbatim' },
          ],
        },
      }),
    ).rejects.toThrow('Segments must be contiguous without gaps');
  });

  it('should validate segment boundaries across paginated source-message reads', async () => {
    ctx.setupForkMocks();
    const allMessages = createSourceMessages(['m1', 'm2', 'm3']);

    ctx.addCleanup(
      MakaioBus.on(MessageStorageSubjects.getBySession, (busCtx) => {
        const { after } = busCtx.payload;

        if (!after) {
          busCtx.setResult({
            messages: allMessages.slice(0, 2),
            nextCursor: {
              timestamp: allMessages[1].timestamp,
              messageId: allMessages[1].messageId,
            },
          });
          return;
        }

        if (after.timestamp !== allMessages[1].timestamp || after.messageId !== allMessages[1].messageId) {
          throw new Error(`Unexpected pagination cursor: ${JSON.stringify(after)}`);
        }

        busCtx.setResult({
          messages: allMessages.slice(2),
          nextCursor: null,
        });
      }),
    );

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      transforms: {
        segments: [
          { fromMessageId: 'm1', toMessageId: 'm2', policy: 'verbatim' },
          { fromMessageId: 'm3', toMessageId: 'm3', policy: 'verbatim' },
        ],
      },
    });

    expect(result.sessionId).toBe('new-fork-session');
  });

  it('should validate segments against source messages truncated at fork point', async () => {
    ctx.setupForkMocks();
    ctx.registerMessageGetMock('source-session');

    ctx.addCleanup(
      MakaioBus.on(MessageStorageSubjects.getBySession, (busCtx) => {
        busCtx.setResult({
          messages: createSourceMessages(['m1', 'm2', 'm3', 'm4']),
          nextCursor: null,
        });
      }),
    );

    const result = await MakaioBus.request(SessionSubjects.fork, {
      sourceSessionId: 'source-session',
      fromMessageId: 'm2',
      transforms: {
        segments: [{ fromMessageId: 'm1', toMessageId: 'm2', policy: 'verbatim' }],
      },
    });

    expect(result.sessionId).toBe('new-fork-session');
  });
});
