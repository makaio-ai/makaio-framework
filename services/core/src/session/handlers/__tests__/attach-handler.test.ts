import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentResolutionSubjects,
  CredentialSubjects,
  SessionSubjects,
  defineAdapterProviderAuth,
  type ResolvedProviderContext,
} from '@makaio/contracts';
import type { AdapterProviderAuth } from '@makaio/contracts/auth';
import { buildDeterministicAdapterId } from '../../../adapter-runtime/index.js';
import { AdapterRuntimeSubjects } from '../../../adapter-runtime/namespace.js';
import { AdapterSubsystemSubjects } from '../../../adapter-subsystem/namespace.js';
import type {
  AdapterRuntimeSnapshotResolution,
  ProviderConfigAuthSummary,
  ProviderRuntimeSnapshot,
} from '../../../adapter-subsystem/schemas.js';
import { RuntimeProviderContextResolutionError } from '../../../provider-context/index.js';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import {
  ATTACH_TEST_IDS,
  createAttachHandlerContext,
  registerDefaultConversationStubs,
  type AttachHandlerTestContext,
} from './shared.js';
import { resetBusHandlers } from '../../__tests__/shared.js';

const TEST_AUTH_METHOD = {
  id: 'api-key',
  mode: 'explicit' as const,
  label: 'API key',
  fields: [
    {
      id: 'apiKey',
      label: 'API key',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment' as const, variable: 'TEST_API_KEY' }],
    },
  ],
};

/**
 * Build a complete explicit provider context for attach-handler tests.
 * @param providerConfigId - Provider config selected by the attach flow.
 * @param definitionId - Provider definition selected by the attach flow.
 * @returns Explicit provider context fixture.
 */
function makeProviderContext(providerConfigId: string, definitionId = 'provider-def-1'): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId,
    auth: {
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: definitionId, methodId: 'api-key' },
      definition: TEST_AUTH_METHOD,
      credentialRefs: { apiKey: buildStoredCredentialRef(providerConfigId, 'apiKey') },
    },
  };
}

/**
 * Build a managed inferred provider context for activation-order tests.
 * @param providerConfigId - Provider config selected by the attach flow.
 * @returns Inferred provider context fixture.
 */
function makeInferredProviderContext(providerConfigId: string): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId: 'provider-def-1',
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native account' },
      account: { managerId: 'account-manager', accountId: 'account-1' },
    },
  };
}

/**
 * Build the provider portion of one atomic adapter runtime snapshot.
 * @param providerContext - Resolved context represented by the snapshot.
 * @returns Complete provider runtime snapshot fixture.
 */
