import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, AgentResolutionSubjects } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../../adapter-runtime/index.js';
import {
  ATTACH_TEST_IDS,
  createAttachHandlerContext,
  registerSuccessfulMessageAppendHandler,
  registerSuccessfulSendHandler,
  type AttachHandlerTestContext,
} from './shared.js';

describe('registerAttachHandler - runtime options', () => {
  const { sessionId, adapterName } = ATTACH_TEST_IDS;

  let ctx: AttachHandlerTestContext;

  beforeEach(() => {
    ctx = createAttachHandlerContext();
    ctx.trackUnsubscribe(registerSuccessfulSendHandler());
  });

  afterEach(() => {
    ctx.destroy();
  });

  describe('should pass through runtime options', () => {
    it('passes initialMessage promptText into virtual model resolution context', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(registerSuccessfulMessageAppendHandler());
      ctx.trackUnsubscribe(
        MakaioBus.on(AgentResolutionSubjects.resolve, (context) => {
          expect(context.payload).toMatchObject({
            selection: {
              kind: 'virtual-model',
              virtualModelId: 'vm-intent-router',
            },
            context: {
              sessionId,
              promptText: 'Classify this request',
            },
          });
          context.setResult({
            adapterName: 'resolved-from-virtual-model',
            model: 'resolved-model',
            contextMode: 'fresh',
            compressionMode: 'off',
          });
        }),
      );
      await ctx.registerKnownAdapter('resolved-from-virtual-model');
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'virtual-model', virtualModelId: 'vm-intent-router' },
        initialMessage: 'Classify this request',
      });

      expect(receivedRequests[0]).toMatchObject({
        adapterId: buildDeterministicAdapterId('test-machine', 'resolved-from-virtual-model'),
        model: 'resolved-model',
      });
    });

    it('passes model to startAgent request', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, model: 'opus' },
      });

      expect(receivedRequests[0].model).toBe('opus');
    });

    it('passes cwd to startAgent request', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const cwd = '/path/to/project';
      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, cwd },
      });

      expect(receivedRequests[0].cwd).toBe(cwd);
    });

    it('passes allowedTools to startAgent request', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const allowedTools = ['Read', 'Write', 'Bash'];
      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, allowedTools },
      });

      expect(receivedRequests[0].allowedTools).toEqual(allowedTools);
    });

    it('passes disallowedTools to startAgent request', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const disallowedTools = ['Bash', 'WebFetch'];
      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, disallowedTools },
      });

      expect(receivedRequests[0].disallowedTools).toEqual(disallowedTools);
    });

    it('passes multiple runtime options together', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName,
          model: 'sonnet',
          cwd: '/workspace',
          allowedTools: ['Read'],
          disallowedTools: ['Bash'],
        },
      });

      expect(receivedRequests[0]).toMatchObject({
        model: 'sonnet',
        cwd: '/workspace',
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
      });
    });

    it('passes explicit attach runtime payloads that do not come from agent resolution', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const adapterConfig = { sandbox: { mode: 'review' }, maxTurns: 2 };
      const env = { REVIEW_MODE: 'strict' };
      const mcpSessionContext = {
        sessionId,
        servers: [],
        directTools: [],
        discoverableTools: [],
      };

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName,
          adapterConfig,
          env,
          mcpSessionContext,
        },
      });

      expect(receivedRequests[0]).toMatchObject({
        adapterConfig,
        env,
        mcpSessionContext,
      });
    });

    it('does not include undefined runtime options', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      // Only check keys that should NOT be present
      expect(receivedRequests[0]).not.toHaveProperty('model');
      expect(receivedRequests[0]).not.toHaveProperty('cwd');
      expect(receivedRequests[0]).not.toHaveProperty('allowedTools');
      expect(receivedRequests[0]).not.toHaveProperty('disallowedTools');
      expect(receivedRequests[0]).not.toHaveProperty('adapterConfig');
      expect(receivedRequests[0]).not.toHaveProperty('env');
      expect(receivedRequests[0]).not.toHaveProperty('mcpSessionContext');
    });
  });
});
