/** Connector consumption tests for centrally prepared Claude runtime config. */

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type ClientExecutionContext } from '@makaio/contracts/client';
import type { OptionalResult } from '@makaio/core';
import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import { ClaudeSdkConnector } from '../connector.js';
import type { ClaudeAgentConfig } from '../types/index.js';

const capturedOptions: Options[] = [];

const queryHarness = vi.hoisted(() => ({
  query: vi.fn((opts: { prompt: unknown; options: Options }) => {
    capturedOptions.push(opts.options);
    return {
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(() => undefined),
      setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator]() {
        // Initialization does not consume messages.
      },
    };
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query: queryHarness.query,
}));

type TestProviderConfig = ClaudeAgentConfig['providerConfig'] & { baseUrl?: string };

/**
 * Build a connector whose environment and binary were already finalized centrally.
 * @param options - Optional prepared environment, client execution, and provider config.
 * @returns Connector configured for one central-runtime assertion.
 */
async function makeConnector(
  options: {
    env?: Record<string, string>;
    clientExecution?: ClientExecutionContext;
    providerConfig?: TestProviderConfig;
  } = {},
): Promise<ClaudeSdkConnector> {
  const bus = await ClaudeCodeConnectorNamespace.scopedBus();
  return new ClaudeSdkConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'claude-agent-sdk',
    agentId: 'agent-test',
    cwd: os.tmpdir(),
    model: 'claude-sonnet-4-20250514',
    env: options.env ?? {},
    clientExecution: options.clientExecution,
    providerConfig: options.providerConfig,
    clientId: 'claude-code',
    requestSessionAccountObservation: async (): Promise<OptionalResult<never>> => ({ handled: false }),
  });
}

/**
 * Build one client execution context for binary-consumption assertions.
 * @param binaryPath - Exact selected path, or `null` for SDK-managed discovery.
 * @param source - Resolution source owning the selected path.
 * @returns Client execution context matching the selected source.
 */
function execution(
  binaryPath: string | null,
  source: ClientExecutionContext['source'] = binaryPath === null ? 'global' : 'managed',
): ClientExecutionContext {
  return {
    binaryPath,
    env: {},
    configDir: null,
    source,
    version: null,
  };
}

describe('ClaudeSdkConnector — central runtime config', () => {
  const connectors: ClaudeSdkConnector[] = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    capturedOptions.length = 0;
    queryHarness.query.mockClear();
  });

  afterEach(async () => {
    await Promise.all(connectors.splice(0).map((connector) => connector.close()));
    MakaioBus.__resetHandlers?.();
  });

  it('uses the centrally selected managed binary and lease environment', async () => {
    const connector = await makeConnector({
      env: { CLAUDE_CONFIG_DIR: '/isolated/claude' },
      clientExecution: execution('/managed/bin/claude'),
    });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe('/managed/bin/claude');
    expect(capturedOptions[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: '/isolated/claude' });
  });

  it('uses the exact host-global executable selected by the central resolver', async () => {
    const hostBinaryPath = path.resolve(os.tmpdir(), 'makaio-host-global', 'claude');
    const connector = await makeConnector({
      clientExecution: execution(hostBinaryPath, 'global'),
    });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe(hostBinaryPath);
  });

  it('uses the exact image-local executable selected by container global-only resolution', async () => {
    const connector = await makeConnector({
      clientExecution: execution('/opt/makaio/bin/claude', 'global'),
    });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe('/opt/makaio/bin/claude');
  });

  it('uses SDK-managed discovery and suppresses a legacy query path when central selection is null', async () => {
    const connector = await makeConnector({
      clientExecution: execution(null),
      providerConfig: { queryOptions: { pathToClaudeCodeExecutable: '/legacy/bin/claude' } },
    });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('keeps the central managed binary authoritative over query options', async () => {
    const connector = await makeConnector({
      clientExecution: execution('/managed/bin/claude'),
      providerConfig: { queryOptions: { pathToClaudeCodeExecutable: '/user/bin/claude' } },
    });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe('/managed/bin/claude');
  });

  it('uses only the selected API-key delivery and resolved endpoint', async () => {
    const connector = await makeConnector({
      env: { ANTHROPIC_API_KEY: 'api-secret' },
      providerConfig: { baseUrl: 'https://gateway.example.test/anthropic' },
    });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.env).toMatchObject({
      ANTHROPIC_API_KEY: 'api-secret',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
    });
    expect(capturedOptions[0]?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('uses only the selected explicit OAuth-token delivery', async () => {
    const connector = await makeConnector({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' } });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' });
    expect(capturedOptions[0]?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('preserves inferred native state without explicit auth variables', async () => {
    const connector = await makeConnector({ env: { CLAUDE_CONFIG_DIR: '/native/claude' } });
    connectors.push(connector);

    await connector.initialize();

    expect(capturedOptions[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: '/native/claude' });
    expect(capturedOptions[0]?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(capturedOptions[0]?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
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
    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe('/selected/bin/claude');
  });
});
