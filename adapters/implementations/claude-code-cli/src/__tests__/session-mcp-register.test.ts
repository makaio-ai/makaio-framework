import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import type { CallContext } from '@makaio/contracts';
import { createTestBusInstance, createTestCall, makeStubExtensionBus } from '@makaio/test-utils';
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
    globalBus: MakaioBus,
    adapterId: 'test-adapter',
    adapterName: 'claude-code-cli',
    agentId: 'test-agent',
    cwd: '/tmp',
    model: 'claude-sonnet',
    env: {},
    contextEnv: {},
    ...overrides,
  });
}

type McpConfigResult = { config: string; hasBridge: boolean } | undefined;

/**
 * Invoke the private MCP config builder without weakening test types.
 * @param session - Session under test
 * @param sessionIdForMcp - Adapter session ID for MCP routing
 * @param call - Minted call driving registration
 * @returns MCP config result
 */
function registerMcpContextForTest(
  session: ClaudeCliSession,
  sessionIdForMcp: string,
  call = createTestCall(),
): Promise<McpConfigResult> {
  const register = Reflect.get(session, 'registerMcpContextAndBuildConfig') as (
    call: CallContext,
    sessionIdForMcp: string,
  ) => Promise<McpConfigResult>;
  return register.call(session, call, sessionIdForMcp);
}

/**
 * Assert an optional MCP config result is present and return the narrowed value.
 * @param result - Optional MCP config result
 * @returns Defined MCP config result
 */
function expectMcpConfig(result: McpConfigResult): Exclude<McpConfigResult, undefined> {
  expect(result).toBeDefined();
  if (result === undefined) throw new Error('Expected MCP config result to be defined');
  return result;
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

  it('registers through the adapter carrier and preserves the principal', async () => {
    const carrierBus = makeStubExtensionBus(createTestBusInstance(), 'claude-code-cli');
    const call = createTestCall({ principal: { kind: 'makaio.host', id: 'requesting-host' } });
    const observed = vi.fn();
    cleanup.push(
      carrierBus.on(McpSubjects.session.register, (ctx) => {
        observed(ctx.call.caller, ctx.call.principal);
        ctx.setResult({ port: 12345 });
      }),
    );

    await registerMcpContextForTest(makeSession({ globalBus: carrierBus }), 'adapter-session', call);

    expect(observed).toHaveBeenCalledExactlyOnceWith(
      { kind: 'makaio.extension', id: 'claude-code-cli' },
      call.principal,
    );
  });

  it.each(['explicit stop context', 'session close'])('unregisters through the adapter carrier on %s', async (path) => {
    const carrierBus = makeStubExtensionBus(createTestBusInstance(), 'claude-code-cli');
    const stopCall = carrierBus.own('stop');
    const observed = vi.fn();
    const session = makeSession({ globalBus: carrierBus });
    cleanup.push(
      carrierBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: 12345 });
      }),
      carrierBus.on(McpSubjects.session.unregister, (ctx) => {
        observed(ctx.payload.adapterSessionId, ctx.call.caller, ctx.call.principal);
        ctx.setResult({});
      }),
    );
    expectMcpConfig(await registerMcpContextForTest(session, 'adapter-session'));

    if (path === 'session close') {
      await session.close();
    } else {
      const unregister = Reflect.get(session, 'unregisterMcpSession') as (call: CallContext) => void;
      unregister.call(session, stopCall);
    }

    await vi.waitFor(() =>
      expect(observed).toHaveBeenCalledExactlyOnceWith('adapter-session', stopCall.caller, stopCall.principal),
    );
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

    const result = expectMcpConfig(await registerMcpContextForTest(session, sessionIdForMcp));

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

    const result = await registerMcpContextForTest(session, 'adapter-session-2');

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

    const result = expectMcpConfig(await registerMcpContextForTest(session, 'adapter-session-3'));

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

    const result = expectMcpConfig(await registerMcpContextForTest(session, sessionIdForMcp));

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
      env: {
        SOME_VAR: 'connector-value',
        ANTHROPIC_API_KEY: 'selected-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'opposing-secret',
      },
      contextEnv: { SOME_VAR: 'fresh-value' },
      makaioSessionId: 'makaio-session-payload',
    });

    const sessionIdForMcp = 'adapter-session-payload';

    await registerMcpContextForTest(session, sessionIdForMcp);

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
        env: { SOME_VAR: 'fresh-value' },
        sessionId: 'makaio-session-payload',
        agentId: 'agent-xyz',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('selected-secret');
    expect(JSON.stringify(payload)).not.toContain('opposing-secret');
    expect(JSON.stringify(payload)).not.toContain('CLAUDE_CONFIG_DIR');
  });
});
