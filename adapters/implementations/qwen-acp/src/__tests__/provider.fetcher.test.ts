import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';
import type { Client } from '@agentclientprotocol/sdk';

const mockCreateAcpConnection = vi.hoisted(() => vi.fn());

vi.mock('@makaio/ai-adapters-acp-client', async () => {
  const actual = await vi.importActual<typeof import('@makaio/ai-adapters-acp-client')>(
    '@makaio/ai-adapters-acp-client',
  );
  return {
    ...actual,
    createAcpConnection: mockCreateAcpConnection,
  };
});

import { fetchModels } from '../provider.fetcher.js';

function makeDiscoveryHandle(): AcpConnectionHandle {
  return {
    // @ts-expect-error -- partial platform shim; ClientSideConnection has private fields and many more members not needed here
    connection: {
      initialize: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({
        models: {
          availableModels: [],
        },
      }),
    },
    kill: vi.fn(),
    exited: Promise.resolve(0),
  };
}

describe('fetchModels', () => {
  beforeEach(() => {
    mockCreateAcpConnection.mockReset();
  });

  it('creates a noop ACP client that matches the advertised discovery capabilities', async () => {
    const handle = makeDiscoveryHandle();
    let client: Client | undefined;
    mockCreateAcpConnection.mockImplementation(async (factory, options) => {
      client = factory({} as never);
      expect(options).toMatchObject({
        command: 'qwen',
        args: ['--acp'],
      });
      return handle;
    });

    await fetchModels({} as never);

    expect(client).toMatchObject({
      sessionUpdate: expect.any(Function),
      requestPermission: expect.any(Function),
      readTextFile: expect.any(Function),
      writeTextFile: expect.any(Function),
      createTerminal: expect.any(Function),
      terminalOutput: expect.any(Function),
      waitForTerminalExit: expect.any(Function),
      killTerminal: expect.any(Function),
      releaseTerminal: expect.any(Function),
    });
    expect(handle.connection.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }),
    );
  });
});
