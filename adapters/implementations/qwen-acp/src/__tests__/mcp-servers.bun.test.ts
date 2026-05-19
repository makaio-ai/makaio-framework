/**
 * Tests for the Makaio → ACP MCP server converter.
 *
 * Verifies that each transport type (stdio, sse, http) is correctly
 * mapped from the Makaio `McpResolvedServer` shape to the ACP `McpServer`
 * shape, including the Record → Array conversions for env and headers.
 */

import { describe, expect, it } from 'bun:test';
import type { McpResolvedServer } from '@makaio/contracts';
import { toAcpMcpServers } from '../utils/mcp-servers.js';

describe('toAcpMcpServers', () => {
  it('returns empty array for undefined input', () => {
    expect(toAcpMcpServers(undefined)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(toAcpMcpServers([])).toEqual([]);
  });

  it('converts stdio transport with all fields', () => {
    const server: McpResolvedServer = {
      name: 'my-stdio-server',
      transport: {
        type: 'stdio',
        command: '/usr/bin/server',
        args: ['--port', '3000'],
        env: { API_KEY: 'secret', NODE_ENV: 'production' },
      },
      exposureMode: 'direct',
    };

    const [result] = toAcpMcpServers([server]);

    expect(result).toEqual({
      name: 'my-stdio-server',
      command: '/usr/bin/server',
      args: ['--port', '3000'],
      env: [
        { name: 'API_KEY', value: 'secret' },
        { name: 'NODE_ENV', value: 'production' },
      ],
    });
  });

  it('converts stdio transport with minimal fields', () => {
    const server: McpResolvedServer = {
      name: 'minimal-stdio',
      transport: { type: 'stdio', command: 'server' },
      exposureMode: 'discovery',
    };

    const [result] = toAcpMcpServers([server]);

    expect(result).toEqual({
      name: 'minimal-stdio',
      command: 'server',
      args: [],
      env: [],
    });
  });

  it('converts http transport', () => {
    const server: McpResolvedServer = {
      name: 'my-http-server',
      transport: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token123' },
      },
      exposureMode: 'direct',
    };

    const [result] = toAcpMcpServers([server]);

    expect(result).toEqual({
      type: 'http',
      name: 'my-http-server',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer token123' }],
    });
  });

  it('converts sse transport', () => {
    const server: McpResolvedServer = {
      name: 'my-sse-server',
      transport: { type: 'sse', url: 'https://example.com/sse' },
      exposureMode: 'direct',
    };

    const [result] = toAcpMcpServers([server]);

    expect(result).toEqual({
      type: 'sse',
      name: 'my-sse-server',
      url: 'https://example.com/sse',
      headers: [],
    });
  });

  it('converts multiple servers', () => {
    const servers: McpResolvedServer[] = [
      { name: 'a', transport: { type: 'stdio', command: 'a' }, exposureMode: 'direct' },
      { name: 'b', transport: { type: 'http', url: 'https://b.com' }, exposureMode: 'discovery' },
    ];

    const result = toAcpMcpServers(servers);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('command', 'a');
    expect(result[1]).toHaveProperty('type', 'http');
  });
});
