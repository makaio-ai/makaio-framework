import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import { ClaudeCliSession } from '../session.js';

/**
 * Minimal ClaudeCliSessionConfig factory for MCP registration tests.
 *
 * Avoids spawning a real CLI subprocess — the tests only exercise the bus RPC
 * handshake inside `registerMcpContextAndBuildConfig()`.
 * @param overrides - Partial config overrides
 */
function makeSession(overrides: Partial<ConstructorParameters<typeof ClaudeCliSession>[0]> = {}) {
  return new ClaudeCliSession({
    bus: {} as never,
    adapterId: 'test-adapter',
    adapterName: 'claude-code-cli',
    agentId: 'test-agent',
    cwd: '/tmp',
    model: 'claude-sonnet',
    env: {},
    ...overrides,
  });
}

describe('ClaudeCliSession — MCP bus registration', () => {
  let cleanup: Array<() => void>;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanup = [];
  });

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('returns a config with the makaio entry when the bridge handler is registered', async () => {
    const TEST_PORT = 12345;

    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: TEST_PORT });
      }),
    );

    const session = makeSession({ makaioSessionId: 'makaio-session-1' });
    const sessionIdForMcp = 'adapter-session-1';

    // registerMcpContextAndBuildConfig is private; invoke via bracket-access.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (session as any).registerMcpContextAndBuildConfig(sessionIdForMcp);

    expect(result).toBeDefined();
    expect(result.hasBridge).toBe(true);

    const parsed = JSON.parse(result.config) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers).toHaveProperty('makaio', {
      type: 'http',
      url: `http://127.0.0.1:${TEST_PORT}/mcp?adapterSessionId=${encodeURIComponent(sessionIdForMcp)}`,
    });
  });

  it('returns undefined when no handler is registered and no upstream servers are present', async () => {
    // No handler and no upstream servers — graceful degradation: return undefined.
    const session = makeSession();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (session as any).registerMcpContextAndBuildConfig('adapter-session-2');

    expect(result).toBeUndefined();
  });

  it('returns upstream-only config when no handler is registered but upstream servers exist', async () => {
    // No bridge handler, but upstream servers should still appear in the config.
    const session = makeSession({
      mcpUpstreamServers: [
        {
          name: 'github',
          exposureMode: 'direct',
          transport: { type: 'http', url: 'https://example.com/mcp' },
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (session as any).registerMcpContextAndBuildConfig('adapter-session-3');

    expect(result).toBeDefined();
    expect(result.hasBridge).toBe(false);

    const parsed = JSON.parse(result.config) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers).toHaveProperty('github', {
      type: 'http',
      url: 'https://example.com/mcp',
    });
    expect(parsed.mcpServers).not.toHaveProperty('makaio');
  });

  it('merges upstream servers with the makaio entry when the bridge is available', async () => {
    const TEST_PORT = 9876;

    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: TEST_PORT });
      }),
    );

    const sessionIdForMcp = 'adapter-session-4';
    const session = makeSession({
      mcpUpstreamServers: [
        {
          name: 'github',
          exposureMode: 'direct',
          transport: { type: 'http', url: 'https://example.com/mcp' },
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (session as any).registerMcpContextAndBuildConfig(sessionIdForMcp);

    expect(result).toBeDefined();
    expect(result.hasBridge).toBe(true);

    const parsed = JSON.parse(result.config) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers).toHaveProperty('github');
    expect(parsed.mcpServers).toHaveProperty('makaio', {
      type: 'http',
      url: `http://127.0.0.1:${TEST_PORT}/mcp?adapterSessionId=${encodeURIComponent(sessionIdForMcp)}`,
    });
  });

  it('sends correct registration payload to the bus handler', async () => {
    const capturedPayloads: unknown[] = [];

    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        capturedPayloads.push(ctx.payload);
        ctx.setResult({ port: 8080 });
      }),
    );

    const session = makeSession({
      agentId: 'agent-xyz',
      adapterId: 'adapter-abc',
      adapterName: 'claude-code-cli',
      cwd: '/workspace',
      env: { SOME_VAR: 'value' },
      makaioSessionId: 'makaio-session-payload',
    });

    const sessionIdForMcp = 'adapter-session-payload';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).registerMcpContextAndBuildConfig(sessionIdForMcp);

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      adapterSessionId: sessionIdForMcp,
      agentId: 'agent-xyz',
      adapterId: 'adapter-abc',
      adapterName: 'claude-code-cli',
      sessionId: 'makaio-session-payload',
      contextOverrides: {
        cwd: '/workspace',
        env: { SOME_VAR: 'value' },
        sessionId: 'makaio-session-payload',
        agentId: 'agent-xyz',
      },
    });
  });
});
