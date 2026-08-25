/**
 * SessionOrchestrator tests - Auto-attach flow.
 *
 * Tests the automatic session creation and agent attachment when
 * sendMessage is called with a sessionId that does not exist or to a session with no agents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  CanonicalModelSubjects,
  CredentialSubjects,
  SessionSubjects,
  defineAdapterProviderAuth,
  type ResolvedProviderContext,
} from '@makaio/contracts';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../adapter-runtime/index.js';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import { SessionBridge } from '../session-bridge.js';
import type { AdapterRuntimeSnapshotResolution, ProviderRuntimeSnapshot } from '../../adapter-subsystem/schemas.js';
import { MakaioSessionService } from '../session-service.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import {
  registerStartAgentHandler,
  registerSendMessageHandler,
  registerRehydrateAgentHandler,
  registerCwdChangeHandler,
  registerModelChangeHandler,
  emitAgentAdded,
  collectTurnStartedEvents,
  collectUserMessageSentEvents,
  collectUserMessageAcknowledgedEvents,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';
import { registerMockAdapterIdentityHandlers } from '../testing/mock-adapter-identity-registry.js';
import { registerMemorySessionBackends, resetBusHandlers, waitForAsync } from './shared.js';

/** Machine identity the orchestrator, the adapter ids and the authority share. */
const MACHINE_ID = 'test-machine';

/**
 * Build a managed inferred context for auto-attach activation tests.
 * @param providerConfigId - Provider config selected for the test.
 * @param definitionId - Provider definition selected for the test.
 * @returns Resolved provider context fixture.
 */
function makeProviderContext(providerConfigId: string, definitionId: string): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId,
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native account' },
      account: { managerId: 'account-manager', accountId: 'account-1' },
    },
  };
}

/**
 * Build the atomic provider snapshot consumed by auto-attach.
 * @param providerContext - Resolved provider context represented by the snapshot.
 * @returns Complete provider runtime snapshot fixture.
 */
