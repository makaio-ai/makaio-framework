import { describe, expect, it } from 'vitest';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import { AgentPayloadEmitter } from '../agent-payload-emitter.js';
import { createAgentEventBridge } from '../agent-internal-factories.js';

describe('AgentPayloadEmitter', () => {
  it('prefers caller-provided messageId and emits runtime analytics defaults', async () => {
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'current-message-id',
      getCurrentTurnId: () => undefined,
      getConnectorAdapterSessionId: () => 'adapter-session-1',
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({
        clientId: 'client-1',
        providerConfigId: 'provider-config-1',
        occurredAt: 1_744_123_456_789,
      }),
    });

    await emitter.emitGlobal(AgentSubjects.message, {
      content: 'hello',
      messageId: 'payload-message-id',
    });

    expect(emittedPayloads).toEqual([
      {
        content: 'hello',
        messageId: 'payload-message-id',
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
        sessionId: 'session-1',
        clientId: 'client-1',
        providerConfigId: 'provider-config-1',
        occurredAt: 1_744_123_456_789,
      },
    ]);
  });

  it('invokes the recording sink even when no identity resolves', async () => {
    // Enrichment is the movement seam's only retry clock: recording
    // `undefined` re-drives a parked undelivered movement in the tracker,
    // and an agent that resolves no identity at all is exactly the one
    // whose unconfirmed movement is still outstanding.
    const recorded: Array<string | undefined> = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async () => {},
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'current-message-id',
      getCurrentTurnId: () => undefined,
      getConnectorAdapterSessionId: () => undefined,
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: (adapterSessionId) => {
        recorded.push(adapterSessionId);
      },
      getEventMetadataDefaults: () => ({}),
    });

    await emitter.emitGlobal(AgentSubjects.message, { content: 'hello', messageId: 'message-a' });

    expect(recorded).toEqual([undefined]);
  });

  it('prefers caller-provided turnId over live lifecycle state', async () => {
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'current-message-id',
      getCurrentTurnId: () => 'live-turn-id',
      getConnectorAdapterSessionId: () => 'adapter-session-1',
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({}),
    });

    await emitter.emitGlobal(AgentSubjects.turn.completed, {
      messageId: 'message-a',
      outcome: 'completed',
      turnId: 'captured-turn-id',
    });

    expect(emittedPayloads).toEqual([
      expect.objectContaining({
        messageId: 'message-a',
        outcome: 'completed',
        turnId: 'captured-turn-id',
      }),
    ]);
  });

  it('keeps a payload with explicit turnId: undefined turn-less instead of falling back to live state', async () => {
    // Key presence gates the fallback: user_message.sent for a no-turn
    // submission passes turnId: undefined and must not inherit the
    // still-executing turn's id from getCurrentTurnId().
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'current-message-id',
      getCurrentTurnId: () => 'live-turn-id',
      getConnectorAdapterSessionId: () => 'adapter-session-1',
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({}),
    });

    await emitter.emitGlobal(AgentSubjects.user_message.sent, {
      messageId: 'message-a',
      content: { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      deliveryMode: 'enqueue',
      turnId: undefined,
    });

    expect(emittedPayloads).toHaveLength(1);
    expect(emittedPayloads[0]).not.toHaveProperty('turnId');
  });

  it('preserves caller-provided analytics metadata over live defaults', async () => {
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'current-message-id',
      getCurrentTurnId: () => 'turn-1',
      getConnectorAdapterSessionId: () => 'adapter-session-1',
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({
        clientId: 'live-client',
        providerConfigId: 'live-provider-config',
        occurredAt: 1_744_123_456_789,
      }),
    });

    await emitter.emitGlobal(AgentSubjects.usage, {
      provider: 'anthropic',
      granularity: 'provider-call',
      model: 'claude-3-7-sonnet',
      inputTokens: 1,
      inputCachedTokens: 0,
      reasoningTokens: 0,
      outputTokens: 2,
      totalTokens: 3,
      costUnits: 3,
      costUnitType: 'tokens',
      clientId: 'imported-client',
      providerConfigId: 'imported-provider-config',
      occurredAt: 1_700_000_000_000,
    });

    expect(emittedPayloads).toEqual([
      {
        provider: 'anthropic',
        granularity: 'provider-call',
        model: 'claude-3-7-sonnet',
        inputTokens: 1,
        inputCachedTokens: 0,
        reasoningTokens: 0,
        outputTokens: 2,
        totalTokens: 3,
        costUnits: 3,
        costUnitType: 'tokens',
        clientId: 'imported-client',
        providerConfigId: 'imported-provider-config',
        occurredAt: 1_700_000_000_000,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
        messageId: 'current-message-id',
        turnId: 'turn-1',
        sessionId: 'session-1',
      },
    ]);
  });

  it('does not inject analytics metadata when a call site disables it', async () => {
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'current-message-id',
      getCurrentTurnId: () => 'turn-1',
      getConnectorAdapterSessionId: () => 'adapter-session-1',
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({
        clientId: 'live-client',
        providerConfigId: 'live-provider-config',
        occurredAt: 1_744_123_456_789,
      }),
    });

    await emitter.emitGlobal(
      AdapterSubjects.log,
      {
        level: 'info',
        message: 'adapter log',
        timestamp: 123,
      },
      { includeEventMetadata: false },
    );

    expect(emittedPayloads).toEqual([
      {
        level: 'info',
        message: 'adapter log',
        timestamp: 123,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
        messageId: 'current-message-id',
        turnId: 'turn-1',
        sessionId: 'session-1',
      },
    ]);
  });

  it('omits adapterSessionId when no confirmed source is available (unconfirmed fork)', async () => {
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
      }),
      getCurrentMessageId: () => 'current-message-id',
      getCurrentTurnId: () => undefined,
      getConnectorAdapterSessionId: () => undefined,
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({
        clientId: 'client-1',
        providerConfigId: 'provider-config-1',
        occurredAt: 1_744_123_456_789,
      }),
    });

    await emitter.emitGlobal(AgentSubjects.message, {
      content: 'hello',
    });

    expect(emittedPayloads).toEqual([
      {
        content: 'hello',
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        messageId: 'current-message-id',
        clientId: 'client-1',
        providerConfigId: 'provider-config-1',
        occurredAt: 1_744_123_456_789,
      },
    ]);
    // adapterSessionId must NOT be present
    expect(emittedPayloads[0]).not.toHaveProperty('adapterSessionId');
  });

  it('omits adapterSessionId when connector is unconfirmed and no lastKnown is cached', async () => {
    // Scenario: fresh fork child, no prior connector — both sources are empty.
    // The field must be omitted (not stamped with a placeholder).
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
      }),
      getCurrentMessageId: () => 'msg-1',
      getCurrentTurnId: () => undefined,
      getConnectorAdapterSessionId: () => undefined, // unconfirmed fork
      getLastKnownAdapterSessionId: () => undefined, // no prior cache
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({}),
    });

    await emitter.emitGlobal(AgentSubjects.message, { content: 'hello' });
    expect(emittedPayloads[0]).not.toHaveProperty('adapterSessionId');
  });

  it('stamps cached lastKnown adapterSessionId during swap gap (unconfirmed connector + confirmed cache)', async () => {
    // Scenario: connector swap just happened; the new connector is
    // fork-unconfirmed but the previous confirmed session ID was cached.
    // The cached ID is legitimate (written only from confirmed sources)
    // and must be stamped to maintain event continuity during the swap gap.
    const emittedPayloads: unknown[] = [];
    const storedIds: Array<string | undefined> = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'msg-1',
      getCurrentTurnId: () => undefined,
      getConnectorAdapterSessionId: () => undefined, // new connector not yet confirmed
      getLastKnownAdapterSessionId: () => 'previous-confirmed-session', // cached from old connector
      setLastKnownAdapterSessionId: (id) => {
        storedIds.push(id);
      },
      getEventMetadataDefaults: () => ({}),
    });

    await emitter.emitGlobal(AgentSubjects.message, { content: 'during-swap' });
    expect(emittedPayloads[0]).toHaveProperty('adapterSessionId', 'previous-confirmed-session');
    // The sink is told what the *connector* confirms, not what the cache still
    // reports: the cached ID may be one a movement already abandoned, and
    // feeding it back would re-assert currency (and an inherited resume target)
    // on that abandoned provider thread. Stamping still uses the cache.
    expect(storedIds).toEqual([undefined]);
  });

  it('stamps confirmed adapterSessionId after fork confirmation', async () => {
    const emittedPayloads: unknown[] = [];
    let confirmedId: string | undefined;
    const storedIds: Array<string | undefined> = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'msg-1',
      getCurrentTurnId: () => undefined,
      getConnectorAdapterSessionId: () => confirmedId,
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: (id) => {
        storedIds.push(id);
      },
      getEventMetadataDefaults: () => ({}),
    });

    // Pre-confirmation: no adapterSessionId
    await emitter.emitGlobal(AgentSubjects.message, { content: 'pre' });
    expect(emittedPayloads[0]).not.toHaveProperty('adapterSessionId');

    // Simulate system.init confirmation
    confirmedId = 'confirmed-child-session';
    await emitter.emitGlobal(AgentSubjects.message, { content: 'post' });
    expect(emittedPayloads[1]).toHaveProperty('adapterSessionId', 'confirmed-child-session');
    expect(storedIds).toContain('confirmed-child-session');
  });

  it('stamps locally-authoritative adapterSessionId immediately for non-fork agents', async () => {
    const emittedPayloads: unknown[] = [];
    const emitter = new AgentPayloadEmitter({
      globalBus: {
        emit: async (_subject: unknown, payload: unknown) => {
          emittedPayloads.push(payload);
        },
      } as never,
      getAgentContextBase: () => ({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
      }),
      getCurrentMessageId: () => 'msg-1',
      getCurrentTurnId: () => undefined,
      // Non-fork: getConfirmedAdapterSessionId returns the local ID immediately
      getConnectorAdapterSessionId: () => 'local-authoritative-id',
      getLastKnownAdapterSessionId: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      getEventMetadataDefaults: () => ({}),
    });

    await emitter.emitGlobal(AgentSubjects.message, { content: 'hello' });
    expect(emittedPayloads[0]).toHaveProperty('adapterSessionId', 'local-authoritative-id');
  });

  it('routes adapter logs through the emitter without requesting analytics metadata', async () => {
    const emitCalls: Array<{
      subject: unknown;
      payload: unknown;
      options?: { includeEventMetadata?: boolean };
    }> = [];
    const bridge = createAgentEventBridge({
      emitGlobal: async (subject, payload, options) => {
        emitCalls.push({ subject, payload, options });
      },
      toolCallTracker: {
        register: () => 'tool-call-id',
        resolve: () => ({ strategy: 'exact' }),
      } as never,
      lifecycleTracker: {
        getCurrentMessageHandle: () => undefined,
      } as never,
      getBlockIndex: () => 0,
      incrementBlockIndex: () => {},
      getUsageModel: () => 'test-model',
    });

    await bridge.emitToolOutput('message-1', 'output', { toolName: 'test-tool' });

    expect(emitCalls).toEqual([
      {
        subject: AdapterSubjects.log,
        payload: {
          level: 'warn',
          message: expect.stringContaining('Tool output arrived with no pending tool calls.'),
          timestamp: expect.any(Number),
        },
        options: { includeEventMetadata: false },
      },
      {
        subject: AgentSubjects.tool.output,
        payload: {
          messageId: 'message-1',
          output: 'output',
          toolCallId: expect.any(String),
          toolName: 'test-tool',
        },
        options: undefined,
      },
    ]);
  });
});
