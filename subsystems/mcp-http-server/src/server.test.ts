import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { McpContextRegistry } from './context-registry.js';
import { createMcpServer } from './create-mcp-server.js';
import {
  handleApproveToolCall,
  startHttpMcpServer,
  startMcpServer,
  type RequestToolApproval,
  type ToolApproveRequestPayload,
  type ToolApproveResponse,
  type StdioMcpServerHandle,
} from './server.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Parse the first text content entry from an approve-tool MCP result.
 * @param result - MCP call result; index 0 must contain a text content block.
 * @returns Parsed JSON object from the first text content block.
 * @throws Error When the first content item is missing or not type 'text'.
 */
function parseApproveResult(result: CallToolResult): Record<string, unknown> {
  const firstContent = result.content[0];
  if (!firstContent || firstContent.type !== 'text') {
    throw new Error('Approve tool result must contain text content');
  }
  return JSON.parse(firstContent.text) as Record<string, unknown>;
}

interface AgentContextOverrides {
  agentId?: string;
  adapterId?: string;
  adapterName?: string;
  adapterSessionId?: string;
  sessionId?: string;
}

function createAgentContext(overrides: AgentContextOverrides = {}) {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    adapterId: overrides.adapterId ?? 'adapter-1',
    adapterName: overrides.adapterName ?? 'adapter-name',
    adapterSessionId: overrides.adapterSessionId ?? 'session-1',
    sessionId: overrides.sessionId ?? 'test-session-1',
  };
}

/**
 * Register a test session in the MCP context registry.
 * @param registry - Registry under test
 * @param sessionId - Session identifier
 * @param overrides - Optional context overrides
 */
function registerSession(registry: McpContextRegistry, sessionId: string, overrides: AgentContextOverrides = {}): void {
  registry.register(
    sessionId,
    createAgentContext({
      ...overrides,
      sessionId: overrides.sessionId ?? sessionId,
    }),
  );
}

describe('handleApproveToolCall', () => {
  it('denies when no agent context is registered', async () => {
    const registry = new McpContextRegistry();
    const requestToolApproval = vi.fn<RequestToolApproval>();

    const result = await handleApproveToolCall(
      {
        tool_name: 'bash',
        input: { command: 'pwd' },
        tool_use_id: 'tool-1',
      },
      registry,
      'missing-session',
      requestToolApproval,
    );

    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(parseApproveResult(result)).toMatchObject({
      behavior: 'deny',
      message: 'No agent context found for this session',
    });
  });

  it('denies malformed approve arguments before dispatching RPC', async () => {
    const registry = new McpContextRegistry();
    registerSession(registry, 'session-1');
    const requestToolApproval = vi.fn<RequestToolApproval>();

    const result = await handleApproveToolCall({}, registry, 'session-1', requestToolApproval);

    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(parseApproveResult(result)).toMatchObject({
      behavior: 'deny',
    });
  });

  it('denies approve arguments when input is an array', async () => {
    const registry = new McpContextRegistry();
    registerSession(registry, 'session-array', {
      agentId: 'agent-array',
      adapterId: 'adapter-array',
      adapterName: 'adapter-array',
      adapterSessionId: 'session-array',
      sessionId: 'test-session-array',
    });
    const requestToolApproval = vi.fn<RequestToolApproval>();

    const result = await handleApproveToolCall(
      {
        tool_name: 'bash',
        input: [],
        tool_use_id: 'tool-array',
      },
      registry,
      'session-array',
      requestToolApproval,
    );

    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(parseApproveResult(result)).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('input must be an object'),
    });
  });

  it('routes approval to the injected requester with session context', async () => {
    const registry = new McpContextRegistry();
    registerSession(registry, 'session-2', {
      agentId: 'agent-2',
      adapterId: 'adapter-2',
      adapterName: 'adapter-two',
      adapterSessionId: 'session-2',
      sessionId: 'test-session-2',
    });
    const requestToolApproval = vi.fn(async (_payload: ToolApproveRequestPayload): Promise<ToolApproveResponse> => {
      return {
        action: 'allow',
        updatedInput: { command: 'ls -la' },
      };
    });

    const result = await handleApproveToolCall(
      {
        tool_name: 'bash',
        input: { command: 'ls' },
        tool_use_id: 'tool-2',
      },
      registry,
      'session-2',
      requestToolApproval,
    );

    expect(requestToolApproval).toHaveBeenCalledTimes(1);
    expect(requestToolApproval).toHaveBeenCalledWith({
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 'tool-2',
      agentId: 'agent-2',
      adapterId: 'adapter-2',
      adapterName: 'adapter-two',
      adapterSessionId: 'session-2',
      sessionId: 'test-session-2',
    });
    expect(parseApproveResult(result)).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });
  });

  it('maps deny responses to deny behavior payload', async () => {
    const registry = new McpContextRegistry();
    registerSession(registry, 'session-3', {
      agentId: 'agent-3',
      adapterId: 'adapter-3',
      adapterName: 'adapter-three',
      adapterSessionId: 'session-3',
      sessionId: 'test-session-3',
    });
    const requestToolApproval = vi.fn(
      async (): Promise<ToolApproveResponse> => ({
        action: 'deny',
        message: 'Blocked by policy',
      }),
    );

    const result = await handleApproveToolCall(
      {
        tool_name: 'bash',
        input: { command: 'rm -rf /' },
        tool_use_id: 'tool-3',
      },
      registry,
      'session-3',
      requestToolApproval,
    );

    expect(parseApproveResult(result)).toEqual({
      behavior: 'deny',
      message: 'Blocked by policy',
    });
  });

  it('maps approval requester errors to deny behavior payload', async () => {
    const registry = new McpContextRegistry();
    registerSession(registry, 'session-4', {
      agentId: 'agent-4',
      adapterId: 'adapter-4',
      adapterName: 'adapter-four',
      adapterSessionId: 'session-4',
      sessionId: 'test-session-4',
    });
    const requestToolApproval = vi.fn(async (): Promise<ToolApproveResponse> => {
      throw new Error('approval backend unavailable');
    });

    const result = await handleApproveToolCall(
      {
        tool_name: 'bash',
        input: { command: 'cat /etc/hosts' },
        tool_use_id: 'tool-4',
      },
      registry,
      'session-4',
      requestToolApproval,
    );

    expect(requestToolApproval).toHaveBeenCalledTimes(1);
    expect(parseApproveResult(result)).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('approval backend unavailable'),
    });
  });
});

