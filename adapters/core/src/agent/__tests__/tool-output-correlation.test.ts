import { beforeEach, describe, expect, it } from 'vitest';
import { createMockGlobalBus, createMockScopedBus, createTestCall } from '@makaio/test-utils';
import { AIAgent } from '../ai-agent.js';
import { AgentSubjects, AdapterSubjects } from '@makaio/contracts';
import type { CallContext } from '@makaio/contracts';
import type { ResolveHints } from '../tool-call-tracker.js';
import type { AIAgentConfig } from '../types.js';
import type { IMakaioBus } from '@makaio/bus-core';
import { AgentTeardownArbiter } from '../agent-teardown-arbiter.js';

class TestAgent extends AIAgent {
  public constructor(private readonly mockGlobalBusInstance: IMakaioBus) {
    const { bus: mockBus } = createMockScopedBus();
    const config: AIAgentConfig = {
      agentId: 'test-agent',
      adapterId: 'test-adapter',
      adapterName: 'test',
      machineId: 'test-machine',
      ownerInstanceId: 'test-owner-instance',
      capabilities: [],
      nativeTools: [],
      adapterBus: mockBus,
      teardownArbiter: new AgentTeardownArbiter(),
      globalBus: mockGlobalBusInstance,
      configFactory: async () => ({
        bus: mockBus,
        globalBus: mockGlobalBusInstance,
        agentId: 'test-agent',
        adapterId: 'test-adapter',
        adapterName: 'test',
        model: 'test-model',
        cwd: '/tmp',
      }),
      connectorFactory: () => ({}) as ReturnType<AIAgentConfig['connectorFactory']>,
    };
    super(config);
  }

  public registerPending(messageId: string, toolName: string, nativeId?: string): string {
    return this.toolCallTracker.register(messageId, toolName, undefined, nativeId);
  }

  public clearMessageToolCalls(messageId: string): void {
    this.toolCallTracker.clearMessage(messageId);
  }

  public async emitOutput(
    call: CallContext,
    messageId: string,
    output: string,
    hints: ResolveHints,
  ): Promise<{ toolCallId: string; toolName: string; args?: Record<string, unknown> }> {
    return this.emitToolOutput(call, messageId, output, hints);
  }

  public override async getAdapterSessionId(): Promise<string> {
    return 'adapter-session';
  }

  protected wireEvents(): void {
    // No-op for testing
  }
}

describe('AIAgent.emitToolOutput', () => {
  let mockGlobalBusResult: ReturnType<typeof createMockGlobalBus>;
  let agent: TestAgent;

  beforeEach(() => {
    mockGlobalBusResult = createMockGlobalBus();
    agent = new TestAgent(mockGlobalBusResult.bus);
  });

  it('logs warning and generates fallback id when no pending tool calls', async () => {
    const call = createTestCall();
    const result = await agent.emitOutput(call, 'message-1', 'output', { toolName: 'Read' });

    const emitCalls = mockGlobalBusResult.emit.mock.calls;
    const logCall = emitCalls.find(([, subject]) => subject === AdapterSubjects.log);
    const outputCall = emitCalls.find(([, subject]) => subject === AgentSubjects.tool.output);

    expect(logCall).toBeDefined();
    expect(logCall?.[0]).toBe(call);
    expect(logCall?.[2]).toMatchObject({ level: 'warn' });
    expect(outputCall).toBeDefined();
    expect(outputCall?.[0]).toBe(call);
    expect(outputCall?.[2]).toMatchObject({ output: 'output', toolCallId: result.toolCallId });
    expect(result.toolName).toBe('Read');
  });

  it('logs warning when fallback to oldest pending tool call', async () => {
    const first = agent.registerPending('message-1', 'Bash', 'toolu-1');
    agent.registerPending('message-1', 'Read', 'toolu-2');

    const call = createTestCall();
    const result = await agent.emitOutput(call, 'message-1', 'output', {});

    expect(result.toolCallId).toBe(first);

    const emitCalls = mockGlobalBusResult.emit.mock.calls;
    const logCall = emitCalls.find(([, subject]) => subject === AdapterSubjects.log);
    const outputCall = emitCalls.find(([, subject]) => subject === AgentSubjects.tool.output);

    expect(logCall?.[0]).toBe(call);
    expect(logCall?.[2]).toMatchObject({ level: 'warn' });
    expect(outputCall?.[0]).toBe(call);
    expect(outputCall?.[2]).toMatchObject({ toolCallId: first });
  });

  it('does not log warning when nativeId matches', async () => {
    agent.registerPending('message-1', 'Bash', 'toolu-1');

    const call = createTestCall();
    const result = await agent.emitOutput(call, 'message-1', 'output', { nativeId: 'toolu-1' });

    expect(result.toolCallId).toBe('toolu-1');
    expect(result.toolName).toBe('Bash');

    const emitCalls = mockGlobalBusResult.emit.mock.calls;
    const logCall = emitCalls.find(([, subject]) => subject === AdapterSubjects.log);
    const outputCall = emitCalls.find(([, subject]) => subject === AgentSubjects.tool.output);

    expect(logCall).toBeUndefined();
    expect(outputCall?.[0]).toBe(call);
    expect(outputCall?.[2]).toMatchObject({ toolCallId: 'toolu-1' });
  });

  it('isolates same-named pending calls by their originating message', async () => {
    agent.registerPending('superseded-message', 'Bash', 'toolu-old');
    agent.registerPending('immediate-message', 'Bash', 'toolu-new');

    agent.clearMessageToolCalls('superseded-message');

    const call = createTestCall();
    const result = await agent.emitOutput(call, 'immediate-message', 'output', { toolName: 'Bash' });
    expect(result).toMatchObject({ toolCallId: 'toolu-new', toolName: 'Bash' });
  });
});
