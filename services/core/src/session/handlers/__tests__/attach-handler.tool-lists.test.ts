import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentResolutionSubjects, SessionSubjects } from '@makaio/contracts';
import { ATTACH_TEST_IDS, createAttachHandlerContext, type AttachHandlerTestContext } from './shared.js';

/**
 * Tool-list-carrying cases for the persisted attach agent row.
 *
 * Extracted from `attach-handler.test.ts` (see its own top for the split
 * rationale) rather than grown inline: the file is already sized against its
 * own coverage, and a tool-list case needs its own persona-resolution mock
 * setup that does not belong beside the unrelated cases there.
 */
describe('registerAttachHandler — allowedTools/disallowedTools on the persisted row', () => {
  const { sessionId, adapterName } = ATTACH_TEST_IDS;

  let ctx: AttachHandlerTestContext;

  beforeEach(() => {
    ctx = createAttachHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  it('persists the explicit allowedTools/disallowedTools onto the caller-owned row', async () => {
    ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
    const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
    ctx.trackUnsubscribe(unsubscribe);
    ctx.trackUnsubscribe(ctx.registerHandler());

    await MakaioBus.request(SessionSubjects.agent.attach, {
      sessionId,
      agent: {
        kind: 'adapter',
        adapterName,
        allowedTools: ['read_file', 'edit_file'],
        disallowedTools: ['shell_exec'],
      },
    });

    const agentId = receivedRequests[0]?.agentId;
    expect(agentId).toBeDefined();
    expect(ctx.getStoredAgent(agentId!)).toMatchObject({
      allowedTools: ['read_file', 'edit_file'],
      disallowedTools: ['shell_exec'],
    });
  });

  it('persists a tool list that comes only from the resolved persona/profile config', async () => {
    ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
    ctx.trackUnsubscribe(
      MakaioBus.on(AgentResolutionSubjects.resolve, (context) => {
        context.setResult({
          adapterName: 'resolved-adapter',
          contextMode: 'fresh',
          compressionMode: 'off',
          allowedTools: ['read_file'],
          disallowedTools: ['shell_exec', 'write_file'],
        });
      }),
    );
    await ctx.registerKnownAdapter('resolved-adapter');
    const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
    ctx.trackUnsubscribe(unsubscribe);
    ctx.trackUnsubscribe(ctx.registerHandler());

    // The selection itself names no lists — only the persona resolution does —
    // so a row carrying them proves `mergeRuntimeOptions` fell through to the
    // resolved config rather than an explicit override.
    await MakaioBus.request(SessionSubjects.agent.attach, {
      sessionId,
      agent: { kind: 'persona', personaId: 'persona-1' },
    });

    const agentId = receivedRequests[0]?.agentId;
    expect(agentId).toBeDefined();
    expect(ctx.getStoredAgent(agentId!)).toMatchObject({
      allowedTools: ['read_file'],
      disallowedTools: ['shell_exec', 'write_file'],
    });
  });
});
