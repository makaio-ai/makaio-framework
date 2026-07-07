/**
 * Tests for `client.resolveBinary` integration in the Claude Agent SDK connector.
 *
 * Verifies that `initializeSession()` threads the resolved binary path and env
 * into the SDK query options, and that the adapter degrades gracefully when no
 * handler is registered for `client.resolveBinary`.
 *
 * Design invariants under test:
 * - When `client.resolveBinary` returns a managed context, the session env
 *   includes the resolved env vars (e.g. `CLAUDE_CONFIG_DIR`) and the SDK query
 *   options use the resolved `pathToClaudeCodeExecutable`.
 * - When `client.resolveBinary` returns a global context (binaryPath: null,
 *   empty env), neither field is set on the session.
 * - When `client.resolveBinary` has no handler (framework-only boot),
 *   the connector falls back to the default env/options and still initializes.
 */

import os from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { OptionalResult } from '@makaio/core';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { setupFixedCredentialBus } from '@makaio/ai-adapters-claude-shared/testing';

// ---------------------------------------------------------------------------
// SDK mock — captures the Options passed to each query() call so tests can
// inspect what path and env the connector resolved.
// ---------------------------------------------------------------------------

/** Captured query options from each query() invocation, in order. */
const capturedOptions: Options[] = [];

const queryHarness = vi.hoisted(() => {
  const query = vi.fn((opts: { prompt: unknown; options: Options }) => {
    capturedOptions.push(opts.options);
    return {
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(() => undefined),
      setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator]() {
        // No messages — initialization tests do not exercise turn consumption.
      },
    };
  });

  return {
    query,
    reset: () => {
      query.mockClear();
      capturedOptions.length = 0;
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query: queryHarness.query,
}));

