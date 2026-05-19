import { beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type ToolListItem } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import type { ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { PiSdkProviderConfigSchema } from '../schemas.js';
import { createPiToolHandler } from '../tool-conversion.js';

type ToolExecuteRequest = ExtractSubjectPayload<typeof ToolSubjects.execute>;
const extensionContext = {} as ExtensionContext;

const registryTool = {
  name: 'read_file',
  description: 'Read a file',
  toolsetName: 'filesystem',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
  },
} satisfies ToolListItem & { inputSchema: Record<string, unknown> };

/**
 * Execute a Pi tool handler with the SDK's full call shape.
 * @param handler - Pi tool execute callback under test
 * @param toolCallId - Pi tool call identifier
 * @param params - Validated tool params
 * @returns Pi tool result
 */
function executePiTool(
  handler: ToolDefinition['execute'],
  toolCallId: string,
  params: Record<string, unknown>,
): ReturnType<ToolDefinition['execute']> {
  return handler(toolCallId, params, undefined, undefined, extensionContext);
}

describe('Pi SDK provider config schema', () => {
  it('only exposes Pi SDK options the adapter forwards to createAgentSession', () => {
    expect(Object.keys(PiSdkProviderConfigSchema.shape)).toEqual(['noTools']);
  });
});

describe('createPiToolHandler', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('forwards full execution context to registry tool calls', async () => {
    let receivedPayload: ToolExecuteRequest | undefined;

    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      receivedPayload = ctx.payload;
      ctx.setResult({
        success: true,
        data: { content: 'ok' },
      });
    });

    const handler = createPiToolHandler(registryTool, {
      adapterId: 'adapter-pi-1',
      adapterName: 'pi-sdk',
      agentId: 'agent-1',
      sessionId: 'session-1',
      cwd: '/repo',
      env: { NODE_ENV: 'test' },
      allowedDirectories: ['/repo'],
      getTurnExecutionContext: () => ({
        turnId: 'message-1',
        turnContext: {
          terminalSessionKey: 'project::default::terminal',
        },
      }),
    });

    const result = await executePiTool(handler, 'tool-call-1', { path: 'README.md' });

    expect(result.content).toEqual([{ type: 'text', text: '{\n  "content": "ok"\n}' }]);
    expect(receivedPayload).toMatchObject({
      toolName: 'read_file',
      input: { path: 'README.md' },
      adapterId: 'adapter-pi-1',
      adapterName: 'pi-sdk',
      contextOverrides: {
        cwd: '/repo',
        env: { NODE_ENV: 'test' },
        sessionId: 'session-1',
        agentId: 'agent-1',
        adapterId: 'adapter-pi-1',
        adapterName: 'pi-sdk',
        turnId: 'message-1',
        turnContext: {
          terminalSessionKey: 'project::default::terminal',
        },
        toolCallId: 'tool-call-1',
        constraints: {
          allowedDirectories: ['/repo'],
        },
      },
    });
  });

  it('uses approval-rewritten input for registry execution', async () => {
    let receivedPayload: ToolExecuteRequest | undefined;

    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      receivedPayload = ctx.payload;
      ctx.setResult({
        success: true,
        data: 'rewritten',
      });
    });

    const handler = createPiToolHandler(registryTool, {
      adapterId: 'adapter-pi-1',
      adapterName: 'pi-sdk',
      agentId: 'agent-1',
      sessionId: 'session-1',
      cwd: '/repo',
      env: {},
      consumeApprovedToolInput: () => ({ path: 'approved.md' }),
    });

    await executePiTool(handler, 'tool-call-1', { path: 'original.md' });

    expect(receivedPayload?.input).toEqual({ path: 'approved.md' });
  });

  it('throws when registry execution fails so Pi marks the tool result as an error', async () => {
    MakaioBus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({
        success: false,
        error: { code: 'READ_FAILED', message: 'Cannot read file' },
      });
    });

    const handler = createPiToolHandler(registryTool, {
      adapterId: 'adapter-pi-1',
      adapterName: 'pi-sdk',
      agentId: 'agent-1',
      sessionId: 'session-1',
      cwd: '/repo',
      env: {},
    });

    await expect(executePiTool(handler, 'tool-call-1', { path: 'missing.md' })).rejects.toThrow('Cannot read file');
  });
});
