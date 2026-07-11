/** Connector consumption tests for centrally prepared Claude CLI runtime config. */

import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type ClientExecutionContext } from '@makaio/contracts/client';
import { ClaudeCodeCliConnectorNamespace, type ClaudeCodeCliConnectorBus } from '../namespace/index.js';
import { ClaudeCliConnector } from '../connector.js';
import { ClaudeCodeCliProviderConfigSchema } from '../schemas.js';

interface TestSessionConfig {
  readonly binaryPath?: string;
  readonly env: Record<string, string>;
  readonly allowedTools?: string[];
  readonly disallowedTools?: string[];
}

type TestProviderConfig = NonNullable<ConstructorParameters<typeof ClaudeCliConnector>[0]['providerConfig']> & {
  baseUrl?: string;
};

/**
 * Read the connector-owned session config after initialization.
 * @param connector - Initialized Claude CLI connector
 * @returns Connector-owned session config when initialization created one
 */
function getSessionConfig(connector: ClaudeCliConnector): TestSessionConfig | undefined {
  const session = Reflect.get(connector, 'session') as { config?: TestSessionConfig } | undefined;
  return session?.config;
}

/**
 * Build one client execution context for binary-consumption assertions.
 * @param binaryPath - Exact managed path, or null for global discovery
 * @returns Central client execution selection
 */
function execution(binaryPath: string | null): ClientExecutionContext {
  return {
    binaryPath,
    env: {},
    configDir: null,
    source: binaryPath === null ? 'global' : 'managed',
    version: null,
  };
}

/**
 * Create a connector whose auth environment and binary were finalized centrally.
 * @param options - Finalized runtime inputs supplied to the connector
 * @returns Configured Claude CLI connector
 */
async function makeConnector(
  options: {
    env?: Record<string, string>;
    clientExecution?: ClientExecutionContext;
    baseUrl?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
  } = {},
): Promise<ClaudeCliConnector> {
  const bus = (await ClaudeCodeCliConnectorNamespace.scopedBus()) as ClaudeCodeCliConnectorBus;
  const providerConfig: TestProviderConfig | undefined =
    options.baseUrl === undefined ? undefined : { baseUrl: options.baseUrl };
  return new ClaudeCliConnector({
    bus,
    adapterId: 'test-adapter',
    adapterName: 'claude-code-cli',
    agentId: 'test-agent',
    cwd: os.tmpdir(),
    model: 'claude-sonnet',
    env: options.env ?? {},
    clientExecution: options.clientExecution,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    providerConfig,
  });
}

describe('ClaudeCliConnector — central runtime config', () => {
  const connectors: ClaudeCliConnector[] = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await Promise.all(connectors.splice(0).map((connector) => connector.close()));
    MakaioBus.__resetHandlers?.();
  });

  it('passes the centrally selected managed binary and lease environment once', async () => {
    const connector = await makeConnector({
      env: { CLAUDE_CONFIG_DIR: '/isolated/claude' },
      clientExecution: execution('/managed/bin/claude'),
    });
    connectors.push(connector);

    await connector.initialize();

    expect(getSessionConfig(connector)).toMatchObject({
      binaryPath: '/managed/bin/claude',
      env: { CLAUDE_CONFIG_DIR: '/isolated/claude' },
    });
    expect(getSessionConfig(connector)).not.toHaveProperty('resolveTurnExecutionContext');
  });

  it('uses PATH when the central binary selection is global', async () => {
    const connector = await makeConnector({ clientExecution: execution(null) });
    connectors.push(connector);

    await connector.initialize();

    expect(getSessionConfig(connector)?.binaryPath).toBeUndefined();
  });

  it('rejects the removed provider-level binary override', () => {
    expect(ClaudeCodeCliProviderConfigSchema.safeParse({ binaryPath: '/legacy/bin/claude' }).success).toBe(false);
  });

  it('uses only the selected API-key delivery and endpoint', async () => {
    const connector = await makeConnector({
      env: { ANTHROPIC_API_KEY: 'api-secret' },
      baseUrl: 'https://gateway.example.test/anthropic',
    });
    connectors.push(connector);

    await connector.initialize();

    expect(getSessionConfig(connector)?.env).toEqual({
      ANTHROPIC_API_KEY: 'api-secret',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
    });
    expect(getSessionConfig(connector)?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('uses only the selected explicit OAuth-token delivery', async () => {
    const connector = await makeConnector({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' } });
    connectors.push(connector);

    await connector.initialize();

    expect(getSessionConfig(connector)?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' });
    expect(getSessionConfig(connector)?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('preserves inferred native state without explicit auth variables', async () => {
    const connector = await makeConnector({ env: { CLAUDE_CONFIG_DIR: '/native/claude' } });
    connectors.push(connector);

    await connector.initialize();

    expect(getSessionConfig(connector)?.env).toEqual({ CLAUDE_CONFIG_DIR: '/native/claude' });
    expect(getSessionConfig(connector)?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(getSessionConfig(connector)?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('does not resolve the client binary again inside the connector', async () => {
    const resolveBinary = vi.fn();
    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      resolveBinary();
      ctx.setResult(execution('/unexpected/bin/claude'));
    });
    const connector = await makeConnector({ clientExecution: execution('/selected/bin/claude') });
    connectors.push(connector);

    await connector.initialize();
    cleanup();

    expect(resolveBinary).not.toHaveBeenCalled();
    expect(getSessionConfig(connector)?.binaryPath).toBe('/selected/bin/claude');
  });

  it('passes tool policy lists into the session config', async () => {
    const connector = await makeConnector({
      allowedTools: ['Bash(git status)', 'Edit'],
      disallowedTools: ['WebSearch'],
    });
    connectors.push(connector);

    await connector.initialize();

    expect(getSessionConfig(connector)?.allowedTools).toEqual(['Bash(git status)', 'Edit']);
    expect(getSessionConfig(connector)?.disallowedTools).toEqual(['WebSearch']);
  });
});
