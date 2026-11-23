import { describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeConnectorSession } from '../src/session.js';

describe('ClaudeConnectorSession MCP refresh', () => {
  it('pushes refreshed MCP servers into the live query', async () => {
    MakaioBus.registerNamespaces([ClaudeCodeConnectorNamespace.definition]);
    const bus = await ClaudeCodeConnectorNamespace.scopedBus(MakaioBus);
    const session = new ClaudeConnectorSession(
      {
        bus,
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
      },
      MakaioBus,
    );

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
