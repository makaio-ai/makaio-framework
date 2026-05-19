import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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

type McpConfigResult = { config: string; hasBridge: boolean } | undefined;

/**
 * Invoke the private MCP config builder without weakening test types.
 * @param session - Session under test
 * @param sessionIdForMcp - Adapter session ID for MCP routing
 * @param env - Environment expected in MCP context overrides
 * @returns MCP config result
 */
function registerMcpContextForTest(
  session: ClaudeCliSession,
  sessionIdForMcp: string,
  env: Record<string, string>,
): Promise<McpConfigResult> {
  const register = Reflect.get(session, 'registerMcpContextAndBuildConfig') as (
    sessionIdForMcp: string,
    env: Record<string, string>,
  ) => Promise<McpConfigResult>;
  return register.call(session, sessionIdForMcp, env);
}

/**
 * Invoke the private execution-context resolver without `any` casts.
 * @param session - Session under test
 * @returns Turn execution context
 */
function resolveAndPersistTurnExecutionContextForTest(
  session: ClaudeCliSession,
): Promise<{ env: Record<string, string>; binaryPath?: string }> {
  const resolveContext = Reflect.get(session, 'resolveAndPersistTurnExecutionContext') as () => Promise<{
    env: Record<string, string>;
    binaryPath?: string;
  }>;
  return resolveContext.call(session);
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

  it('returns a config with the makaio entry when the bridge handler is registered', async () => {
    const TEST_PORT = 12345;

    cleanup.push(
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: TEST_PORT });
      }),
    );

    const session = makeSession({ makaioSessionId: 'makaio-session-1' });
    const sessionIdForMcp = 'adapter-session-1';

    const result = expectMcpConfig(await registerMcpContextForTest(session, sessionIdForMcp, {}));

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

    const result = await registerMcpContextForTest(session, 'adapter-session-2', {});

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

    const result = expectMcpConfig(await registerMcpContextForTest(session, 'adapter-session-3', {}));

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

    const result = expectMcpConfig(await registerMcpContextForTest(session, sessionIdForMcp, {}));

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

    await registerMcpContextForTest(session, sessionIdForMcp, { SOME_VAR: 'fresh-value' });

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
  });

  it('persists freshly resolved execution context for each turn', async () => {
    let calls = 0;
    const session = makeSession({
      env: { STALE_VAR: 'stale' },
      binaryPath: '/stale/claude',
      resolveTurnExecutionContext: async () => {
        calls += 1;
        return calls === 1
          ? { env: { TURN_ENV: 'first' }, binaryPath: '/managed/first/claude' }
          : { env: { TURN_ENV: 'second' }, binaryPath: '/managed/second/claude' };
      },
    });

    const first = await resolveAndPersistTurnExecutionContextForTest(session);
    const second = await resolveAndPersistTurnExecutionContextForTest(session);
    const config = Reflect.get(session, 'config') as { env: Record<string, string>; binaryPath?: string };

    expect(first).toEqual({ env: { TURN_ENV: 'first' }, binaryPath: '/managed/first/claude' });
    expect(second).toEqual({ env: { TURN_ENV: 'second' }, binaryPath: '/managed/second/claude' });
    expect(config.env).toEqual({ TURN_ENV: 'second' });
    expect(config.binaryPath).toBe('/managed/second/claude');
  });
});