function makeProviderRuntimeSnapshot(providerContext: ResolvedProviderContext): ProviderRuntimeSnapshot {
  if (providerContext.auth.mode !== 'inferred') throw new Error('Expected inferred provider context fixture.');
  return {
    config: {
      id: providerContext.providerConfigId,
      definitionId: providerContext.definitionId,
      name: 'Test Provider',
      modelFilterMode: 'show-all' as const,
      isDefault: false,
      enabled: true,
      auth: {
        mode: providerContext.auth.mode,
        method: providerContext.auth.method,
        account: providerContext.auth.account,
        hasCredentials: false as const,
      },
    },
    context: providerContext,
    definition: {
      id: providerContext.definitionId,
      packageName: '@makaio/provider-test',
      name: 'Test Provider',
      availableModels: [],
      authMethods: [],
      defaultModelFilterMode: 'show-all' as const,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/**
 * Build an adapter-qualified atomic runtime resolution for auto-attach.
 * @param providerContext - Resolved provider context represented by the snapshot.
 * @param adapterName - Adapter selected by the runtime request.
 * @returns Successful adapter runtime resolution fixture.
 */
function makeAdapterRuntimeResolution(
  providerContext: ResolvedProviderContext,
  adapterName: string,
): AdapterRuntimeSnapshotResolution {
  if (providerContext.auth.mode !== 'inferred') throw new Error('Expected inferred provider context fixture.');
  const clientId = providerContext.auth.method.clientId;
  return {
    status: 'resolved' as const,
    runtime: {
      snapshot: makeProviderRuntimeSnapshot(providerContext),
      adapterName,
      adapterClientId: clientId,
      adapterProviderAuth: defineAdapterProviderAuth({
        bindings: [
          {
            method: providerContext.auth.method,
            deliveries: [{ kind: 'native-client' as const, clientId }],
          },
        ],
        scrubEnvVars: ['TEST_API_KEY'],
      }),
      compatibleProviderAuths: [],
      runtimePackages: {
        adapter: { packageName: '@makaio/adapter-test' },
        provider: { packageName: '@makaio/provider-test', definitionId: providerContext.definitionId },
        client: { packageName: '@makaio/client-test', clientId },
      },
    },
  };
}

describe('SessionOrchestrator - Auto-attach', () => {
  let orchestrator: SessionOrchestrator;
  let bridge: SessionBridge;
  let service: MakaioSessionService;
  let unsubscribers: UnsubscribeFunction[];
  let defaultCwdChangeUnsub: UnsubscribeFunction | undefined;
  let defaultModelChangeUnsub: UnsubscribeFunction | undefined;
  let announceLiveAdapter: (adapterName: string, adapterId?: string) => Promise<void>;

  beforeEach(async () => {
    resetBusHandlers();
    unsubscribers = [];

    // Auto-attach ends in a reserved fresh lead start, and a reservation is a
    // hard dependency of every start path: the session, agent and ownership
    // rows therefore come from the real memory backends over one shared state,
    // and only the turn/message/routing surface is stubbed. Composing the real
    // session service is what registers the authority those starts reserve
    // from — the same call that registers `session.create`, `session.get` and
    // `session.agent.added`, which this suite used to stub over a plain map.
    unsubscribers.push(...registerMemorySessionBackends(MakaioBus));
    unsubscribers.push(registerMemorySessionEventStorage(MakaioBus));
    unsubscribers.push(registerMockStorageHandlers({ omit: ['agent', 'session'] }));
    unsubscribers.push(registerRehydrateAgentHandler());
    defaultCwdChangeUnsub = registerCwdChangeHandler();
    defaultModelChangeUnsub = registerModelChangeHandler();
    unsubscribers.push(defaultCwdChangeUnsub);
    unsubscribers.push(defaultModelChangeUnsub);
    service = new MakaioSessionService(MakaioBus, { machineId: MACHINE_ID });
    await service.init();
    const { unsubscribe } = registerMockAdapterIdentityHandlers(MACHINE_ID);
    unsubscribers.push(unsubscribe);
    /**
     * Publish a complete live identity that the same authority instance owns.
     * @param adapterName - Stable adapter driver name.
     * @param adapterId - Runtime adapter identity to announce.
     */
    announceLiveAdapter = async (adapterName, adapterId = buildDeterministicAdapterId(MACHINE_ID, adapterName)) => {
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterName,
        adapterId,
        machineId: MACHINE_ID,
        ownerInstanceId: service.requireOwnershipInstanceId(),
        capabilities: [],
      });
    };
    await announceLiveAdapter('test-adapter');
    bridge = new SessionBridge(MakaioBus);
  });

  afterEach(() => {
    orchestrator?.destroy();
    bridge?.destroy();
    service?.destroy();
    unsubscribers.forEach((unsub) => unsub());
  });

  /**
   * Create the empty session an auto-attach test starts its first agent into.
   *
   * Goes through `session.create` rather than writing the row directly, so the
   * fixture is the same durable state production reaches — which is what the
   * reservation verifies the `(agent, session)` pair against.
   * @param sessionId - Session to create.
   */
  async function seedEmptySession(sessionId: string): Promise<void> {
    await MakaioBus.request(SessionSubjects.create, { sessionId });
  }

  /**
   * Read the agent rows a session ended up with.
   * @param sessionId - Session to read.
   * @returns The stored agent rows, in storage order.
   */
  async function readStoredAgents(sessionId: string): Promise<readonly MakaioSessionAgent[]> {
    const stored = await MakaioBus.request(AgentStorageSubjects.listBySession, { sessionId });
    return stored.agents;
  }

  /**
   * Report a stored agent as live, so the liveness check does not open a
   * recovery the test is not about.
   *
   * Answers from the same agent rows the start wrote, rather than from a
   * fixture map: an agent the auto-attach flow did not persist must not be
   * reported alive here either.
   * @returns Unsubscribe function.
   */
  function registerStoredAgentLivenessHandler(): UnsubscribeFunction {
    return MakaioBus.on(AdapterSubjects.getAgent, async (ctx) => {
      const stored = await MakaioBus.request(AgentStorageSubjects.get, { agentId: ctx.payload.agentId });
      const agent = stored.agent;
      ctx.setResult({
        agent:
          agent === null
            ? null
            : { agentId: agent.agentId, sessionId: agent.sessionId, adapterSessionId: agent.adapterSessionId ?? '' },
      });
    });
  }

  describe('should create session when sendMessage called with new sessionId', () => {
    it('creates a new session and returns the provided sessionId', async () => {
      // Setup: register handlers for auto-attach flow
      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);

      // Execute
      const sessionId = `session-${crypto.randomUUID().slice(0, 8)}`;
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello, world!',
      });

      // Assert
      expect(result.sessionId).toBe(sessionId);
      expect(result.messageId).toBeDefined();
      expect(result.turnId).toBeDefined();
    });
  });

  describe('should auto-attach agent when session has no agents', () => {
    it('registers attachResolved with the framework orchestrator lifecycle', async () => {
      const sessionId = 'session-attach-resolved';
      await seedEmptySession(sessionId);

      let receivedPayload: { adapterId: string; sessionId: string } | undefined;
      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('my-adapter');

      const result = await MakaioBus.requestOptional(SessionSubjects.agent.attachResolved, {
        sessionId,
        role: 'lead',
        agent: { kind: 'adapter', adapterName: 'my-adapter' },
      });

      expect(result).toEqual({
        handled: true,
        data: expect.objectContaining({
          role: 'lead',
          adapterSessionId: `adapter-session-${sessionId}`,
        }),
      });
      expect(receivedPayload).toEqual({
        adapterId: buildDeterministicAdapterId(MACHINE_ID, 'my-adapter'),
        sessionId,
      });
    });

    it('calls adapter.startAgent when session exists but has no agents', async () => {
      // Setup: session with no agents
      const sessionId = 'session-empty';
      await seedEmptySession(sessionId);

      let startAgentCalled = false;
      let receivedPayload: { adapterId: string; sessionId: string } | undefined;

      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          startAgentCalled = true;
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('my-adapter');

      // Execute
      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'my-adapter' },
        message: 'Hello!',
      });

      // Assert
      expect(startAgentCalled).toBe(true);
      expect(receivedPayload).toEqual({
        adapterId: buildDeterministicAdapterId(MACHINE_ID, 'my-adapter'),
        sessionId,
      });
    });

    it.each([
      {
        name: 'direct adapter selection',
        agent: { kind: 'adapter', adapterName: 'test-adapter', providerConfigId: 'provider-config-1' } as const,
        providerConfigId: 'provider-config-1',
        definitionId: 'provider-def-1',
      },
      {
        name: 'canonical-model resolution',
        agent: { kind: 'canonical-model', model: 'test-adapter::requested-model' } as const,
        providerConfigId: 'provider-config-canonical',
        definitionId: 'provider-def-canonical',
        resolvedModel: 'resolved-model',
      },
    ])('resolves and forwards providerContext for $name', async ({
      agent,
      providerConfigId,
      definitionId,
      resolvedModel,
    }) => {
      const sessionId = `session-provider-context-${providerConfigId}`;
      await seedEmptySession(sessionId);

      const order: string[] = [];
      let credentialActivated = false;
      let receivedPayload: Record<string, unknown> | undefined;
      let startedAgentId: string | undefined;
      if (resolvedModel !== undefined) {
        unsubscribers.push(
          MakaioBus.on(CanonicalModelSubjects.resolve, (ctx) => {
            ctx.setResult({
              kind: 'adapter',
              adapterName: 'test-adapter',
              providerConfigId,
              model: resolvedModel,
            });
          }),
        );
      }
      unsubscribers.push(
        MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
          expect(ctx.payload.providerConfigId).toBe(providerConfigId);
          const providerContext = makeProviderContext(providerConfigId, definitionId);
          ctx.setResult(makeAdapterRuntimeResolution(providerContext, ctx.payload.adapterName));
        }),
      );
      unsubscribers.push(
        MakaioBus.on(CredentialSubjects.activate, (ctx) => {
          credentialActivated = true;
          ctx.setResult({ success: true });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
          order.push('start');
          receivedPayload = ctx.payload as Record<string, unknown>;
          // A caller-supplied identity is the adapter's, exactly as production:
          // the reserving start persisted that row before dispatching.
          const agentId = ctx.payload.agentId ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
          startedAgentId = agentId;
          const adapterSessionId = `adapter-session-${sessionId}`;
          const adapterId = ctx.payload.adapterId;
          if (adapterId === null || adapterId === undefined) throw new Error('Expected resolved adapter id.');
          ctx.setResult({
            success: true as const,
            agentId,
            adapterId,
            adapterSessionId,
            sessionId,
            ownerInstanceId: ctx.payload.ownerInstanceId ?? 'auto-attach-owner',
            settlementAckToken: `auto-attach-ack-${agentId}`,
          });
          emitAgentAdded({ sessionId, agentId, adapterId, adapterSessionId });
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent,
        message: 'Hello!',
      });

      expect(order).toEqual(['start']);
      expect(credentialActivated).toBe(false);
      expect(receivedPayload).toMatchObject({
        ...(resolvedModel !== undefined && { model: resolvedModel }),
        providerContext: {
          providerConfigId,
          definitionId,
        },
      });
      // Asserted on the durable row rather than on a captured `updateRuntime`
      // payload: the runtime write is what the resolution is *for*, and the row
      // is the only place a caller ever reads it back from.
      const storedAgents = await readStoredAgents(sessionId);
      expect(storedAgents).toHaveLength(1);
      expect(storedAgents[0]).toMatchObject({ agentId: startedAgentId, providerConfigId });
    });

    it('does not trust loose providerContext fields on public sendMessage', async () => {
      const sessionId = 'session-provider-context-direct';
      const providerContext = {
        providerConfigId: 'provider-config-direct',
        definitionId: 'provider-def-direct',
        endpointOverrides: { anthropic: 'https://provider.example/chat' },
        credentialRefs: { apiKey: buildStoredCredentialRef('provider-config-direct', 'apiKey') },
      };
      await seedEmptySession(sessionId);

      let receivedPayload: Record<string, unknown> | undefined;
      let runtimeContextResolved = false;
      let credentialActivated = false;
      let startedAgentId: string | undefined;

      unsubscribers.push(
        MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
          runtimeContextResolved = true;
          const resolved = makeProviderContext(ctx.payload.providerConfigId, 'unexpected-provider-def');
          ctx.setResult(makeAdapterRuntimeResolution(resolved, ctx.payload.adapterName));
        }),
      );
      unsubscribers.push(
        MakaioBus.on(CredentialSubjects.activate, (ctx) => {
          credentialActivated = true;
          ctx.setResult({ success: true });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
          receivedPayload = ctx.payload as Record<string, unknown>;
          // A caller-supplied identity is the adapter's, exactly as production:
          // the reserving start persisted that row before dispatching.
          const agentId = ctx.payload.agentId ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
          startedAgentId = agentId;
          const adapterSessionId = `adapter-session-${sessionId}`;
          const adapterId = ctx.payload.adapterId;
          if (adapterId === null || adapterId === undefined) throw new Error('Expected resolved adapter id.');
          ctx.setResult({
            success: true as const,
            agentId,
            adapterId,
            adapterSessionId,
            sessionId,
            ownerInstanceId: ctx.payload.ownerInstanceId ?? 'auto-attach-owner',
            settlementAckToken: `auto-attach-ack-${agentId}`,
          });
          emitAgentAdded({ sessionId, agentId, adapterId, adapterSessionId });
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter', providerContext },
        message: 'Hello!',
      });

      expect(runtimeContextResolved).toBe(false);
      expect(credentialActivated).toBe(false);
      expect(receivedPayload).not.toHaveProperty('providerContext');
      expect(startedAgentId).toBeDefined();
      // The origin identity is persisted for every start; what an untrusted
      // provider context must not produce is a provider-config write. Both are
      // read off the durable row, so the assertion covers the write's effect
      // rather than the shape of one intercepted payload.
      const storedAgents = await readStoredAgents(sessionId);
      expect(storedAgents).toHaveLength(1);
      expect(storedAgents[0]?.adapterSessionId).toBe(`adapter-session-${sessionId}`);
      expect(storedAgents[0]?.providerConfigId).toBeUndefined();
    });

    it('backfills adapterName from adapterId when the direct selection omits adapterName', async () => {
      const sessionId = 'session-id-only';
      const adapterId = buildDeterministicAdapterId(MACHINE_ID, 'resolved-adapter-name');
      await seedEmptySession(sessionId);

      let startAgentCalled = false;
      let receivedPayload: { adapterId: string; sessionId: string } | undefined;
      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          startAgentCalled = true;
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('resolved-adapter-name', adapterId);

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        // The machine travels with the instance: an instance ID is a one-way hash
        // of `(machineId, adapterName)`, so naming one without the other leaves
        // every ownership act of the start without a namespace.
        agent: { kind: 'adapter', adapterId, machineId: MACHINE_ID },
        message: 'Hello!',
      });

      expect(startAgentCalled).toBe(true);
      expect(receivedPayload).toEqual({
        adapterId,
        sessionId,
      });
    });

    it('rejects when explicit adapterName does not match the name stored for adapterId', async () => {
      const sessionId = 'session-name-id-mismatch';
      await seedEmptySession(sessionId);

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('bar', 'machine-1:bar');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId,
          agent: { kind: 'adapter', adapterName: 'foo', adapterId: 'machine-1:bar', machineId: MACHINE_ID },
          message: 'Hello!',
        }),
      ).rejects.toThrow(/adapterName "foo" does not match adapterId "machine-1:bar"/);
    });
  });

  describe('should require agent selection when auto-attaching', () => {
    it('throws error when agent selection is missing for session with no agents', async () => {
      // Setup: session with no agents
      const sessionId = 'session-no-adapter';
      await seedEmptySession(sessionId);

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);

      // Execute & Assert — framework orchestrator requires an explicit initial agent selection.
      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId,
          message: 'Hello!',
          // No agent selection provided
        }),
      ).rejects.toThrow(/agent selection required/);
    });

    it('throws error when agent selection is missing for new session', async () => {
      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);

      // Execute & Assert — framework orchestrator requires an explicit initial agent selection.
      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId: `session-${crypto.randomUUID().slice(0, 8)}`,
          message: 'Hello!',
          // No agent selection
        }),
      ).rejects.toThrow(/agent selection required/);
    });
  });

  describe('should emit turn.started for auto-attach flow', () => {
    it('emits turn.started event with correct agentIds', async () => {
      const sessionId = 'session-turn-started';
      await seedEmptySession(sessionId);

      unsubscribers.push(registerStartAgentHandler());

      const turnStarted = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      await waitForAsync();

      // Assert
      expect(turnStarted.received).toHaveLength(1);
      expect(turnStarted.received[0]).toMatchObject({
        sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
      });
      expect(turnStarted.received[0].agentIds).toHaveLength(1);
    });
  });

  describe('should emit user_message.sent for auto-attach flow', () => {
    it('emits user_message.sent event with message content', async () => {
      const sessionId = 'session-msg-sent';
      await seedEmptySession(sessionId);

      unsubscribers.push(registerStartAgentHandler());

      const messageSent = collectUserMessageSentEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      const testMessage = 'Test message content';

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: testMessage,
      });

      await waitForAsync();

      // Assert
      expect(messageSent.received).toHaveLength(1);
      expect(messageSent.received[0]).toMatchObject({
        sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
        content: testMessage,
      });
      expect(messageSent.received[0].agentIds).toHaveLength(1);
    });
  });

  describe('should emit user_message.acknowledged for auto-attach flow', () => {
    it('emits user_message.acknowledged event after agent receives message', async () => {
      const sessionId = 'session-msg-ack';
      await seedEmptySession(sessionId);

      unsubscribers.push(registerStartAgentHandler());
      unsubscribers.push(registerSendMessageHandler());

      const messageAck = collectUserMessageAcknowledgedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      await waitForAsync();

      // Assert
      expect(messageAck.received).toHaveLength(1);
      expect(messageAck.received[0]).toMatchObject({
        sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
      });
      expect(messageAck.received[0].agentId).toBeDefined();
    });
  });

  describe('should return sessionId, messageId, turnId', () => {
    it('returns all three IDs for auto-attach flow', async () => {
      const sessionId = 'session-return-ids';
      await seedEmptySession(sessionId);

      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      // Assert
      expect(result.sessionId).toBe(sessionId);
      expect(result.messageId).toBeDefined();
      expect(result.messageId).toBeTruthy();
      expect(result.turnId).toBeDefined();
      expect(result.turnId).toBeTruthy();
    });

    it('returns provided sessionId for new session', async () => {
      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      // Execute
      const sessionId = `session-${crypto.randomUUID().slice(0, 8)}`;
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      // Assert
      expect(result.sessionId).toBe(sessionId);
      expect(result.messageId).toBeDefined();
      expect(result.turnId).toBeDefined();
    });

    it('passes runtime options to adapter.startAgent', async () => {
      const sessionId = 'session-runtime-opts';
      await seedEmptySession(sessionId);

      let receivedPayload: Record<string, unknown> | undefined;

      // Override the default startAgent handler to capture the full payload
      unsubscribers.push(
        MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
          receivedPayload = ctx.payload as Record<string, unknown>;
          const agentId = ctx.payload.agentId;
          const ownerInstanceId = ctx.payload.ownerInstanceId;
          if (agentId === undefined || ownerInstanceId === undefined) {
            throw new Error('Expected a caller-owned start identity.');
          }
          const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;
          const adapterSessionId = `adapter-session-${sessionId}`;
          ctx.setResult({
            success: true as const,
            agentId,
            adapterId: ctx.payload.adapterId,
            adapterSessionId,
            sessionId,
            messageId,
            ownerInstanceId,
            settlementAckToken: `auto-attach-ack-${agentId}`,
          });

          // Emit agent.added event (mimics AIAdapter behavior)
          emitAgentAdded({ sessionId, agentId, adapterId: ctx.payload.adapterId, adapterSessionId });
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      // Execute
      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName: 'test-adapter',
          model: 'claude-3-opus',
          cwd: '/home/user/project',
        },
        message: 'Hello!',
      });

      // Assert - runtime options should be passed to startAgent
      expect(receivedPayload).toBeDefined();
      expect(receivedPayload?.model).toBe('claude-3-opus');
      expect(receivedPayload?.cwd).toBe('/home/user/project');
    });

    it('does not run redundant model/cwd mutations after initial auto-attach', async () => {
      const sessionId = 'session-runtime-no-redundant-mutations';
      await seedEmptySession(sessionId);
      unsubscribers.push(registerStoredAgentLivenessHandler());

      // Remove default handlers to count exactly how many mutation RPCs are attempted.
      defaultCwdChangeUnsub?.();
      defaultModelChangeUnsub?.();

      let modelChangeCalls = 0;
      let cwdChangeCalls = 0;
      unsubscribers.push(
        MakaioBus.on(AgentSubjects.model.change, (ctx) => {
          modelChangeCalls += 1;
          ctx.setResult({ success: true, swapped: false });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(AgentSubjects.cwd.change, (ctx) => {
          cwdChangeCalls += 1;
          ctx.setResult({ success: true, previousCwd: '/previous/cwd' });
        }),
      );
      unsubscribers.push(registerStartAgentHandler());
      unsubscribers.push(registerSendMessageHandler());

      orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
      await announceLiveAdapter('test-adapter');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName: 'test-adapter',
          model: 'claude-3-opus',
          cwd: '/home/user/project',
        },
        message: 'Hello!',
      });

      expect(modelChangeCalls).toBe(0);
      expect(cwdChangeCalls).toBe(0);
    });
  });
});
