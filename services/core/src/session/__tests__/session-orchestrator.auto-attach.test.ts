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
import type { IMakaioSession } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../adapter-runtime/index.js';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import { SessionBridge } from '../session-bridge.js';
import type { AdapterRuntimeSnapshotResolution, ProviderRuntimeSnapshot } from '../../adapter-subsystem/schemas.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import {
  createMockSession,
  resetBusHandlers,
  waitForAsync,
  registerCreateSessionHandler,
  registerGetSessionHandler,
  registerGetAgentHandler,
  registerAgentAddedHandler,
  registerStartAgentHandler,
  registerSendMessageHandler,
  registerRehydrateAgentHandler,
  registerCwdChangeHandler,
  registerModelChangeHandler,
  emitAgentAdded,
  emitAdapterInitialized,
  collectTurnStartedEvents,
  collectUserMessageSentEvents,
  collectUserMessageAcknowledgedEvents,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';

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
  let unsubscribers: UnsubscribeFunction[];
  let sessions: Map<string, IMakaioSession>;
  let defaultCwdChangeUnsub: UnsubscribeFunction | undefined;
  let defaultModelChangeUnsub: UnsubscribeFunction | undefined;

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    sessions = new Map();

    // Register default handlers
    unsubscribers.push(registerCreateSessionHandler(sessions));
    unsubscribers.push(registerGetSessionHandler(sessions));
    unsubscribers.push(registerAgentAddedHandler(sessions));
    unsubscribers.push(registerRehydrateAgentHandler());
    defaultCwdChangeUnsub = registerCwdChangeHandler();
    defaultModelChangeUnsub = registerModelChangeHandler();
    unsubscribers.push(defaultCwdChangeUnsub);
    unsubscribers.push(defaultModelChangeUnsub);
    unsubscribers.push(registerMockStorageHandlers());
    bridge = new SessionBridge(MakaioBus);
  });

  afterEach(() => {
    orchestrator?.destroy();
    bridge?.destroy();
    unsubscribers.forEach((unsub) => unsub());
  });

  describe('should create session when sendMessage called with new sessionId', () => {
    it('creates a new session and returns the provided sessionId', async () => {
      // Setup: register handlers for auto-attach flow
      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      let receivedPayload: { adapterId: string; sessionId: string } | undefined;
      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('my-adapter');

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
        adapterId: buildDeterministicAdapterId('test-machine', 'my-adapter'),
        sessionId,
      });
    });

    it('calls adapter.startAgent when session exists but has no agents', async () => {
      // Setup: session with no agents
      const sessionId = 'session-empty';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      let startAgentCalled = false;
      let receivedPayload: { adapterId: string; sessionId: string } | undefined;

      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          startAgentCalled = true;
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('my-adapter');

      // Execute
      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'my-adapter' },
        message: 'Hello!',
      });

      // Assert
      expect(startAgentCalled).toBe(true);
      expect(receivedPayload).toEqual({
        adapterId: buildDeterministicAdapterId('test-machine', 'my-adapter'),
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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      const order: string[] = [];
      let credentialActivated = false;
      const runtimeUpdates: Array<{ agentId: string; providerConfigId?: string }> = [];
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
          const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
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
          });
          emitAgentAdded({ sessionId, agentId, adapterId, adapterSessionId });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
          runtimeUpdates.push({
            agentId: ctx.payload.agentId,
            providerConfigId: ctx.payload.providerConfigId ?? undefined,
          });
          ctx.setResult({ success: true });
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
      expect(sessions.get(sessionId)?.agents[0]?.providerConfigId).toBe(providerConfigId);
      expect(runtimeUpdates).toEqual([{ agentId: startedAgentId, providerConfigId }]);
    });

    it('does not trust loose providerContext fields on public sendMessage', async () => {
      const sessionId = 'session-provider-context-direct';
      const providerContext = {
        providerConfigId: 'provider-config-direct',
        definitionId: 'provider-def-direct',
        endpointOverrides: { anthropic: 'https://provider.example/chat' },
        credentialRefs: { apiKey: buildStoredCredentialRef('provider-config-direct', 'apiKey') },
      };
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      const runtimeUpdates: Array<{ agentId: string; providerConfigId?: string }> = [];
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
          const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
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
          });
          emitAgentAdded({ sessionId, agentId, adapterId, adapterSessionId });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
          runtimeUpdates.push({
            agentId: ctx.payload.agentId,
            providerConfigId: ctx.payload.providerConfigId ?? undefined,
          });
          ctx.setResult({ success: true });
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter', providerContext },
        message: 'Hello!',
      });

      expect(runtimeContextResolved).toBe(false);
      expect(credentialActivated).toBe(false);
      expect(receivedPayload).not.toHaveProperty('providerContext');
      expect(sessions.get(sessionId)?.agents[0]?.providerConfigId).toBeUndefined();
      expect(startedAgentId).toBeDefined();
      expect(runtimeUpdates).toEqual([]);
    });

    it('backfills adapterName from adapterId when the direct selection omits adapterName', async () => {
      const sessionId = 'session-id-only';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      let startAgentCalled = false;
      let receivedPayload: { adapterId: string; sessionId: string } | undefined;
      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          startAgentCalled = true;
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('resolved-adapter-name', 'machine-1:resolved-adapter-name');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterId: 'machine-1:resolved-adapter-name' },
        message: 'Hello!',
      });

      expect(startAgentCalled).toBe(true);
      expect(receivedPayload).toEqual({
        adapterId: 'machine-1:resolved-adapter-name',
        sessionId,
      });
    });

    it('rejects when explicit adapterName does not match the name stored for adapterId', async () => {
      const sessionId = 'session-name-id-mismatch';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('bar', 'machine-1:bar');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId,
          agent: { kind: 'adapter', adapterName: 'foo', adapterId: 'machine-1:bar' },
          message: 'Hello!',
        }),
      ).rejects.toThrow(/adapterName "foo" does not match adapterId "machine-1:bar"/);
    });
  });

  describe('should require agent selection when auto-attaching', () => {
    it('throws error when agent selection is missing for session with no agents', async () => {
      // Setup: session with no agents
      const sessionId = 'session-no-adapter';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

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
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());

      const turnStarted = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());

      const messageSent = collectUserMessageSentEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());
      unsubscribers.push(registerSendMessageHandler());

      const messageAck = collectUserMessageAcknowledgedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      let receivedPayload: Record<string, unknown> | undefined;

      // Override the default startAgent handler to capture the full payload
      unsubscribers.push(
        MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
          receivedPayload = ctx.payload as Record<string, unknown>;
          const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
          const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;
          const adapterSessionId = `adapter-session-${sessionId}`;
          ctx.setResult({
            success: true as const,
            agentId,
            adapterId: ctx.payload.adapterId,
            adapterSessionId,
            sessionId,
            messageId,
          });

          // Emit agent.added event (mimics AIAdapter behavior)
          emitAgentAdded({ sessionId, agentId, adapterId: ctx.payload.adapterId, adapterSessionId });
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));
      unsubscribers.push(registerGetAgentHandler(sessions));

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

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

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
