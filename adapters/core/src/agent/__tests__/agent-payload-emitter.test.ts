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
      getAdapterSessionId: async () => 'adapter-session-1',
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
      getAdapterSessionId: async () => 'adapter-session-1',
      getEventMetadataDefaults: () => ({
        clientId: 'live-client',
        providerConfigId: 'live-provider-config',
        occurredAt: 1_744_123_456_789,
      }),
    });

    await emitter.emitGlobal(AgentSubjects.usage, {
      provider: 'anthropic',
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
      getAdapterSessionId: async () => 'adapter-session-1',
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

  it('captures analytics metadata defaults before waiting for adapter session resolution', async () => {
    const emittedPayloads: unknown[] = [];
    let occurredAt = 1_744_123_456_789;
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
      getAdapterSessionId: async () => {
        occurredAt = 1_744_123_499_999;
        return 'adapter-session-1';
      },
      getEventMetadataDefaults: () => ({
        clientId: 'client-1',
        providerConfigId: 'provider-config-1',
        occurredAt,
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
        adapterSessionId: 'adapter-session-1',
        messageId: 'current-message-id',
        clientId: 'client-1',
        providerConfigId: 'provider-config-1',
        occurredAt: 1_744_123_456_789,
      },
    ]);
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
      getBlockIndex: () => 0,
      incrementBlockIndex: () => {},
      getUsageModel: () => 'test-model',
    });

    await bridge.emitToolOutput('output', { toolName: 'test-tool' });

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
          output: 'output',
          toolCallId: expect.any(String),
          toolName: 'test-tool',
        },
        options: undefined,
      },
    ]);
  });
});