describe('startMcpServer (stdio)', () => {
  it('returns a StdioMcpServerHandle with a close() method', async () => {
    const bus = createBusInstance();
    vi.spyOn(StdioServerTransport.prototype, 'start').mockResolvedValue();

    const handle = await startMcpServer(bus, 'test-stdio-session', {
      transport: 'stdio',
    });

    // Verify the handle shape conforms to StdioMcpServerHandle
    const typedHandle: StdioMcpServerHandle = handle;
    expect(typeof typedHandle.close).toBe('function');

    // close() must resolve without throwing
    await expect(typedHandle.close()).resolves.toBeUndefined();
  });

  it('does not register a SIGINT handler on the process', async () => {
    const bus = createBusInstance();
    vi.spyOn(StdioServerTransport.prototype, 'start').mockResolvedValue();
    const listenerCountBefore = process.listenerCount('SIGINT');

    const handle = await startMcpServer(bus, 'test-stdio-session-2', {
      transport: 'stdio',
    });

    expect(process.listenerCount('SIGINT')).toBe(listenerCountBefore);

    await handle.close();
  });

  it('removes stdin listeners when transport startup fails', async () => {
    const bus = createBusInstance();
    vi.spyOn(StdioServerTransport.prototype, 'start').mockRejectedValue(new Error('stdio startup failed'));
    const endListenersBefore = process.stdin.listenerCount('end');
    const closeListenersBefore = process.stdin.listenerCount('close');

    await expect(startMcpServer(bus, 'failed-stdio-session', { transport: 'stdio' })).rejects.toThrow(
      'stdio startup failed',
    );

    expect(process.stdin.listenerCount('end')).toBe(endListenersBefore);
    expect(process.stdin.listenerCount('close')).toBe(closeListenersBefore);
  });

  it('resolves current context overrides independently for every stdio tool call', async () => {
    const bus = createBusInstance();
    const capturedContexts: unknown[] = [];
    let currentCwd = '/workspace/first-session';
    const resolveContextOverrides = vi.fn(() => ({ cwd: currentCwd, sessionId: currentCwd }));
    const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({
        tools: [{ name: 'echo', description: 'Echo', toolsetName: 'test-tools', inputSchema: { type: 'object' } }],
        toolsets: [],
      });
    });
    const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
      capturedContexts.push(ctx.payload.contextOverrides);
      ctx.setResult({ success: true, data: ctx.payload.input });
    });
    const startTransport = vi.spyOn(StdioServerTransport.prototype, 'start').mockResolvedValue();
    vi.spyOn(StdioServerTransport.prototype, 'send').mockResolvedValue();

    const handle = await startMcpServer(bus, 'stdio-fallback-session', {
      transport: 'stdio',
      resolveContextOverrides,
    });
    const transport = startTransport.mock.contexts[0] as StdioServerTransport | undefined;

    try {
      await transport?.onmessage?.({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 'first' } },
      });
      await vi.waitFor(() => expect(capturedContexts).toHaveLength(1));

      currentCwd = '/workspace/reconnected-session';
      await transport?.onmessage?.({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 'second' } },
      });
      await vi.waitFor(() => expect(capturedContexts).toHaveLength(2));

      expect(resolveContextOverrides).toHaveBeenCalledTimes(2);
      expect(resolveContextOverrides).toHaveBeenNthCalledWith(1, undefined);
      expect(resolveContextOverrides).toHaveBeenNthCalledWith(2, undefined);
      expect(capturedContexts).toEqual([
        expect.objectContaining({ cwd: '/workspace/first-session', sessionId: '/workspace/first-session' }),
        expect.objectContaining({
          cwd: '/workspace/reconnected-session',
          sessionId: '/workspace/reconnected-session',
        }),
      ]);
    } finally {
      cleanupList();
      cleanupExecute();
      await handle.close();
    }
  });
});

