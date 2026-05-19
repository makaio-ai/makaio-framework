import { describe, expect, it } from 'bun:test';
import { z } from 'zod/v3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildMcpSessionContext, createSdkMcpServer, prepareMcpServersForSession } from '../../src/shared/mcp.js';

describe('buildMcpSessionContext', () => {
  // ---------------------------------------------------------------------------
  // Empty input
  // ---------------------------------------------------------------------------

  it('returns an empty array for an empty servers record', () => {
    expect(buildMcpSessionContext({})).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // stdio transport
  // ---------------------------------------------------------------------------

  it('maps a minimal stdio server (type omitted) to a resolved server', () => {
    const result = buildMcpSessionContext({
      github: { command: 'npx', args: ['-y', '@github/mcp'] },
    });

    expect(result).toEqual([
      {
        name: 'github',
        transport: { type: 'stdio', command: 'npx', args: ['-y', '@github/mcp'] },
        exposureMode: 'direct',
      },
    ]);
  });

  it('maps a stdio server with explicit type field', () => {
    const result = buildMcpSessionContext({
      fs: { type: 'stdio', command: 'mcp-fs', args: ['--root', '/tmp'] },
    });

    expect(result[0]?.transport).toEqual({
      type: 'stdio',
      command: 'mcp-fs',
      args: ['--root', '/tmp'],
    });
  });

  it('preserves env vars on stdio servers', () => {
    const result = buildMcpSessionContext({
      custom: { command: 'my-mcp', env: { HOME: '/root', DEBUG: '1' } },
    });

    expect(result[0]?.transport).toEqual({
      type: 'stdio',
      command: 'my-mcp',
      env: { HOME: '/root', DEBUG: '1' },
    });
  });

  it('omits args and env when not provided on stdio servers', () => {
    const result = buildMcpSessionContext({
      bare: { command: 'bare-mcp' },
    });

    const transport = result[0]?.transport;
    expect(transport).not.toHaveProperty('args');
    expect(transport).not.toHaveProperty('env');
  });

  // ---------------------------------------------------------------------------
  // sse transport
  // ---------------------------------------------------------------------------

  it('maps an sse server with headers', () => {
    const result = buildMcpSessionContext({
      remote: { type: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer token' } },
    });

    expect(result[0]?.transport).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('omits headers when not provided on sse servers', () => {
    const result = buildMcpSessionContext({
      sse: { type: 'sse', url: 'https://mcp.example.com/sse' },
    });

    expect(result[0]?.transport).not.toHaveProperty('headers');
  });

  // ---------------------------------------------------------------------------
  // http transport
  // ---------------------------------------------------------------------------

  it('maps an http server with headers', () => {
    const result = buildMcpSessionContext({
      api: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': 'secret' } },
    });

    expect(result[0]?.transport).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Api-Key': 'secret' },
    });
  });

  it('preserves Claude SDK dynamic server policy fields', () => {
    const result = buildMcpSessionContext({
      api: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        tools: [{ name: 'read_doc', permission_policy: 'always_allow' }],
        alwaysLoad: true,
      },
    });

    expect(result[0]?.transport).toMatchObject({
      type: 'http',
      tools: [{ name: 'read_doc', permission_policy: 'always_allow' }],
      alwaysLoad: true,
    });
  });

  it('omits headers when not provided on http servers', () => {
    const result = buildMcpSessionContext({
      http: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });

    expect(result[0]?.transport).not.toHaveProperty('headers');
  });

  // ---------------------------------------------------------------------------
  // Exposure mode
  // ---------------------------------------------------------------------------

  it('assigns direct exposure mode to all resolved servers', () => {
    const result = buildMcpSessionContext({
      a: { command: 'mcp-a' },
      b: { type: 'sse', url: 'https://b.example.com/sse' },
      c: { type: 'http', url: 'https://c.example.com/mcp' },
    });

    for (const server of result) {
      expect(server.exposureMode).toBe('direct');
    }
  });

  // ---------------------------------------------------------------------------
  // Multiple servers — ordering and naming
  // ---------------------------------------------------------------------------

  it('preserves server names as keys', () => {
    const result = buildMcpSessionContext({
      alpha: { command: 'alpha-mcp' },
      beta: { type: 'http', url: 'https://beta.example.com/mcp' },
    });

    const names = result.map((s) => s.name);
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('handles a record with a single entry', () => {
    const result = buildMcpSessionContext({
      only: { command: 'only-mcp' },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('only');
  });
});

// ---------------------------------------------------------------------------
// createSdkMcpServer
// ---------------------------------------------------------------------------

describe('createSdkMcpServer', () => {
  it('returns a Claude-compatible SDK MCP server config with a live instance', () => {
    const config = createSdkMcpServer({ name: 'my-server' });

    expect(config.type).toBe('sdk');
    expect(config.name).toBe('my-server');
    expect(typeof config.instance.connect).toBe('function');
    expect(typeof config.instance.close).toBe('function');
  });

  it('bridges SDK MCP tools through a temporary HTTP transport', async () => {
    const config = createSdkMcpServer({
      name: 'local-tools',
      tools: [
        {
          name: 'echo',
          description: 'Echo text',
          inputSchema: { text: z.string() },
          handler: async ({ text }) => ({ content: [{ type: 'text', text }] }),
        },
      ],
    });

    const prepared = await prepareMcpServersForSession({ local: config });
    let client: Client | undefined;

    try {
      const server = prepared.servers.local;
      if (!server || server.type !== 'http') {
        throw new Error('Expected prepared SDK MCP server to become an HTTP transport');
      }

      client = new Client({ name: 'agent-sdk-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(server.url));

      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('echo');

      const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    } finally {
      await client?.close().catch(() => undefined);
      await prepared.close();
    }
  });
});
