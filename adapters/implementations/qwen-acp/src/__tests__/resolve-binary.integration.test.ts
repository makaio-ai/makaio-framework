/**
 * Tests for `client.resolveBinary` integration in the Qwen ACP connector.
 *
 * Verifies that `initializeConnection()` threads the resolved binary path and env
 * into `createAcpConnection`, and that the adapter degrades gracefully when no
 * handler is registered for `client.resolveBinary`.
 *
 * Design invariants under test:
 * - When `client.resolveBinary` returns a managed context, the subprocess is
 *   spawned with the resolved binary path and the resolved env vars merged last
 *   (binary-isolation vars take precedence over credential env).
 * - When `client.resolveBinary` returns a global context (empty binaryPath and
 *   env), the default `'qwen'` command and base env are used.
 * - When `client.resolveBinary` has no handler (framework-only boot), existing
 *   behaviour is preserved.
 * - An explicit `providerConfig.binaryPath` still wins over the resolved path
 *   (user override takes priority).
 */

import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';

// ---------------------------------------------------------------------------
// ACP connection mock — captures the spawn arguments passed to createAcpConnection
// so tests can inspect what command and env the connector resolved.
// ---------------------------------------------------------------------------

const acpHarness = vi.hoisted(() => {
  /** Captured invocation arguments from each `createAcpConnection` call. */
  const capturedCalls: Array<{
    command: string;
    env: Record<string, string>;
  }> = [];

  /** Minimal mock ACP connection handle. */
  const makeMockHandle = (): AcpConnectionHandle => ({
    // @ts-expect-error -- partial platform shim; tests only need initialize/newSession/kill
    connection: {
      initialize: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'mock-acp-session' }),
    },
    kill: vi.fn(),
    exited: Promise.resolve(0),
  });

  return { capturedCalls, makeMockHandle };
});

vi.mock('@makaio/ai-adapters-acp-client', async () => {
  const actual = await vi.importActual<typeof import('@makaio/ai-adapters-acp-client')>(
    '@makaio/ai-adapters-acp-client',
  );
  return {
    ...actual,
    createAcpConnection: vi.fn((_clientFn: unknown, opts: { command: string; env: Record<string, string> }) => {
      acpHarness.capturedCalls.push({ command: opts.command, env: opts.env });
      return Promise.resolve(acpHarness.makeMockHandle());
    }),
  };
});

import { QwenAcpNamespace } from '../namespaces/index.js';
import { QwenAcpConnector } from '../connector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ClientExecutionContext` for `resolveBinary` mock handlers.
 * @param binaryPath - Absolute path to the binary, or `null` for global.
 * @param env - Environment variables to inject.
 * @param source - Resolution source (`'managed'` or `'global'`).
 * @returns Minimal execution context payload.
 */
function makeExecutionContext(
  binaryPath: string | null,
  env: Record<string, string>,
  source: 'managed' | 'global' = 'managed',
): {
  binaryPath: string | null;
  env: Record<string, string>;
  configDir: null;
  source: 'managed' | 'global';
  version: null;
} {
  return { binaryPath, env, configDir: null, source, version: null };
}

/**
 * Create a `QwenAcpConnector` configured for unit tests.
 * @param overrides - Optional overrides for the connector config.
 * @returns Connector instance ready for `initialize()`.
 */
async function makeConnector(
  overrides: { env?: Record<string, string>; providerConfig?: { binaryPath?: string } } = {},
): Promise<QwenAcpConnector> {
  const bus = await QwenAcpNamespace.scopedBus();
  return new QwenAcpConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'qwen-acp',
    agentId: 'agent-test',
    sessionId: 'session-test',
    model: 'qwen3-coder',
    cwd: tmpdir(),
    env: overrides.env ?? {},
    allowedDirectories: [],
    ...(overrides.providerConfig ? { providerConfig: overrides.providerConfig } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QwenAcpConnector — client.resolveBinary integration', () => {
  let cleanupHandlers: Array<() => void>;
  let connectors: QwenAcpConnector[];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    acpHarness.capturedCalls.length = 0;
    cleanupHandlers = [];
    connectors = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupHandlers) cleanup();
    cleanupHandlers = [];
    await Promise.all(connectors.map((c) => c.close()));
    connectors = [];
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // Managed context — binary path and env are resolved
  // -------------------------------------------------------------------------

  it('spawns the resolved binary and merges env when resolveBinary returns a managed context', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(
          makeExecutionContext('/usr/local/lib/makaio/qwen/1.0.0/qwen', {
            QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/usr/local/lib/makaio/profiles/qwen',
          }),
        );
      }),
    );

    const connector = await makeConnector();
    connectors.push(connector);
    await connector.initialize();

    expect(acpHarness.capturedCalls).toHaveLength(1);
    expect(acpHarness.capturedCalls[0]?.command).toBe('/usr/local/lib/makaio/qwen/1.0.0/qwen');
    expect(acpHarness.capturedCalls[0]?.env).toMatchObject({
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/usr/local/lib/makaio/profiles/qwen',
    });
  });

  // -------------------------------------------------------------------------
  // Global context — default command, no extra env
  // -------------------------------------------------------------------------

  it('uses default qwen command when resolveBinary returns a global context with null binaryPath', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(makeExecutionContext(null, {}, 'global'));
      }),
    );

    const connector = await makeConnector();
    connectors.push(connector);
    await connector.initialize();

    expect(acpHarness.capturedCalls).toHaveLength(1);
    expect(acpHarness.capturedCalls[0]?.command).toBe('qwen');
  });

  // -------------------------------------------------------------------------
  // No handler — framework-only boot, falls back to current behaviour
  // -------------------------------------------------------------------------

  it('initializes without error when no handler is registered for client.resolveBinary', async () => {
    // No handler registered — requestOptional returns { handled: false }
    const connector = await makeConnector();
    connectors.push(connector);
    await expect(connector.initialize()).resolves.toBeUndefined();

    expect(acpHarness.capturedCalls).toHaveLength(1);
    expect(acpHarness.capturedCalls[0]?.command).toBe('qwen');
  });

  // -------------------------------------------------------------------------
  // User override wins — providerConfig.binaryPath beats resolved path
  // -------------------------------------------------------------------------

  it('providerConfig.binaryPath takes priority over the resolved binary path', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(
          makeExecutionContext('/managed/qwen/1.0.0/qwen', {
            QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/managed/profiles',
          }),
        );
      }),
    );

    const connector = await makeConnector({ providerConfig: { binaryPath: '/custom/qwen' } });
    connectors.push(connector);
    await connector.initialize();

    expect(acpHarness.capturedCalls).toHaveLength(1);
    expect(acpHarness.capturedCalls[0]?.command).toBe('/custom/qwen');
    // Resolved env is still applied even when user overrides the binary path.
    expect(acpHarness.capturedCalls[0]?.env).toMatchObject({
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/managed/profiles',
    });
  });

  // -------------------------------------------------------------------------
  // Env merge order — resolved binary env takes precedence over base connector env
  // -------------------------------------------------------------------------

  it('binary env overrides base connector env when both are present', async () => {
    const baseEnv = { QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/old/path', BASE_VAR: 'keep-me' };

    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(
          makeExecutionContext('/path/to/qwen', {
            QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/new/managed/path',
          }),
        );
      }),
    );

    const connector = await makeConnector({ env: baseEnv });
    connectors.push(connector);
    await connector.initialize();

    expect(acpHarness.capturedCalls[0]?.env).toMatchObject({
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/new/managed/path',
      BASE_VAR: 'keep-me',
    });
  });
});
