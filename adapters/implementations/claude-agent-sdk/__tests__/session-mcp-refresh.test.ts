import { describe, expect, it, vi } from 'vitest';
import { ClaudeConnectorSession } from '../src/session.js';

describe('ClaudeConnectorSession MCP refresh', () => {
  it('pushes refreshed MCP servers into the live query', async () => {
    const session = new ClaudeConnectorSession({
      bus: {} as never,
      adapterId: 'adapter-id',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-id',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      providerConfig: {
        queryOptions: {
          mcpServers: {
            existing: {
              type: 'http',
              url: 'http://localhost:8123/mcp',
            },
          },
        },
      },
      mcpServerPort: 9010,
    });

    const setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: {} }));
    session.injectQueryInstance({ setMcpServers });

    await session.updateMcpServers([
      {
        name: 'github',
        exposureMode: 'direct',
        transport: {
          type: 'http',
          url: 'https://example.com/mcp',
        },
      },
    ]);

    expect(setMcpServers).toHaveBeenCalledWith({
      existing: {
        type: 'http',
        url: 'http://localhost:8123/mcp',
      },
      github: {
        type: 'http',
        url: 'https://example.com/mcp',
      },
      makaio: {
        type: 'http',
        url: 'http://localhost:9010/mcp',
      },
    });
  });
});
