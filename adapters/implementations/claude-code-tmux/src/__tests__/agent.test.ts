import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import type { ClientRuntimeObserveRequest } from '@makaio/contracts/client';
import { ClientSubjects } from '@makaio/contracts/client';
import { ClaudeCodeTmuxAgent } from '../agent.js';
import { ClaudeCodeTmuxConnector } from '../connector.js';
import { ClaudeCodeTmuxConnectorNamespace, ClaudeCodeTmuxConnectorSubjects } from '../namespace/index.js';
import type { ClaudeCodeTmuxAgentConfig } from '../types.js';

const TEST_AGENT_ID = 'agent-tmux-test';
const TEST_ADAPTER_ID = 'adapter-tmux-test';
const TEST_ADAPTER_NAME = 'claude-code-tmux';
const TEST_CWD = '/tmp';

class TestTmuxConnector extends ClaudeCodeTmuxConnector {
  public override async initialize(): Promise<void> {}

  public override async close(): Promise<void> {}

  public async emitToolStarted(payload: { toolName: string; toolUseId: string; toolInput: unknown }): Promise<void> {
    await this.emit(
      ClaudeCodeTmuxConnectorSubjects.tool_use.started,
      payload as { toolName: string; toolUseId: string },
    );
  }

  public async emitToolFinished(payload: {
    toolName: string;
    toolUseId: string;
    toolResult: unknown;
    isError: boolean;
  }): Promise<void> {
    await this.emit(
      ClaudeCodeTmuxConnectorSubjects.tool_use.finished,
      payload as { toolName: string; toolUseId: string },
    );
  }
}

async function makeAgent(): Promise<{ agent: ClaudeCodeTmuxAgent; connector: TestTmuxConnector }> {
  const adapterBus = await ClaudeCodeTmuxConnectorNamespace.scopedBus();
  let connector: TestTmuxConnector | undefined;
  const agent = new ClaudeCodeTmuxAgent({
    agentId: TEST_AGENT_ID,
    adapterId: TEST_ADAPTER_ID,
    adapterName: TEST_ADAPTER_NAME,
    adapterBus,
    globalBus: MakaioBus,
    sessionId: 'framework-session-1',
    clientId: 'claude-code',
    cwd: TEST_CWD,
    model: 'claude-sonnet',
    capabilities: [],
    nativeTools: [],
    configFactory: async (input) => ({
      ...input,
      cwd: input.cwd ?? TEST_CWD,
      model: input.model ?? 'claude-sonnet',
      adapterId: TEST_ADAPTER_ID,
    }),
    connectorFactory: (config) => {
      connector = new TestTmuxConnector(config as ClaudeCodeTmuxAgentConfig);
      return connector;
    },
  });

  await agent.init();
  return { agent, connector: connector! };
}

