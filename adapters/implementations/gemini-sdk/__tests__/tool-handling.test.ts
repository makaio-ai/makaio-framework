import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects, type ToolListItem } from '@makaio/contracts';
import type { Config, GeminiChat, ToolCallRequestInfo } from '@google/gemini-cli-core';
import { fetchToolsForGemini, toGeminiToolFormat } from '../src/tool-handling.js';
import { executeToolCalls } from '../src/utils/execute-tool-calls.js';

/**
 * Create a minimal Config stand-in paired with a spied tool registry.
 *
 * Only `getToolRegistry` and `getModel` are exercised by `executeToolCalls`.
 * @returns Config shim and the spy on its internal getTool function
 */
function createMockGeminiConfig(): { geminiConfig: Config; getToolSpy: ReturnType<typeof vi.fn> } {
  const getToolSpy = vi.fn((_name: string) => undefined);
  // @ts-expect-error -- partial platform shim; Config and ToolRegistry have many more members not needed here
  const geminiConfig: Config = { getToolRegistry: () => ({ getTool: getToolSpy }), getModel: () => 'gemini-2.5-flash' };
  return { geminiConfig, getToolSpy };
}

/**
 * Create a minimal GeminiChat stand-in.
 *
 * Only `recordCompletedToolCalls` is exercised by `executeToolCalls`.
 * @returns An object typed as GeminiChat
 */
function createMockGeminiChat(): GeminiChat {
  // @ts-expect-error — partial platform shim; GeminiChat has many more members not needed here
  return { recordCompletedToolCalls: vi.fn() };
}

describe('gemini tool handling', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('converts registry tools with schemas to Gemini function declarations', () => {
    const tools: ToolListItem[] = [
      {
        name: 'search_repo',
        description: 'Search the repository.',
        toolsetName: 'registry',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
      {
        name: 'no_schema',
        description: 'Ignored without an input schema.',
        toolsetName: 'registry',
      },
    ];

    expect(toGeminiToolFormat(tools)).toEqual([
      {
        name: 'search_repo',
        description: 'Search the repository.',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ]);
  });

  it('loads registry tools through ToolSubjects.list', async () => {
    const hostBus = createBusInstance();
    cleanups.push(
      hostBus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'search_repo',
              description: 'Search the repository.',
              toolsetName: 'registry',
              inputSchema: { type: 'object' },
            },
          ],
          toolsets: [],
        });
      }),
    );

    await expect(fetchToolsForGemini(hostBus, 'adapter-1', 'gemini-sdk')).resolves.toEqual([
      {
        name: 'search_repo',
        description: 'Search the repository.',
        parametersJsonSchema: { type: 'object' },
      },
    ]);
  });

  it('falls back to the central tool registry when Gemini native lookup misses', async () => {
    const hostBus = createBusInstance();
    const emitSdkEvent = vi.fn(async () => {});
    const requestToolApproval = vi.fn(async () => ({ action: 'allow' as const }));

    const { geminiConfig, getToolSpy } = createMockGeminiConfig();
    const geminiChat = createMockGeminiChat();

    cleanups.push(
      hostBus.on(ToolSubjects.execute, (ctx) => {
        ctx.setResult({
          success: true,
          data: { output: 'central result' },
        });
      }),
    );

    const toolCall: ToolCallRequestInfo = {
      callId: 'call-1',
      name: 'registry_tool',
      args: { query: 'hello' },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    };

    const result = await executeToolCalls([toolCall], {
      bus: hostBus,
      geminiConfig,
      geminiChat,
      emitSdkEvent,
      requestToolApproval: requestToolApproval as never,
      handleError: vi.fn(),
      adapterId: 'adapter-1',
      adapterName: 'gemini-sdk',
      agentId: 'agent-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      reasoning: 'need search context',
      registryToolNames: new Set(['registry_tool']),
    });

    expect(result.responseParts).toEqual([
      {
        functionResponse: {
          id: 'call-1',
          name: 'registry_tool',
          response: { output: JSON.stringify({ output: 'central result' }) },
        },
      },
    ]);
    expect(getToolSpy).toHaveBeenCalledWith('registry_tool');
    expect(emitSdkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.tool.updated',
        toolCallId: 'call-1',
        status: 'completed',
      }),
    );
    expect(geminiChat.recordCompletedToolCalls).not.toHaveBeenCalled();
  });

  it('records mcp_call targets in the session tool ledger', async () => {
    const hostBus = createBusInstance();
    const emitSdkEvent = vi.fn(async () => {});
    const requestToolApproval = vi.fn(async () => ({ action: 'allow' as const }));
    const recordCall = vi.fn();

    const { geminiConfig } = createMockGeminiConfig();
    const geminiChat = createMockGeminiChat();

    cleanups.push(
      hostBus.on(ToolSubjects.execute, (ctx) => {
        ctx.setResult({
          success: true,
          data: { output: 'ok' },
        });
      }),
    );

    const toolCall: ToolCallRequestInfo = {
      callId: 'call-mcp-1',
      name: 'mcp_call',
      args: { tool: 'github__create_issue', input: { title: 'Bug' } },
      isClientInitiated: false,
      prompt_id: 'prompt-mcp-1',
    };

    await executeToolCalls([toolCall], {
      bus: hostBus,
      geminiConfig,
      geminiChat,
      emitSdkEvent,
      requestToolApproval: requestToolApproval as never,
      handleError: vi.fn(),
      adapterId: 'adapter-1',
      adapterName: 'gemini-sdk',
      agentId: 'agent-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      registryToolNames: new Set(['mcp_call']),
      toolLedger: { recordCall } as never,
      getCurrentTurnNumber: () => 7,
    });

    expect(recordCall).toHaveBeenCalledWith('github__create_issue', 7);
  });
});