function makeProviderRuntimeSnapshot(providerContext: ResolvedProviderContext): ProviderRuntimeSnapshot {
  const authSummary: ProviderConfigAuthSummary =
    providerContext.auth.mode === 'explicit'
      ? {
          mode: providerContext.auth.mode,
          method: providerContext.auth.method,
          hasCredentials: true as const,
        }
      : providerContext.auth.mode === 'inferred'
        ? {
            mode: providerContext.auth.mode,
            method: providerContext.auth.method,
            ...(providerContext.auth.account ? { account: providerContext.auth.account } : {}),
            hasCredentials: false as const,
          }
        : {
            mode: providerContext.auth.mode,
            method: providerContext.auth.method,
            hasCredentials: false as const,
          };
  return {
    config: {
      id: providerContext.providerConfigId,
      definitionId: providerContext.definitionId,
      name: 'Test Provider',
      modelFilterMode: 'show-all' as const,
      isDefault: false,
      enabled: true,
      auth: authSummary,
    },
    context: providerContext,
    definition: {
      id: providerContext.definitionId,
      packageName: '@makaio/provider-test',
      name: 'Test Provider',
      availableModels: [],
      authMethods:
        providerContext.auth.method.owner === 'provider' && providerContext.auth.mode !== 'inferred'
          ? [providerContext.auth.definition]
          : [],
      defaultModelFilterMode: 'show-all' as const,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/**
 * Build an adapter-qualified runtime resolution for attach execution.
 * @param providerContext - Resolved context represented by the snapshot.
 * @param adapterName - Adapter selected by the attach request.
 * @returns Successful adapter runtime resolution fixture.
 */
function makeAdapterRuntimeResolution(
  providerContext: ResolvedProviderContext,
  adapterName: string,
): AdapterRuntimeSnapshotResolution {
  const method = providerContext.auth.method;
  const clientId = method.owner === 'client' ? method.clientId : undefined;
  const deliveries: AdapterProviderAuth['bindings'][number]['deliveries'] =
    providerContext.auth.mode === 'inferred'
      ? [{ kind: 'native-client', clientId: providerContext.auth.method.clientId }]
      : providerContext.auth.mode === 'explicit'
        ? [{ kind: 'connector', target: 'test', fields: { apiKey: 'apiKey' } }]
        : [{ kind: 'none' }];
  return {
    status: 'resolved' as const,
    runtime: {
      snapshot: makeProviderRuntimeSnapshot(providerContext),
      adapterName,
      ...(clientId !== undefined ? { adapterClientId: clientId } : {}),
      adapterProviderAuth: defineAdapterProviderAuth({
        bindings: [
          {
            method,
            deliveries,
          },
        ],
        scrubEnvVars: ['TEST_API_KEY'],
      }),
      compatibleProviderAuths: [],
      runtimePackages: {
        adapter: { packageName: '@makaio/adapter-test' },
        provider: { packageName: '@makaio/provider-test', definitionId: providerContext.definitionId },
        ...(clientId !== undefined ? { client: { packageName: '@makaio/client-test', clientId } } : {}),
      },
    },
  };
}

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

    it('uses explicit providerContext on local attachResolved without rebuilding or native activation', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const providerContext: ResolvedProviderContext = {
        ...makeProviderContext('provider-config-resolved', 'provider-definition-resolved'),
        endpointOverrides: { anthropic: 'https://provider.example/chat' },
      };
      let runtimeProviderContextResolutionCalled = false;
      let credentialActivated = false;

      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (context) => {
          runtimeProviderContextResolutionCalled = true;
          context.setResult(makeAdapterRuntimeResolution(providerContext, adapterName));
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(CredentialSubjects.activate, (context) => {
          credentialActivated = true;
          expect(context.payload.providerContext).toEqual(providerContext);
          context.setResult({ success: true });
        }),
      );
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attachResolved, {
        sessionId,
        agent: { kind: 'adapter', adapterName, providerContext },
      });

      expect(runtimeProviderContextResolutionCalled).toBe(false);
      expect(credentialActivated).toBe(false);
      expect(receivedRequests[0]).toMatchObject({ providerContext });
    });

    it('rejects an unresolved local context when a provider config was selected', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(ctx.registerHandler());

      const error = await MakaioBus.request(SessionSubjects.agent.attachResolved, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName,
          providerConfigId: 'provider-config-selected',
          providerContext: { state: 'unresolved' },
        },
      }).catch((value: unknown) => value);

      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).cause).toBeInstanceOf(RuntimeProviderContextResolutionError);
      expect(((error as RequestError).cause as RuntimeProviderContextResolutionError).code).toBe(
        'provider-context-unresolved',
      );
    });

    it('passes machineId to adapter resolution when provided', async () => {
      resetBusHandlers();

      // Conversation storage stubs: resetBusHandlers() cleared the defaults
      // registered by createAttachHandlerContext. Non-native attach paths now
      // call seedAttachContextWithHistory which reads the conversation chain.
      registerDefaultConversationStubs(ctx.trackUnsubscribe);

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
      ctx.trackUnsubscribe(registerAttachHandler(MakaioBus, ctx.turnManager, 'node-local'));

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

    it('delegates managed account activation to startAgent when providerConfigId is present', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (context) => {
          const providerContext = makeInferredProviderContext(context.payload.providerConfigId);
          context.setResult(makeAdapterRuntimeResolution(providerContext, context.payload.adapterName));
        }),
      );

      const order: string[] = [];
      let credentialActivated = false;
      ctx.trackUnsubscribe(
        MakaioBus.on(CredentialSubjects.activate, (context) => {
          credentialActivated = true;
          context.setResult({ success: true });
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

      expect(order).toEqual(['start']);
      expect(credentialActivated).toBe(false);
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]?.providerContext).toMatchObject({
        providerConfigId: 'provider-config-1',
        definitionId: 'provider-def-1',
      });
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
