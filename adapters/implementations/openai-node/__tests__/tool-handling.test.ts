import { beforeEach, describe, expect, it } from 'vitest';
import { createTestCall } from '@makaio/test-utils';
import { createBusInstance, MakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type AgentToolApproveResponse, type Party } from '@makaio/contracts';
import type { CallContext, ExtractSubjectPayload } from '@makaio/core';
import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/index.js';
import { executeTool, fetchToolsForOpenAI, handleToolCalls } from '../src/tool-handling.js';
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
  let call: CallContext;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    call = createTestCall();
  });

  it('applies allowed tool filters before OpenAI SDK conversion', async () => {
    const hostBus = createBusInstance();

    hostBus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({
        tools: [
          {
            name: 'allowed_tool',
            description: 'Allowed',
            toolsetName: 'test',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'other_tool',
            description: 'Other',
            toolsetName: 'test',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolsets: [{ name: 'test', description: 'Test tools', version: '1.0.0', toolCount: 2 }],
      });
    });

    const tools = await fetchToolsForOpenAI(call, hostBus, 'adapter-openai-1', 'openai-node', {
      allowedTools: ['allowed_tool'],
    });

    expect(tools.map((tool) => (tool.type === 'function' ? tool.function.name : undefined))).toEqual(['allowed_tool']);
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
      call,
      MakaioBus,
      createToolCall(),
      async (_call, event) => {
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
      call,
      [createToolCall()],
      {
        bus: MakaioBus,
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
      call,
      [createToolCall()],
      {
        bus: MakaioBus,
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
      call,
      [toolCall],
      {
        bus: MakaioBus,
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
      call,
      [createToolCall()],
      {
        bus: MakaioBus,
        emitSdkEvent: async () => {},
        requestToolApproval: async (_call, payload) => {
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

  it('R1: forwards the turn call to approval, lifecycle events and tool execution after an awaited approval', async () => {
    const personA: Party = { kind: 'acme.person', id: 'person-a' };
    const turnCall = createTestCall({ principal: personA });
    const approvalCalls: CallContext[] = [];
    const eventCalls: CallContext[] = [];
    const executePrincipals: Party[] = [];

    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      executePrincipals.push(ctx.call.principal);
      ctx.setResult({ success: true, data: { ok: true } });
    });

    const approval: AgentToolApproveResponse = { action: 'allow' };
    await handleToolCalls(
      turnCall,
      [createToolCall()],
      {
        bus: MakaioBus,
        emitSdkEvent: async (eventCall) => {
          eventCalls.push(eventCall);
        },
        requestToolApproval: async (approvalCall) => {
          approvalCalls.push(approvalCall);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return approval;
        },
      },
      { cwd: '/repo', env: {} },
    );

    expect(approvalCalls).toEqual([turnCall]);
    expect(approvalCalls[0]).toBe(turnCall);
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls.every((eventCall) => eventCall === turnCall)).toBe(true);
    expect(executePrincipals).toEqual([personA]);
  });
});
