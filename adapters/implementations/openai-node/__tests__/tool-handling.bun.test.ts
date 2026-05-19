import { beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type AgentToolApproveResponse } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/index.js';
import { executeTool, handleToolCalls } from '../src/tool-handling.js';
import { OpenAINodeConnectorSubjects } from '../src/namespaces/index.js';

type ToolExecuteRequest = ExtractSubjectPayload<typeof ToolSubjects.execute>;
type ToolApprovalRequest = Omit<
  ExtractSubjectPayload<typeof OpenAINodeConnectorSubjects.tool_approval>,
  'adapterName' | 'adapterId' | 'agentId' | 'adapterSessionId' | 'sessionId'
>;

function createToolCall(): ChatCompletionMessageFunctionToolCall {
  return {
    id: 'tool-call-1',
    type: 'function',
    function: {
      name: 'terminal_scrollback',
      arguments: JSON.stringify({ limit: 100 }),
    },
  };
}

describe('tool-handling turnContext forwarding', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('forwards turnContext in executeTool contextOverrides', async () => {
    let receivedPayload: ToolExecuteRequest | undefined;

    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      receivedPayload = ctx.payload;
      ctx.setResult({
        success: true,
        data: { ok: true },
      });
    });

    const sdkEvents: Array<{ eventType: string }> = [];
    const result = await executeTool(
      createToolCall(),
      async (event) => {
        sdkEvents.push({ eventType: event.eventType });
      },
      {
        cwd: '/repo',
        env: {},
        sessionId: 'session-1',
        agentId: 'agent-1',
        adapterId: 'adapter-openai-1',
        adapterName: 'openai-node',
        turnId: 'turn-1',
        turnContext: {
          terminalSessionKey: 'proj::default::term-1',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(receivedPayload?.adapterId).toBe('adapter-openai-1');
    expect(receivedPayload?.adapterName).toBe('openai-node');
    expect(receivedPayload?.contextOverrides).toMatchObject({
      sessionId: 'session-1',
      agentId: 'agent-1',
      adapterId: 'adapter-openai-1',
      adapterName: 'openai-node',
      turnId: 'turn-1',
      turnContext: {
        terminalSessionKey: 'proj::default::term-1',
      },
    });
    expect(sdkEvents.map((event) => event.eventType)).toEqual(['tool_started', 'tool_completed']);
  });

  it('forwards turnContext through handleToolCalls execution path', async () => {
    let receivedPayload: ToolExecuteRequest | undefined;

    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      receivedPayload = ctx.payload;
      ctx.setResult({
        success: true,
        data: { ok: true },
      });
    });

    const approval: AgentToolApproveResponse = { action: 'allow' };
    const messages = await handleToolCalls(
      [createToolCall()],
      {
        emitSdkEvent: async () => {},
        requestToolApproval: async () => approval,
      },
      {
        cwd: '/repo',
        env: {},
        sessionId: 'session-2',
        agentId: 'agent-2',
        adapterId: 'adapter-openai-2',
        adapterName: 'openai-node',
        turnId: 'turn-2',
        turnContext: {
          terminalSessionKey: 'proj::default::term-2',
        },
      },
    );

    expect(receivedPayload?.adapterId).toBe('adapter-openai-2');
    expect(receivedPayload?.adapterName).toBe('openai-node');
    expect(receivedPayload?.contextOverrides).toMatchObject({
      sessionId: 'session-2',
      agentId: 'agent-2',
      adapterId: 'adapter-openai-2',
      adapterName: 'openai-node',
      turnId: 'turn-2',
      turnContext: {
        terminalSessionKey: 'proj::default::term-2',
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'tool',
      tool_call_id: 'tool-call-1',
    });
  });

  it('truncates oversized tool result content before feeding it back to model context', async () => {
    const largeOutput = 'x'.repeat(12_000);

    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({
        success: true,
        data: { output: largeOutput },
      });
    });

    const approval: AgentToolApproveResponse = { action: 'allow' };
    const messages = await handleToolCalls(
      [createToolCall()],
      {
        emitSdkEvent: async () => {},
        requestToolApproval: async () => approval,
      },
      {
        cwd: '/repo',
        env: {},
      },
    );

    expect(messages).toHaveLength(1);
    const content = messages[0].content as string;
    expect(content.length).toBeLessThanOrEqual(8_000);
    expect(content).toContain('[truncated ');
  });

  it('executes approval-modified arguments instead of original tool arguments', async () => {
    let receivedPayload: ToolExecuteRequest | undefined;

    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      receivedPayload = ctx.payload;
      ctx.setResult({
        success: true,
        data: { ok: true },
      });
    });

    const toolCall = createToolCall();
    const approval: AgentToolApproveResponse = { action: 'allow', updatedInput: { limit: 5 } };

    await handleToolCalls(
      [toolCall],
      {
        emitSdkEvent: async () => {},
        requestToolApproval: async () => approval,
      },
      {
        cwd: '/repo',
        env: {},
      },
    );

    expect(receivedPayload?.input).toEqual({ limit: 5 });
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ limit: 5 });
  });

  it('forwards reasoning to tool approval requests', async () => {
    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({
        success: true,
        data: { ok: true },
      });
    });

    let approvalPayload: ToolApprovalRequest | undefined;
    const approval: AgentToolApproveResponse = { action: 'allow' };
    await handleToolCalls(
      [createToolCall()],
      {
        emitSdkEvent: async () => {},
        requestToolApproval: async (payload) => {
          approvalPayload = payload;
          return approval;
        },
      },
      {
        cwd: '/repo',
        env: {},
        reasoning: 'Need terminal output before proceeding.',
      },
    );

    expect(approvalPayload?.reasoning).toBe('Need terminal output before proceeding.');
  });
});
