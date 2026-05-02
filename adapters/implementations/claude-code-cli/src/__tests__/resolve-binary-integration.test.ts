/**
 * Integration tests for `client.resolveBinary` wiring in `ClaudeCliConnector`.
 *
 * Verifies that `initializeSession()` seeds the resolved binary context and
 * installs the per-turn resolver so each CLI subprocess can spawn with the
 * current binary path and environment.
 *
 * Design invariants under test:
 * - When a managed binary context is returned, `binaryPath` and `env` flow into
 *   the session config.
 * - When a global context is returned (`binaryPath: null`), the session falls
 *   back to `undefined` (PATH lookup).
 * - When no `client.resolveBinary` handler is registered, the session uses the
 *   pre-existing behaviour (no managed override).
 * - An explicit `providerConfig.binaryPath` always wins over the resolved value.
 */

import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { ClientExecutionContext } from '@makaio/contracts/client';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { setupFixedCredentialBus } from '@makaio/ai-adapters-claude-shared/testing';
import { ClaudeCodeCliConnectorNamespace, type ClaudeCodeCliConnectorBus } from '../namespace/index.js';
import { ClaudeCliConnector } from '../connector.js';

// ---------------------------------------------------------------------------
// Typed accessor for private session config
// ---------------------------------------------------------------------------

/**
 * Shape of the session config fields inspected by integration tests.
 * Matches the relevant subset of {@link ClaudeCliSessionConfig}.
 */
interface TestSessionConfig {
  readonly binaryPath?: string;
  readonly env: Record<string, string>;
  readonly resolveTurnExecutionContext?: () => Promise<unknown>;
}

/**
 * Reflectively read the private `session.config` from a connector instance
 * without casting to `any`.
 * @param connector - Connector instance under test.
 * @returns Session config, or `undefined` when no session has been created.
 */
function getSessionConfig(connector: ClaudeCliConnector): TestSessionConfig | undefined {
  const session = Reflect.get(connector, 'session') as { config?: TestSessionConfig } | undefined;
  return session?.config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal managed execution context for `client.resolveBinary` tests.
 * @param binaryPath - Absolute path to the managed binary, or `null` for PATH lookup.
 * @param env - Optional environment overrides.
 * @returns A minimal ClientExecutionContext.
 */
function makeManagedContext(binaryPath: string | null, env: Record<string, string> = {}): ClientExecutionContext {
  return {
    binaryPath,
    env,
    configDir: null,
    source: binaryPath !== null ? 'managed' : 'global',
    version: null,
  };
}

/**
 * Create a `ClaudeCliConnector` wired to a fresh scoped bus.
 * @param opts - Optional connector overrides.
 * @returns Connector instance.
 */
async function makeConnector(
  opts: {
    binaryPath?: string;
    env?: Record<string, string>;
    providerContext?: ConstructorParameters<typeof ClaudeCliConnector>[0]['providerContext'];
  } = {},
): Promise<ClaudeCliConnector> {
  const bus = (await ClaudeCodeCliConnectorNamespace.scopedBus()) as ClaudeCodeCliConnectorBus;
  return new ClaudeCliConnector({
    bus,
    adapterId: 'test-adapter',
    adapterName: 'claude-code-cli',
    agentId: 'test-agent',
    cwd: os.tmpdir(),
    model: 'claude-sonnet',
    env: opts.env ?? {},
    providerContext: opts.providerContext,
    providerConfig: opts.binaryPath !== undefined ? { binaryPath: opts.binaryPath } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClaudeCliConnector — client.resolveBinary integration', () => {
  let cleanup: Array<() => void>;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanup = [];
  });

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('passes resolved managed binary path to the session config', async () => {
    const managedPath = '/home/user/.makaio/bin/claude';
    const resolvedEnv = { CLAUDE_CONFIG_DIR: '/home/user/.makaio/config' };

    cleanup.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(makeManagedContext(managedPath, resolvedEnv));
      }),
    );

    const connector = await makeConnector();
    await connector.initialize();

    const sessionConfig = getSessionConfig(connector);
    expect(sessionConfig).toBeDefined();
    expect(sessionConfig?.binaryPath).toBe(managedPath);
    expect(sessionConfig?.env).toMatchObject(resolvedEnv);
    expect(sessionConfig?.resolveTurnExecutionContext).toEqual(expect.any(Function));
  });

  it('falls back to PATH lookup when global context is returned (binaryPath: null)', async () => {
    cleanup.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(makeManagedContext(null));
      }),
    );

    const connector = await makeConnector();
    await connector.initialize();

    const sessionConfig = getSessionConfig(connector);
    expect(sessionConfig).toBeDefined();
    // null binaryPath signals PATH lookup — session must receive undefined
    expect(sessionConfig?.binaryPath).toBeUndefined();
  });

  it('uses existing behaviour when no handler is registered', async () => {
    // No handler registered — requestOptional returns handled: false.
    const connector = await makeConnector();
    await connector.initialize();

    const sessionConfig = getSessionConfig(connector);
    expect(sessionConfig).toBeDefined();
    expect(sessionConfig?.binaryPath).toBeUndefined();
    // env must not contain any binary-injected overrides
    expect(Object.keys(sessionConfig?.env ?? {})).toHaveLength(0);
  });

  it('merges resolved env on top of connector defaults', async () => {
    const resolvedEnv = { CLAUDE_CONFIG_DIR: '/managed/config', EXTRA_VAR: 'from-binary' };

    cleanup.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(makeManagedContext('/managed/bin/claude', resolvedEnv));
      }),
    );

    const connector = await makeConnector();
    await connector.initialize();

    const sessionConfig = getSessionConfig(connector);
    expect(sessionConfig?.env).toMatchObject(resolvedEnv);
  });

  it('passes Anthropic-compatible provider overrides through Claude-native env names', async () => {
    cleanup.push(setupFixedCredentialBus('opencode-secret'));
    const connector = await makeConnector({
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
    });
    await connector.initialize();

    const sessionConfig = getSessionConfig(connector);
    expect(sessionConfig?.env).toMatchObject({
      ANTHROPIC_API_KEY: 'opencode-secret',
      ANTHROPIC_BASE_URL: 'https://opencode.example.test/anthropic',
    });
    expect(sessionConfig?.env).not.toHaveProperty('OPENCODE_GO_API_KEY');
  });

  it('explicit providerConfig.binaryPath overrides the resolved binary', async () => {
    const userOverridePath = '/opt/custom/claude';
    const resolvedPath = '/home/user/.makaio/bin/claude';

    cleanup.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(makeManagedContext(resolvedPath));
      }),
    );

    const connector = await makeConnector({ binaryPath: userOverridePath });
    await connector.initialize();

    const sessionConfig = getSessionConfig(connector);
    expect(sessionConfig?.binaryPath).toBe(userOverridePath);
  });

  it('sends client.resolveBinary request with clientId "claude-code"', async () => {
    const capturedRequests: unknown[] = [];

    cleanup.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        capturedRequests.push(ctx.payload);
        ctx.setResult(makeManagedContext(null));
      }),
    );

    const connector = await makeConnector();
    await connector.initialize();

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({ clientId: 'claude-code' });
  });
});
