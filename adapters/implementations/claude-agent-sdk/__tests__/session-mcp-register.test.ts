import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import { ClaudeConnectorSession } from '../src/session.js';
import { McpSessionRegistration } from '../src/mcp-session-bridge.js';

/**
 * Minimal ClaudeSessionConfig factory for MCP registration tests.
 *
 * Avoids spinning up a real SDK query or subprocess — the tests only exercise
 * the bus RPC handshake through the typed MCP test seam.
 * @param overrides - Partial config overrides
 */
function makeSession(overrides: Partial<ConstructorParameters<typeof ClaudeConnectorSession>[0]> = {}) {
  return new ClaudeConnectorSession({
    bus: {} as never,
    adapterId: 'test-adapter',
    adapterName: 'claude-agent-sdk',
    agentId: 'test-agent',
    cwd: '/tmp',
    model: 'claude-sonnet',
    env: {},
    contextEnv: {},
    ...overrides,
  });
}

describe('ClaudeConnectorSession — MCP bus registration', () => {
  let cleanup: Array<() => void>;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanup = [];
  });

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('stores the port returned by the mcp.session.register handler and uses it in setMcpServers', async () => {
    const TEST_PORT = 12345;

    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: TEST_PORT });
      }),
    );

    const setMcpServersSpy: Array<Record<string, unknown>> = [];
    const session = makeSession({ sessionId: 'makaio-session-1' });

    session.injectQueryInstance({
      setMcpServers: async (servers) => {
        setMcpServersSpy.push(servers as Record<string, unknown>);
        return { added: [], removed: [], errors: {} };
      },
    });

    await session.syncMcpContextForTest('adapter-session-1');

    // After registration the port is known; updateMcpServers must include the
    // makaio HTTP MCP proxy entry pointing at the registered port.
    await session.updateMcpServers([]);

    expect(setMcpServersSpy).toHaveLength(1);
    expect(setMcpServersSpy[0]).toMatchObject({
      makaio: {
        type: 'http',
        url: `http://localhost:${TEST_PORT}/mcp`,
      },
    });
  });

  it('does not add the makaio entry when no handler is registered (graceful degradation)', async () => {
    // No handler registered — requestOptional returns { handled: false }.
    const setMcpServersSpy: Array<Record<string, unknown>> = [];

    const session = makeSession({ sessionId: 'makaio-session-2' });
    session.injectQueryInstance({
      setMcpServers: async (servers) => {
        setMcpServersSpy.push(servers as Record<string, unknown>);
        return { added: [], removed: [], errors: {} };
      },
    });

    await expect(session.syncMcpContextForTest('adapter-session-2')).resolves.not.toThrow();

    // Port was not set, so no port change → refreshMcpContext would not call
    // updateMcpServers. Calling it manually confirms port is absent.
    await session.updateMcpServers([]);

    expect(setMcpServersSpy).toHaveLength(1);
    expect(setMcpServersSpy[0]).not.toHaveProperty('makaio');
  });

  it('ignores an out-of-order register response after unregister', async () => {
    // register() writes registeredSessionId before its RPC await; a concurrent
    // unregister() supersedes the registration while the RPC is in flight. The
    // late response must not resurrect the superseded registration's port.
    const SEEDED_PORT = 4100;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, async (ctx) => {
        await gate;
        ctx.setResult({ port: 23456 });
      }),
    );

    const registration = new McpSessionRegistration({
      bus: {} as never,
      adapterId: 'test-adapter',
      adapterName: 'claude-agent-sdk',
      agentId: 'test-agent',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      contextEnv: {},
      sessionId: 'makaio-session-race',
      mcpServerPort: SEEDED_PORT,
    });

    const pending = registration.register('adapter-session-race');
    registration.unregister();
    release();

    await expect(pending).resolves.toBe(false);
    expect(registration.isRegistered).toBe(false);
    expect(registration.serverPort).toBe(SEEDED_PORT);
  });

  it('skips registration when sessionId is not set', async () => {
    const handlerCalls: unknown[] = [];

    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        handlerCalls.push(ctx.payload);
        ctx.setResult({ port: 9999 });
      }),
    );

    // Session with no sessionId at all (sessionId remains undefined).
    const session = makeSession();

    await session.syncMcpContextForTest();

    expect(handlerCalls).toHaveLength(0);
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
      sessionId: 'makaio-session-payload',
      agentId: 'agent-xyz',
      adapterId: 'adapter-abc',
      adapterName: 'claude-agent-sdk',
      cwd: '/workspace',
      env: {
        SOME_VAR: 'connector-value',
        ANTHROPIC_API_KEY: 'selected-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'opposing-secret',
      },
      contextEnv: { SOME_VAR: 'value' },
    });

    session.injectQueryInstance({
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    });

    await session.syncMcpContextForTest('adapter-session-payload');

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      adapterSessionId: 'adapter-session-payload',
      agentId: 'agent-xyz',
      adapterId: 'adapter-abc',
      adapterName: 'claude-agent-sdk',
      sessionId: 'makaio-session-payload',
      contextOverrides: {
        cwd: '/workspace',
        env: { SOME_VAR: 'value' },
        sessionId: 'makaio-session-payload',
        agentId: 'agent-xyz',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('selected-secret');
    expect(JSON.stringify(payload)).not.toContain('opposing-secret');
    expect(JSON.stringify(payload)).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('refreshMcpContext triggers setMcpServers when port changes', async () => {
    const TEST_PORT = 7777;

    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: TEST_PORT });
      }),
    );

    const setMcpServersSpy: Array<Record<string, unknown>> = [];
    const session = makeSession({ sessionId: 'makaio-session-refresh' });

    session.injectQueryInstance({
      setMcpServers: async (servers) => {
        setMcpServersSpy.push(servers as Record<string, unknown>);
        return { added: [], removed: [], errors: {} };
      },
    });

    await session.syncMcpContextForTest('adapter-session-refresh', 'refresh');

    // setMcpServers must have been called exactly once by refreshMcpContext.
    expect(setMcpServersSpy).toHaveLength(1);
    expect(setMcpServersSpy[0]).toMatchObject({
      makaio: {
        type: 'http',
        url: `http://localhost:${TEST_PORT}/mcp`,
      },
    });
  });
});
