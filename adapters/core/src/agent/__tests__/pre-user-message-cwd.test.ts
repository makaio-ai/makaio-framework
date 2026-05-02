import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import { AgentSubjects } from '@makaio/contracts';
import { registerPreUserMessageHook, resetPreUserMessageHooks } from '@makaio/hooks';
import { AIAgent } from '../ai-agent.js';
import { AIAgentConnector } from '../../connector/agent-connector.js';
import { MessageHandle } from '../../message-handle/index.js';
import type { AIAgentConfig, AgentStartResult, BaseAgentConnectorConfig } from '../types.js';
import type { NormalizedMessageInput } from '../../utils/normalizeMessageInput.js';

type TestBus = ReturnType<typeof createMockScopedBus>['bus'];

class HookTestConnector extends AIAgentConnector {
  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) {
    super(config);
  }

  public async initialize(): Promise<void> {}

  public async start(message: NormalizedMessageInput): Promise<AgentStartResult> {
    return {
      adapterSessionId: 'session-from-start',
      agentId: this.getAgentId(),
      messageHandle: new MessageHandle('start-message', message, 'enqueue'),
    };
  }

  public async sendMessage(message: NormalizedMessageInput): Promise<MessageHandle> {
    return new MessageHandle('send-message', message, 'enqueue');
  }

  public abort(): void {}
  public async complete(): Promise<null> {
    return null;
  }
  public async interrupt(): Promise<void> {}
  public async close(): Promise<void> {}
  public async getAdapterSessionId(): Promise<string> {
    return 'session-from-connector';
  }
}

class HookTestAgent extends AIAgent<TestBus, HookTestConnector> {
  protected async wireEvents(_connector: HookTestConnector): Promise<void> {}

  public async emitUsageForTest(): Promise<void> {
    await this.trackUsage({
      provider: 'test-provider',
      inputTokens: 1,
      inputCachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
      costUnits: 2,
      costUnitType: 'tokens',
    });
  }
}

function createHookTestAgent(): HookTestAgent {
  const { bus: mockBus } = createMockScopedBus();

  const config: AIAgentConfig<TestBus, HookTestConnector> = {
    agentId: 'hook-test-agent',
    adapterId: 'hook-test-adapter',
    adapterName: 'hook-test',
    capabilities: [],
    nativeTools: [],
    adapterBus: mockBus,
    globalBus: MakaioBus,
    model: 'model-1',
    cwd: os.tmpdir(),
    configFactory: async (input) => ({
      bus: mockBus,
      agentId: input.agentId ?? 'hook-test-agent',
      adapterId: input.adapterId ?? 'hook-test-adapter',
      adapterName: 'hook-test',
      model: input.model ?? 'model-1',
      cwd: input.cwd ?? os.tmpdir(),
    }),
    connectorFactory: async (factoryConfig) => new HookTestConnector(factoryConfig),
  };

  return new HookTestAgent(config);
}

describe('AIAgent pre-user hook payload', () => {
  let agent: HookTestAgent;
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    resetPreUserMessageHooks();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    if (agent) {
      await agent.close();
    }
    resetPreUserMessageHooks();
  });

  it('includes connector cwd in hook payload for start and sendMessage flows', async () => {
    const seenCwds: Array<string | undefined> = [];
    cleanupFns.push(
      registerPreUserMessageHook(
        'capture-cwd',
        async (ctx) => {
          seenCwds.push(ctx.payload.cwd);
          await ctx.next();
        },
        {},
      ),
    );

    agent = createHookTestAgent();

    await agent.start('hello from start');

    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      message: 'hello from send',
    });

    expect(seenCwds).toEqual([os.tmpdir(), os.tmpdir()]);
  });

  it('keeps turnId available for usage emitted after sendMessage acknowledgement', async () => {
    const usagePayloads: unknown[] = [];
    cleanupFns.push(
      MakaioBus.on(AgentSubjects.usage, (ctx) => {
        usagePayloads.push(ctx.payload);
      }),
    );

    agent = createHookTestAgent();
    await agent.initialize();

    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      message: 'hello from send',
      turnId: 'turn-1',
    });
    await agent.emitUsageForTest();

    expect(usagePayloads).toEqual([
      expect.objectContaining({
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        turnId: 'turn-1',
      }),
    ]);
  });
});