import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import type { ClaudeCodeConnectorBus } from '../namespace/index.js';
import { ClaudeCodeAgent } from '../agent.js';
import { ClaudeSdkConnector } from '../connector.js';
import type { ClaudeAgentConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a ClaudeCodeAgent wired to a fresh connector namespace bus.
 * @param clientId - Client identifier forwarded to `client.resolveBinary`.
 * @param connectorEnv - Base environment passed to the connector.
 * @param queryOptions - Optional Claude SDK query options.
 * @returns Agent instance ready for `initialize()`.
 */
async function makeAgent(
  clientId = 'claude-code',
  connectorEnv: Record<string, string> = {},
  queryOptions?: Options,
): Promise<ClaudeCodeAgent> {
  const adapterBus = await ClaudeCodeConnectorNamespace.scopedBus();
  return new ClaudeCodeAgent({
    adapterBus,
    globalBus: MakaioBus,
    adapterId: 'adapter-test',
    adapterName: 'claude-agent-sdk',
    agentId: 'agent-test',
    cwd: os.tmpdir(),
    model: 'claude-sonnet-4-20250514',
    env: connectorEnv,
    capabilities: [],
    nativeTools: [],
    clientId,
    configFactory: async (input) => ({
      ...input,
      bus: input.bus as ClaudeCodeConnectorBus,
      cwd: input.cwd ?? os.tmpdir(),
      model: input.model ?? 'claude-sonnet-4-20250514',
      env: input.env ?? {},
      providerConfig: queryOptions !== undefined ? { queryOptions } : undefined,
    }),
    connectorFactory: (config) =>
      new ClaudeSdkConnector({
        ...(config as ClaudeAgentConfig),
        clientId: config.clientId ?? 'claude-code',
        requestSessionAccountObservation: async (): Promise<OptionalResult<never>> => ({
          handled: false,
        }),
      }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSdkConnector — client.resolveBinary integration', () => {
  let agents: ClaudeCodeAgent[];
  let cleanupHandlers: Array<() => void>;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
    agents = [];
    cleanupHandlers = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupHandlers) cleanup();
    cleanupHandlers = [];
    await Promise.all(agents.map((agent) => agent.close()));
    agents = [];
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // Managed context — binary path and env are resolved
  // -------------------------------------------------------------------------

  it('sets pathToClaudeCodeExecutable and env when resolveBinary returns a managed context', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult({
          binaryPath: '/usr/local/lib/makaio/claude-code/1.0.0/claude',
          env: { CLAUDE_CONFIG_DIR: '/usr/local/lib/makaio/profiles/default' },
          configDir: '/usr/local/lib/makaio/profiles/default',
          source: 'managed',
          version: '1.0.0',
        });
      }),
    );

    const agent = await makeAgent('claude-code');
    agents.push(agent);
    await agent.initialize();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe('/usr/local/lib/makaio/claude-code/1.0.0/claude');
    expect(capturedOptions[0]?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/usr/local/lib/makaio/profiles/default',
    });
  });

  // -------------------------------------------------------------------------
  // Global context — neither path nor env is set
  // -------------------------------------------------------------------------

  it('does not set pathToClaudeCodeExecutable when resolveBinary returns a global context', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult({
          binaryPath: null,
          env: {},
          configDir: null,
          source: 'global',
          version: null,
        });
      }),
    );

    const agent = await makeAgent('claude-code');
    agents.push(agent);
    await agent.initialize();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('does not inject env vars when resolveBinary returns a global context with empty env', async () => {
    const baseEnv = { EXISTING_VAR: 'base-value' };

    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult({
          binaryPath: null,
          env: {},
          configDir: null,
          source: 'global',
          version: null,
        });
      }),
    );

    const agent = await makeAgent('claude-code', baseEnv);
    agents.push(agent);
    await agent.initialize();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.env).toMatchObject({ EXISTING_VAR: 'base-value' });
    expect(capturedOptions[0]?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  // -------------------------------------------------------------------------
  // No handler — framework-only boot, falls back to current behaviour
  // -------------------------------------------------------------------------

  it('initializes without error when no handler is registered for client.resolveBinary', async () => {
    // No handler registered — requestOptional returns { handled: false }
    const agent = await makeAgent('claude-code');
    agents.push(agent);
    // Non-fork sessions return the locally-authoritative session ID immediately.
    await expect(agent.initialize()).resolves.toEqual(expect.any(String));

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('preserves base env when falling back without a handler', async () => {
    const baseEnv = { MY_API_KEY: 'secret' };
    const agent = await makeAgent('claude-code', baseEnv);
    agents.push(agent);
    await agent.initialize();

    expect(capturedOptions[0]?.env).toMatchObject({ MY_API_KEY: 'secret' });
  });

  it('passes Anthropic-compatible provider overrides through Claude-native env names', async () => {
    cleanupHandlers.push(setupFixedCredentialBus('opencode-secret'));
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const connector = new ClaudeSdkConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'minimax-m2.7',
      env: {
        ANTHROPIC_API_KEY: 'ambient-anthropic-secret',
        OPENCODE_GO_API_KEY: 'ambient-opencode-secret',
      },
      providerContext: {
        providerConfigId: 'test-provider-config-id',
        definitionId: 'opencode-go-anthropic',
        credentialRefs: { apiKey: CredentialRefSchema.parse('env:OPENCODE_GO_API_KEY') },
        credentialEnvVars: { apiKey: 'OPENCODE_GO_API_KEY' },
        ambientCredentialEnvVars: ['ANTHROPIC_API_KEY', 'OPENCODE_GO_API_KEY'],
        endpointOverrides: { anthropic: 'https://opencode.example.test/anthropic' },
      },
      clientId: 'claude-code',
      requestSessionAccountObservation: async (): Promise<OptionalResult<never>> => ({
        handled: false,
      }),
    });

    await connector.initialize();

    expect(capturedOptions[0]?.env).toMatchObject({
      ANTHROPIC_API_KEY: 'opencode-secret',
      ANTHROPIC_BASE_URL: 'https://opencode.example.test/anthropic',
    });
    expect(capturedOptions[0]?.env).not.toHaveProperty('OPENCODE_GO_API_KEY');
  });

  // -------------------------------------------------------------------------
  // Env merge order — resolved binary env takes precedence over credential env
  // -------------------------------------------------------------------------

  it('binary env overrides base connector env when both are present', async () => {
    // Base env has a value; resolved binary env overrides it
    const baseEnv = { CLAUDE_CONFIG_DIR: '/old/path', BASE_VAR: 'keep-me' };

    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult({
          binaryPath: '/path/to/claude',
          env: { CLAUDE_CONFIG_DIR: '/new/managed/path' },
          configDir: '/new/managed/path',
          source: 'managed',
          version: '1.2.3',
        });
      }),
    );

    const agent = await makeAgent('claude-code', baseEnv);
    agents.push(agent);
    await agent.initialize();

    expect(capturedOptions[0]?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/new/managed/path',
      BASE_VAR: 'keep-me',
    });
  });

  it('keeps the managed binary path authoritative over provider query options', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult({
          binaryPath: '/managed/claude',
          env: {},
          configDir: null,
          source: 'managed',
          version: '1.2.3',
        });
      }),
    );

    const agent = await makeAgent('claude-code', {}, { pathToClaudeCodeExecutable: '/user/override/claude' });
    agents.push(agent);
    await agent.initialize();

    expect(capturedOptions[0]?.pathToClaudeCodeExecutable).toBe('/managed/claude');
  });
});
