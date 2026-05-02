import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { McpContextRegistry } from './context-registry.js';
import {
  createMcpRequestHandler,
  createMcpServer,
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

describe('createMcpRequestHandler', () => {
  it('returns 500 when transport request handling rejects', async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const handleRequestSpy = vi.spyOn(transport, 'handleRequest').mockRejectedValue(new Error('boom'));
    const handler = createMcpRequestHandler(transport);
    const req = {} as import('node:http').IncomingMessage;
    const res = {
      headersSent: false,
      writableEnded: false,
      statusCode: 200,
      end: vi.fn(),
    } as Partial<import('node:http').ServerResponse> as import('node:http').ServerResponse;

    handler(req, res);
    await vi.waitFor(() => {
      expect(res.statusCode).toBe(500);
      expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    });

    expect(handleRequestSpy).toHaveBeenCalledTimes(1);
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
});

describe('startHttpMcpServer', () => {
  it('invokes the transport onclose hook once when the handle closes', async () => {
    const bus = createBusInstance();
    const onclose = vi.fn();

    const handle = await startHttpMcpServer(bus, { onclose });

    await handle.close();

    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe('createMcpServer', () => {
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