describe('startHttpMcpServer', () => {
  it('invokes the endpoint onclose hook once when the handle closes', async () => {
    const bus = createBusInstance();
    const onclose = vi.fn();

    const handle = await startHttpMcpServer(bus, { onclose });

    await handle.close();

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('closes standalone HTTP resources idempotently', async () => {
    const handle = await startHttpMcpServer(createBusInstance());

    await expect(Promise.all([handle.close(), handle.close()])).resolves.toEqual([undefined, undefined]);
    await expect(handle.close()).resolves.toBeUndefined();
  });

  // Startup now fails before any MCP client session exists, so nothing was ever
  // subscribed to the tool registry. See mcp-transport-registry.test.ts for the
  // stronger sibling covering a session that fails to connect at request time.
  it('never subscribes to the tool registry when http.Server.listen throws synchronously', async () => {
    const bus = createBusInstance();
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();

    await expect(startHttpMcpServer(bus, { port: -1 })).rejects.toThrow(/port/i);
    await bus.emit(ToolSubjects.registryChanged, {
      revision: 5,
      reason: 'toolset-registered',
      toolsetName: 'after-invalid-port',
    });

    expect(sendToolListChanged).not.toHaveBeenCalled();
  });
});

describe('createMcpServer', () => {
  async function callEchoTool(options?: Parameters<typeof createMcpServer>[2]): Promise<ReturnType<typeof vi.spyOn>> {
    const bus = createBusInstance();
    const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({
        tools: [{ name: 'echo', description: 'Echo', toolsetName: 'test', inputSchema: { type: 'object' } }],
        toolsets: [],
      });
    });
    const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: ctx.payload.input });
    });
    const requestOptional = vi.spyOn(bus, 'requestOptional');
    const server = await createMcpServer(bus, 'timeout-session', options);
    const client = new Client({ name: 'timeout-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({ name: 'echo', arguments: { value: 'ok' } });
      return requestOptional;
    } finally {
      await client.close();
      await server.close();
      cleanupExecute();
      cleanupList();
    }
  }

  it('forwards a configured timeout beyond the bus default to tool execution', async () => {
    const requestOptional = await callEchoTool({ toolExecutionTimeoutMs: 180_000 });

    expect(requestOptional).toHaveBeenCalledWith(ToolSubjects.execute, expect.objectContaining({ toolName: 'echo' }), {
      timeout: 180_000,
    });
  });

  it('retains the bus default when no tool execution timeout is configured', async () => {
    const requestOptional = await callEchoTool();

    expect(requestOptional.mock.lastCall).toHaveLength(2);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects unsafe tool execution timeout %s', async (timeout) => {
    await expect(
      createMcpServer(createBusInstance(), 'invalid-timeout', { toolExecutionTimeoutMs: timeout }),
    ).rejects.toThrow('toolExecutionTimeoutMs must be a positive safe integer');
  });

  describe('tool registry change notifications', () => {
    it('sends tools/list_changed to connected MCP clients when tool.registryChanged fires', async () => {
      const bus = createBusInstance();
      const server = await createMcpServer(bus, 'test-session');
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const notifications: string[] = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
        notifications.push(notification.method);
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await bus.emit(ToolSubjects.registryChanged, {
        revision: 1,
        reason: 'toolset-registered',
        toolsetName: 'test-toolset',
      });

      await vi.waitFor(() => {
        expect(notifications).toEqual(['notifications/tools/list_changed']);
      });

      await client.close();
      await server.close();
    });

    it('unsubscribes from registryChanged after server.close()', async () => {
      const bus = createBusInstance();
      const server = await createMcpServer(bus, 'test-session');
      const sendToolListChanged = vi.spyOn(server, 'sendToolListChanged').mockResolvedValue();

      // Connect a transport so that server.close() triggers the onclose hook,
      // which is the seam used to unsubscribe the registryChanged listener.
      const [serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await server.close();

      await bus.emit(ToolSubjects.registryChanged, {
        revision: 2,
        reason: 'toolset-unregistered',
        toolsetName: 'test-toolset',
      });

      expect(sendToolListChanged).not.toHaveBeenCalled();
    });

    it('unsubscribes from registryChanged when closed before transport connection', async () => {
      const bus = createBusInstance();
      const server = await createMcpServer(bus, 'test-session');
      const sendToolListChanged = vi.spyOn(server, 'sendToolListChanged').mockResolvedValue();

      await server.close();

      await bus.emit(ToolSubjects.registryChanged, {
        revision: 3,
        reason: 'toolset-registered',
        toolsetName: 'test-toolset',
      });

      expect(sendToolListChanged).not.toHaveBeenCalled();
    });
  });
});