describe('ClaudeCodeTmuxAgent', () => {
  let agents: ClaudeCodeTmuxAgent[] = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    agents = [];
  });

  afterEach(async () => {
    await Promise.all(agents.map((agent) => agent.close()));
    MakaioBus.__resetHandlers?.();
  });

  it('threads PreToolUse input and PostToolUse result into agent tool emissions', async () => {
    const { agent, connector } = await makeAgent();
    agents.push(agent);
    const toolUses: unknown[] = [];
    const toolOutputs: unknown[] = [];
    const stepFinishes: unknown[] = [];

    MakaioBus.on(AgentSubjects.tool.use, (ctx) => {
      toolUses.push(ctx.payload);
    });
    MakaioBus.on(AgentSubjects.tool.output, (ctx) => {
      toolOutputs.push(ctx.payload);
    });
    MakaioBus.on(AgentSubjects.step.finished, (ctx) => {
      stepFinishes.push(ctx.payload);
    });

    await connector.emitToolStarted({
      toolName: 'Bash',
      toolUseId: 'tu-1',
      toolInput: { command: 'ls' },
    });
    await connector.emitToolFinished({
      toolName: 'Bash',
      toolUseId: 'tu-1',
      toolResult: 'file.ts',
      isError: false,
    });

    await vi.waitFor(() => expect(toolUses).toHaveLength(1));
    await vi.waitFor(() => expect(toolOutputs).toHaveLength(1));

    expect(toolUses[0]).toMatchObject({
      toolName: 'Bash',
      args: { command: 'ls' },
      toolCallId: 'tu-1',
    });
    expect(toolOutputs[0]).toMatchObject({
      toolName: 'Bash',
      output: 'file.ts',
      toolCallId: 'tu-1',
      args: { command: 'ls' },
    });
    expect(stepFinishes[0]).toMatchObject({
      content: {
        type: 'tool_output',
        toolCallId: 'tu-1',
        output: 'file.ts',
        isError: false,
      },
    });
  });

  it('marks PostToolUse errors in agent tool emissions', async () => {
    const { agent, connector } = await makeAgent();
    agents.push(agent);
    const toolOutputs: unknown[] = [];
    const stepFinishes: unknown[] = [];

    MakaioBus.on(AgentSubjects.tool.output, (ctx) => {
      toolOutputs.push(ctx.payload);
    });
    MakaioBus.on(AgentSubjects.step.finished, (ctx) => {
      stepFinishes.push(ctx.payload);
    });

    await connector.emitToolStarted({
      toolName: 'Bash',
      toolUseId: 'tu-error',
      toolInput: { command: 'exit 1' },
    });
    await connector.emitToolFinished({
      toolName: 'Bash',
      toolUseId: 'tu-error',
      toolResult: 'permission denied',
      isError: true,
    });

    await vi.waitFor(() => expect(toolOutputs).toHaveLength(1));

    expect(toolOutputs[0]).toMatchObject({ output: 'permission denied' });
    expect(stepFinishes[0]).toMatchObject({
      content: {
        type: 'tool_output',
        toolCallId: 'tu-error',
        output: 'permission denied',
        isError: true,
      },
    });
  });

  it('emits client.runtime.observe after initialize confirms the tmux connector session', async () => {
    const { agent, connector } = await makeAgent();
    agents.push(agent);
    const observations: ClientRuntimeObserveRequest[] = [];

    MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
      observations.push(ctx.payload as ClientRuntimeObserveRequest);
      ctx.setResult({ clientRuntimeId: 'runtime-tmux-1', created: true, promoted: false });
    });

    await agent.initialize();

    await vi.waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      clientId: 'claude-code',
      source: { layer: 'adapter', producer: 'claude-code-tmux' },
      sessionId: 'framework-session-1',
      adapterSessionId: connector.adapterSessionId,
      observedAt: expect.any(Number),
    });
  });

  it('emits latest-request tokens without attributing cumulative session cost to one usage event', async () => {
    const { agent, connector } = await makeAgent();
    agents.push(agent);
    const usageEvents: Record<string, unknown>[] = [];

    MakaioBus.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });

    await MakaioBus.emit(ClaudeCodeClientSubjects.statusline.received, {
      session_id: connector.adapterSessionId,
      cost: { total_cost_usd: 12.34 },
      context_window: {
        total_input_tokens: 24_000,
        total_output_tokens: 3_000,
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 1_200,
          output_tokens: 300,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50,
        },
      },
    });

    await vi.waitFor(() => expect(usageEvents).toHaveLength(1));
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 1_200,
      inputCachedTokens: 800,
      cacheWriteTokens: 50,
      outputTokens: 300,
      totalTokens: 2_300,
    });
    expect(usageEvents[0]).not.toHaveProperty('cost');
    expect(usageEvents[0]).not.toHaveProperty('currency');
    expect(usageEvents[0]).not.toHaveProperty('costProvenance');
  });

  it('does not emit a second usage event when the statusline re-renders with a changed cumulative cost but identical per-request tokens', async () => {
    const { agent, connector } = await makeAgent();
    agents.push(agent);
    const usageEvents: Record<string, unknown>[] = [];

    MakaioBus.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });

    const basePayload = {
      session_id: connector.adapterSessionId,
      context_window: {
        total_input_tokens: 24_000,
        total_output_tokens: 3_000,
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 1_200,
          output_tokens: 300,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50,
        },
      },
    };

    // First render: cumulative cost 12.34
    await MakaioBus.emit(ClaudeCodeClientSubjects.statusline.received, {
      ...basePayload,
      cost: { total_cost_usd: 12.34 },
    });

    await vi.waitFor(() => expect(usageEvents).toHaveLength(1));

    // Second render: same per-request tokens, updated cumulative cost — must NOT produce a second usage event.
    await MakaioBus.emit(ClaudeCodeClientSubjects.statusline.received, {
      ...basePayload,
      cost: { total_cost_usd: 15.0 },
    });

    // Allow any async handlers to settle, then assert still exactly one event.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(usageEvents).toHaveLength(1);
  });

  it('emits again when a new request repeats the same per-request tokens but grows the cumulative totals', async () => {
    const { agent, connector } = await makeAgent();
    agents.push(agent);
    const usageEvents: Record<string, unknown>[] = [];

    MakaioBus.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });

    const currentUsage = {
      input_tokens: 1_200,
      output_tokens: 300,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 50,
    };

    await MakaioBus.emit(ClaudeCodeClientSubjects.statusline.received, {
      session_id: connector.adapterSessionId,
      context_window: {
        total_input_tokens: 24_000,
        total_output_tokens: 3_000,
        context_window_size: 200_000,
        current_usage: currentUsage,
      },
    });

    await vi.waitFor(() => expect(usageEvents).toHaveLength(1));

    // A second real request with identical per-request token counts advances
    // the cumulative context totals — it must be counted as a new usage event.
    await MakaioBus.emit(ClaudeCodeClientSubjects.statusline.received, {
      session_id: connector.adapterSessionId,
      context_window: {
        total_input_tokens: 25_200,
        total_output_tokens: 3_300,
        context_window_size: 200_000,
        current_usage: currentUsage,
      },
    });

    await vi.waitFor(() => expect(usageEvents).toHaveLength(2));
  });
});
