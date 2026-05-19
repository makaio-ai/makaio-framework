import { describe, expect, it } from 'bun:test';
import { ModelRegistryPublicSubjects } from '@makaio/contracts/model-registry';
import { createMockBus, createTestBusInstance } from '@makaio/test-utils';
import { accountInfo, mcpServerStatus, supportedCommands, supportedModels } from '../../src/shared/introspection.js';

// ---------------------------------------------------------------------------
// supportedModels
// ---------------------------------------------------------------------------

describe('supportedModels', () => {
  it('requests SDK-safe supported models from the contracts model-registry subject', async () => {
    const bus = createTestBusInstance();
    bus.on(ModelRegistryPublicSubjects.supportedModels, (ctx) => {
      ctx.setResult({
        models: [
          {
            name: 'claude-sonnet-4-6',
            friendlyName: 'Claude Sonnet 4.6',
            contextWindowSize: 200_000,
            provider: 'anthropic',
          },
          {
            name: 'anthropic/claude-sonnet-4-6',
            friendlyName: 'Claude Sonnet 4.6',
            contextWindowSize: 200_000,
            provider: 'openrouter',
          },
        ],
      });
    });

    await expect(supportedModels(bus)).resolves.toEqual([
      {
        name: 'claude-sonnet-4-6',
        friendlyName: 'Claude Sonnet 4.6',
        contextWindowSize: 200_000,
        provider: 'anthropic',
      },
      {
        name: 'anthropic/claude-sonnet-4-6',
        friendlyName: 'Claude Sonnet 4.6',
        contextWindowSize: 200_000,
        provider: 'openrouter',
      },
    ]);
  });

  it('returns an empty list when the public model-registry subject has no handler', async () => {
    const { bus, requestOptional } = createMockBus();
    requestOptional.mockResolvedValue({ handled: false });

    await expect(supportedModels(bus)).resolves.toEqual([]);
    expect(requestOptional).toHaveBeenCalledWith(ModelRegistryPublicSubjects.supportedModels, {});
  });
});

// ---------------------------------------------------------------------------
// mcpServerStatus
// ---------------------------------------------------------------------------

describe('mcpServerStatus', () => {
  it('returns an empty array when no sessionId is provided', async () => {
    const { bus, request } = createMockBus();

    const result = await mcpServerStatus(bus);

    expect(result).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('returns an empty array when sessionId is undefined', async () => {
    const { bus } = createMockBus();

    const result = await mcpServerStatus(bus, undefined);

    expect(result).toEqual([]);
  });

  it('calls mcp.session.resolve with the provided sessionId', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      sessionId: 'session-1',
      projectId: null,
      profileId: null,
      servers: [],
      directTools: [],
      discoverableTools: [],
    });

    await mcpServerStatus(bus, 'session-1');

    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'session-1', profileId: null, projectId: null }),
    );
  });

  it('maps resolved servers to McpServerStatus with status configured', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      sessionId: 'session-1',
      projectId: null,
      profileId: null,
      servers: [
        {
          name: 'github',
          transport: { type: 'stdio', command: 'npx', args: ['-y', '@github/mcp'] },
          exposureMode: 'direct',
        },
        {
          name: 'filesystem',
          transport: { type: 'stdio', command: 'npx', args: ['-y', '@filesystem/mcp'] },
          exposureMode: 'discovery',
        },
      ],
      directTools: [],
      discoverableTools: [],
    });

    const result = await mcpServerStatus(bus, 'session-1');

    expect(result).toEqual([
      { name: 'github', status: 'configured' },
      { name: 'filesystem', status: 'configured' },
    ]);
  });

  it('returns an empty array when the session has no configured servers', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      sessionId: 'session-1',
      projectId: null,
      profileId: null,
      servers: [],
      directTools: [],
      discoverableTools: [],
    });

    const result = await mcpServerStatus(bus, 'session-1');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// accountInfo
// ---------------------------------------------------------------------------

describe('accountInfo', () => {
  it('returns provider unknown when no adapterName is provided', async () => {
    const { bus } = createMockBus();

    const result = await accountInfo(bus);

    expect(result).toEqual({ provider: 'unknown' });
  });

  it('returns the provided adapterName as the provider', async () => {
    const { bus } = createMockBus();

    const result = await accountInfo(bus, 'anthropic-sdk');

    expect(result).toEqual({ provider: 'anthropic-sdk' });
  });

  it('does not call bus.request (best-effort stub)', async () => {
    const { bus, request } = createMockBus();

    await accountInfo(bus, 'openai');

    expect(request).not.toHaveBeenCalled();
  });

  it('omits email from the returned AccountInfo', async () => {
    const { bus } = createMockBus();

    const result = await accountInfo(bus, 'anthropic-sdk');

    expect(result).not.toHaveProperty('email');
  });
});

// ---------------------------------------------------------------------------
// supportedCommands
// ---------------------------------------------------------------------------

describe('supportedCommands', () => {
  it('returns an empty array (Makaio has no slash commands in SDK context)', () => {
    const result = supportedCommands();

    expect(result).toEqual([]);
  });

  it('is a synchronous function that does not require a bus', () => {
    // The function signature takes no arguments — verify it can be called directly.
    expect(() => supportedCommands()).not.toThrow();
  });
});
