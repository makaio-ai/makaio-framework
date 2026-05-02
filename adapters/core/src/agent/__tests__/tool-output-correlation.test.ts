import { beforeEach, describe, expect, it } from 'vitest';
import { createMockGlobalBus, createMockScopedBus } from '@makaio/test-utils';
import { AIAgent } from '../ai-agent.js';
import { AgentSubjects, AdapterSubjects } from '@makaio/contracts';
import type { ResolveHints } from '../tool-call-tracker.js';
import type { AIAgentConfig } from '../types.js';
import type { IMakaioBus } from '@makaio/bus-core';

class TestAgent extends AIAgent {
  public constructor(private readonly mockGlobalBusInstance: IMakaioBus) {
    const { bus: mockBus } = createMockScopedBus();
    const config: AIAgentConfig = {
      agentId: 'test-agent',
      adapterId: 'test-adapter',
      adapterName: 'test',
      capabilities: [],
      nativeTools: [],
      adapterBus: mockBus,
      globalBus: mockGlobalBusInstance,
      configFactory: async () => ({
        bus: mockBus,
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

  public registerPending(toolName: string, nativeId?: string): string {
    return this.toolCallTracker.register(toolName, undefined, nativeId);
  }

  public async emitOutput(
    output: string,
    hints: ResolveHints,
  ): Promise<{ toolCallId: string; toolName: string; args?: Record<string, unknown> }> {
    return this.emitToolOutput(output, hints);
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
    const result = await agent.emitOutput('output', { toolName: 'Read' });

    const emitCalls = mockGlobalBusResult.emit.mock.calls;
    const logCall = emitCalls.find(([subject]) => subject === AdapterSubjects.log);
    const outputCall = emitCalls.find(([subject]) => subject === AgentSubjects.tool.output);

    expect(logCall).toBeDefined();
    expect(logCall?.[1]).toMatchObject({ level: 'warn' });
    expect(outputCall).toBeDefined();
    expect(outputCall?.[1]).toMatchObject({ output: 'output', toolCallId: result.toolCallId });
    expect(result.toolName).toBe('Read');
  });

  it('logs warning when fallback to oldest pending tool call', async () => {
    const first = agent.registerPending('Bash', 'toolu-1');
    agent.registerPending('Read', 'toolu-2');

    const result = await agent.emitOutput('output', {});

    expect(result.toolCallId).toBe(first);

    const emitCalls = mockGlobalBusResult.emit.mock.calls;
    const logCall = emitCalls.find(([subject]) => subject === AdapterSubjects.log);
    const outputCall = emitCalls.find(([subject]) => subject === AgentSubjects.tool.output);

    expect(logCall?.[1]).toMatchObject({ level: 'warn' });
    expect(outputCall?.[1]).toMatchObject({ toolCallId: first });
  });

  it('does not log warning when nativeId matches', async () => {
    agent.registerPending('Bash', 'toolu-1');

    const result = await agent.emitOutput('output', { nativeId: 'toolu-1' });

    expect(result.toolCallId).toBe('toolu-1');
    expect(result.toolName).toBe('Bash');

    const emitCalls = mockGlobalBusResult.emit.mock.calls;
    const logCall = emitCalls.find(([subject]) => subject === AdapterSubjects.log);
    const outputCall = emitCalls.find(([subject]) => subject === AgentSubjects.tool.output);

    expect(logCall).toBeUndefined();
    expect(outputCall?.[1]).toMatchObject({ toolCallId: 'toolu-1' });
  });
});
