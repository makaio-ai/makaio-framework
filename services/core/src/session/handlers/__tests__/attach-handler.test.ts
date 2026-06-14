import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { AdapterSubjects, AgentResolutionSubjects, CredentialSubjects, SessionSubjects } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../../adapter-runtime/index.js';
import { AdapterRuntimeSubjects } from '../../../adapter-runtime/namespace.js';
import { AdapterSubsystemSubjects } from '../../../adapter-subsystem/namespace.js';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { ATTACH_TEST_IDS, createAttachHandlerContext, type AttachHandlerTestContext } from './shared.js';
import { resetBusHandlers } from '../../__tests__/shared.js';
import { Turn } from '../../entities/turn.js';

describe('registerAttachHandler', () => {
  const { sessionId, adapterName, agentId, adapterSessionId } = ATTACH_TEST_IDS;

  let ctx: AttachHandlerTestContext;

  beforeEach(() => {
    ctx = createAttachHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  describe('should attach agent to session via adapter.startAgent', () => {
    it('calls startAgent with correct payload', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        adapterId: buildDeterministicAdapterId('test-machine', adapterName),
        sessionId,
        role: 'lead',
      });
      expect(result.agentId).toBe(agentId);
      expect(result.adapterSessionId).toBe(adapterSessionId);
    });

    it('uses resolved providerContext on local attachResolved without rebuilding it', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const providerContext = {
        providerConfigId: 'provider-config-resolved',
        definitionId: 'provider-definition-resolved',
        endpointOverrides: { anthropic: 'https://provider.example/chat' },
        credentialRefs: { apiKey: buildStoredCredentialRef('provider-config-resolved', 'apiKey') },
      };
      let buildProviderContextCalled = false;
      let credentialActivated = false;

      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (context) => {
          buildProviderContextCalled = true;
          context.setResult({
            context: {
              providerConfigId: context.payload.providerConfigId,
              definitionId: 'unexpected-provider-definition',
              credentialRefs: {},
            },
          });
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(CredentialSubjects.activate, (context) => {
          credentialActivated = true;
          expect(context.payload.providerConfigId).toBe(providerContext.providerConfigId);
          context.setResult({});
        }),
      );
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attachResolved, {
        sessionId,
        agent: { kind: 'adapter', adapterName, providerContext },
      });

      expect(buildProviderContextCalled).toBe(false);
      expect(credentialActivated).toBe(true);
      expect(receivedRequests[0]).toMatchObject({ providerContext });
    });

    it('passes machineId to adapter resolution when provided', async () => {
      resetBusHandlers();
      const activeTurns = new Map<string, Turn>();

      let resolvePayload: { adapterName?: string; machineId?: string } | undefined;
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterRuntimeSubjects.resolveId, (context) => {
          resolvePayload = context.payload;
          context.setResult({ adapterId: 'node-scoped-adapter-id' });
        }),
      );
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler({
        adapterId: 'node-scoped-adapter-id',
      });
      ctx.trackUnsubscribe(unsubscribe);

      const { registerAttachHandler } = await import('../attach-handler.js');
      ctx.trackUnsubscribe(registerAttachHandler(MakaioBus, activeTurns, 'node-local'));

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(resolvePayload).toMatchObject({
        adapterName,
        machineId: 'node-local',
      });
      expect(receivedRequests[0]).toMatchObject({
        adapterId: 'node-scoped-adapter-id',
      });
    });

    it('throws error when session not found', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(null));
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
        }),
      ).rejects.toThrow(`Session not found: ${sessionId}`);
    });

    it('throws error when session is not active', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession({ status: 'closed' })));
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
        }),
      ).rejects.toThrow(`Session is not active: ${sessionId}`);
    });

    it('throws error when startAgent fails', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(ctx.registerFailingStartAgentHandler('Adapter connection failed'));
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
        }),
      ).rejects.toThrow('Failed to start agent: Adapter connection failed');
    });

    it('resolves persona when adapterName is omitted', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(
        MakaioBus.on(AgentResolutionSubjects.resolve, (context) => {
          context.setResult({
            adapterName: 'resolved-adapter',
            model: 'resolved-model',
            contextMode: 'fresh',
            compressionMode: 'off',
          });
        }),
      );
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'persona', personaId: 'persona-1' },
      });

      expect(receivedRequests[0]).toMatchObject({
        adapterId: buildDeterministicAdapterId('test-machine', 'resolved-adapter'),
        model: 'resolved-model',
      });
    });

    it('awaits credential.activate before startAgent when providerConfigId is present', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (context) => {
          context.setResult({
            context: {
              providerConfigId: 'provider-config-1',
              definitionId: 'provider-def-1',
              credentialRefs: { apiKey: buildStoredCredentialRef('provider-config-1', 'apiKey') },
            },
          });
        }),
      );

      const order: string[] = [];
      ctx.trackUnsubscribe(
        MakaioBus.on(CredentialSubjects.activate, (context) => {
          order.push('activate');
          expect(context.payload).toMatchObject({
            providerConfigId: 'provider-config-1',
            definitionId: 'provider-def-1',
          });
          context.setResult({});
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubjects.startAgent, () => {
          order.push('start');
        }),
      );
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, providerConfigId: 'provider-config-1' },
      });

      expect(order).toEqual(['activate', 'start']);
      expect(receivedRequests).toHaveLength(1);
    });

    it('throws when no adapterName can be resolved from request or persona/profile/virtualModel', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(ctx.registerHandler());

      const error = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName: '' },
      }).catch((err: unknown) => err);
      const requestError = error as RequestError;

      expect(error).toBeInstanceOf(RequestError);
      expect(error).toBeInstanceOf(Error);
      expect(requestError.cause).toBeInstanceOf(Error);
      expect((requestError.cause as Error).message).toBe(
        '[attach-handler] adapterName or adapterId is required — provide one explicitly or via persona/profile/virtualModel resolution',
      );
    });

    it('rejects name-based resolution when no explicit or runtime-default machineId exists', async () => {
      ctx.destroy();
      ctx = createAttachHandlerContext(null);
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(ctx.registerHandler());

      const error = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).cause).toBeInstanceOf(Error);
      expect(((error as RequestError).cause as Error).message).toBe(
        `resolveId requires machineId when no runtime default machine is configured for adapterName="${adapterName}"`,
      );
    });

    it('backfills adapterName from adapterId when the direct selection omits adapterName', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      await ctx.registerKnownAdapter('resolved-adapter-name', 'machine-1:resolved-adapter-name');
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler({
        adapterId: 'machine-1:resolved-adapter-name',
      });
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterId: 'machine-1:resolved-adapter-name' },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        adapterId: 'machine-1:resolved-adapter-name',
        sessionId,
        role: 'lead',
      });
      expect(result.agentId).toBe(agentId);
      expect(result.adapterSessionId).toBe(adapterSessionId);
    });

    it('throws when adapterName and adapterId are provided but storage name differs', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      await ctx.registerKnownAdapter('actual-adapter-name', 'machine-1:actual-adapter-name');
      ctx.trackUnsubscribe(ctx.registerHandler());

      const error = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName: 'wrong-adapter-name',
          adapterId: 'machine-1:actual-adapter-name',
        },
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).cause).toBeInstanceOf(Error);
      expect(((error as RequestError).cause as Error).message).toBe(
        '[attach-handler] adapterName "wrong-adapter-name" does not match adapterId "machine-1:actual-adapter-name"',
      );
    });
  });

  /** Creates a mock existing agent for role determination tests. */
  function createExistingLeadAgent() {
    return {
      agentId: 'existing-agent',
      adapterId: 'existing-adapter',
      adapterName: 'test-adapter',
      sessionId: 'session-1',
      status: 'idle' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      role: 'lead' as const,
    };
  }

  /**
   * Registers session get, start agent, and handler mocks for role tests.
   * @param hasExistingAgents - Whether the session already has agents
   */
  function setupRoleTest(hasExistingAgents: boolean) {
    const agents = hasExistingAgents ? [createExistingLeadAgent()] : [];
    ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession({ agents })));
    const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
    ctx.trackUnsubscribe(unsubscribe);
    ctx.trackUnsubscribe(ctx.registerHandler());
    return { receivedRequests };
  }

  describe('should determine role based on existing agents', () => {
    it('assigns lead role when session has no agents', async () => {
      const { receivedRequests } = setupRoleTest(false);

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests[0].role).toBe('lead');
      expect(result.role).toBe('lead');
    });

    it('assigns member role when session already has agents', async () => {
      const { receivedRequests } = setupRoleTest(true);

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests[0].role).toBe('member');
      expect(result.role).toBe('member');
    });
  });

  describe('should respect explicitly requested role', () => {
    it('uses requested lead role even when agents exist', async () => {
      const { receivedRequests } = setupRoleTest(true);

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        role: 'lead',
      });

      expect(receivedRequests[0].role).toBe('lead');
      expect(result.role).toBe('lead');
    });

    it('uses requested member role even when no agents exist', async () => {
      const { receivedRequests } = setupRoleTest(false);

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        role: 'member',
      });

      expect(receivedRequests[0].role).toBe('member');
      expect(result.role).toBe('member');
    });
  });

  describe('cleanup function', () => {
    it('returns a cleanup function that unsubscribes the handler', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);

      const handlerCleanup = ctx.registerHandler();

      // Handler should work before cleanup
      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });
      expect(result.agentId).toBe(agentId);

      // Call cleanup
      handlerCleanup();

      // Handler should no longer work after cleanup
      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
        }),
      ).rejects.toThrow(); // NoHandlerError
    });
  });
});
