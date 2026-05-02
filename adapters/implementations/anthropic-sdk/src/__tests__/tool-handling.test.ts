import { beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type AgentToolApproveResponse } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import type { ToolCall } from '../namespaces/index.js';
import { executeTool, extractToolCallPayload, handleToolCalls } from '../tool-handling.js';

type ToolExecuteRequest = ExtractSubjectPayload<typeof ToolSubjects.execute>;

function createToolCall(): ToolCall {
  return {
    id: 'tool-call-1',
    blockIndex: 0,
    type: 'function',
    function: {
      name: 'terminal_scrollback',
      arguments: JSON.stringify({ limit: 100 }),
    },
  };
}

describe('anthropic tool-handling', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
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
        adapterId: 'adapter-anthropic-1',
        adapterName: 'anthropic-sdk',
      },
    );

    expect(receivedPayload?.adapterId).toBe('adapter-anthropic-1');
    expect(receivedPayload?.adapterName).toBe('anthropic-sdk');
    expect(receivedPayload?.input).toEqual({ limit: 5 });
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ limit: 5 });
  });

  it('emits tool_completed with success=false when tool execution throws', async () => {
    MakaioBus.on(ToolSubjects.execute, () => {
      throw new Error('execution failed');
    });

    const events: Array<{ eventType: string; success?: boolean }> = [];
    await expect(
      executeTool(
        createToolCall(),
        async (event) => {
          events.push({ eventType: event.eventType, success: 'success' in event ? event.success : undefined });
        },
        {
          env: {},
        },
      ),
    ).rejects.toThrow('execution failed');

    expect(events).toEqual([
      { eventType: 'tool_started', success: undefined },
      { eventType: 'tool_completed', success: false },
    ]);
  });

  it('does not leak raw tool args in parse errors', () => {
    const badToolCall: ToolCall = {
      id: 'tc-raw',
      blockIndex: 0,
      type: 'function',
      function: {
        name: 'secret_tool',
        arguments: '{"token":"super-secret"',
      },
    };

    expect(() => extractToolCallPayload(badToolCall)).toThrow('Failed to parse tool arguments for "secret_tool"');
    expect(() => extractToolCallPayload(badToolCall)).not.toThrow('super-secret');
  });

  it('rejects parsed tool arguments that are not JSON objects', () => {
    const nonObjectPayloads = ['null', '[]', '"value"', '42', 'true'];

    for (const rawArgs of nonObjectPayloads) {
      const badToolCall: ToolCall = {
        id: `tc-non-object-${rawArgs}`,
        blockIndex: 0,
        type: 'function',
        function: {
          name: 'shape_guard_tool',
          arguments: rawArgs,
        },
      };

      expect(() => extractToolCallPayload(badToolCall)).toThrow(
        'Tool arguments for "shape_guard_tool" must be a JSON object',
      );
    }
  });

  it('emits tool_completed with success=false when executeTool receives malformed JSON args', async () => {
    const malformedToolCall: ToolCall = {
      id: 'tool-call-bad-json',
      blockIndex: 0,
      type: 'function',
      function: {
        name: 'terminal_scrollback',
        arguments: '{"limit":',
      },
    };

    const events: Array<{ eventType: string; success?: boolean }> = [];

    await expect(
      executeTool(
        malformedToolCall,
        async (event) => {
          events.push({ eventType: event.eventType, success: 'success' in event ? event.success : undefined });
        },
        { env: {} },
      ),
    ).rejects.toThrow();

    expect(events).toEqual([
      { eventType: 'tool_started', success: undefined },
      { eventType: 'tool_completed', success: false },
    ]);
  });
});
