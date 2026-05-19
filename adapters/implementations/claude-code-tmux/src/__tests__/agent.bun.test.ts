/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { ClientRuntimeObserveRequest } from '@makaio/contracts/client';
import { ClientSubjects } from '@makaio/contracts/client';
import { ClaudeCodeTmuxAgent } from '../agent.js';
import { ClaudeCodeTmuxConnector } from '../connector.js';
import { ClaudeCodeTmuxConnectorNamespace, ClaudeCodeTmuxConnectorSubjects } from '../namespace/index.js';
import type { ClaudeCodeTmuxAgentConfig } from '../types.js';

/**
 * Poll until `fn` resolves without throwing, or the timeout elapses.
 * @param fn - Async assertion or resolution function to retry
 * @param options - Optional `timeout` in ms (default 5000) and `interval` in ms (default 50)
 */
async function waitFor<T>(fn: () => Promise<T>, options?: { timeout?: number; interval?: number }): Promise<T> {
  const timeout = options?.timeout ?? 5_000;
  const interval = options?.interval ?? 50;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  }
  throw lastError;
}

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

    await waitFor(() => Promise.resolve(expect(toolUses).toHaveLength(1)));
    await waitFor(() => Promise.resolve(expect(toolOutputs).toHaveLength(1)));

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

    await waitFor(() => Promise.resolve(expect(toolOutputs).toHaveLength(1)));

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

    await waitFor(() => Promise.resolve(expect(observations).toHaveLength(1)));
    expect(observations[0]).toMatchObject({
      clientId: 'claude-code',
      source: { layer: 'adapter', producer: 'claude-code-tmux' },
      sessionId: 'framework-session-1',
      adapterSessionId: connector.adapterSessionId,
      observedAt: expect.any(Number),
    });
  });
});
