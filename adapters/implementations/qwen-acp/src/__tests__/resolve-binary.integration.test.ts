/**
 * Tests consumption of centrally finalized Qwen runtime inputs.
 *
 * Verifies that `initializeConnection()` threads the resolved binary path and env
 * into `createAcpConnection`, and that the adapter degrades gracefully when no
 * handler is registered for `client.resolveBinary`.
 *
 * Design invariants under test:
 * - When `client.resolveBinary` returns a managed context, the subprocess is
 *   spawned with the selected binary path and the already-finalized connector env;
 *   the binary environment is not merged a second time.
 * - When `client.resolveBinary` returns a global context (empty binaryPath and
 *   env), the default `'qwen'` command and base env are used.
 * - When the central runtime supplies no binary selection, PATH lookup uses
 *   the default command with an explicit empty environment.
 * - Adapter provider config cannot override the centrally resolved executable.
 */

import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { ClientExecutionContext } from '@makaio/contracts/client';
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
 * Build a minimal centrally resolved `ClientExecutionContext`.
 * @param binaryPath - Absolute path to the binary, or `null` for global.
 * @param env - Environment variables to inject.
 * @param source - Resolution source (`'managed'` or `'global'`).
 * @returns Minimal execution context payload.
 */
function makeExecutionContext(
  binaryPath: string | null,
  env: Record<string, string>,
  source: 'managed' | 'global' = 'managed',
): ClientExecutionContext {
  return { binaryPath, env, configDir: null, source, version: null };
}

/**
 * Create a `QwenAcpConnector` configured for unit tests.
 * @param overrides - Optional overrides for the connector config.
 * @returns Connector instance ready for `initialize()`.
 */
async function makeConnector(
  overrides: { env?: Record<string, string>; clientExecution?: ClientExecutionContext } = {},
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
    clientExecution: overrides.clientExecution,
    adapterAuth: { processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' },
    allowedDirectories: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QwenAcpConnector — central runtime inputs', () => {
  let connectors: QwenAcpConnector[];

  beforeEach(() => {
    acpHarness.capturedCalls.length = 0;
    connectors = [];
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    await Promise.all(connectors.map((c) => c.close()));
    connectors = [];
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // Managed context — binary path and env are resolved
  // -------------------------------------------------------------------------

  it('spawns the centrally selected binary with the finalized environment', async () => {
    const connector = await makeConnector({
      env: { QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/isolated/qwen' },
      clientExecution: makeExecutionContext('/usr/local/lib/makaio/qwen/1.0.0/qwen', {
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/must-not-be-merged-again',
      }),
    });
    connectors.push(connector);
    await connector.initialize();

    expect(acpHarness.capturedCalls).toHaveLength(1);
    expect(acpHarness.capturedCalls[0]?.command).toBe('/usr/local/lib/makaio/qwen/1.0.0/qwen');
    expect(acpHarness.capturedCalls[0]?.env).toEqual({ QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/isolated/qwen' });
  });

  // -------------------------------------------------------------------------
  // Global context — default command, no extra env
  // -------------------------------------------------------------------------

  it('uses default qwen command for a centrally selected global binary', async () => {
    const connector = await makeConnector({ clientExecution: makeExecutionContext(null, {}, 'global') });
    connectors.push(connector);
    await connector.initialize();

    expect(acpHarness.capturedCalls).toHaveLength(1);
    expect(acpHarness.capturedCalls[0]?.command).toBe('qwen');
  });

  // -------------------------------------------------------------------------
  // No handler — framework-only boot, falls back to current behaviour
  // -------------------------------------------------------------------------

  it('initializes without a managed binary selection', async () => {
    const connector = await makeConnector();
    connectors.push(connector);
    await expect(connector.initialize()).resolves.toBeUndefined();

    expect(acpHarness.capturedCalls).toHaveLength(1);
    expect(acpHarness.capturedCalls[0]?.command).toBe('qwen');
  });

  // -------------------------------------------------------------------------
  // Ambient environment is never inherited by the Qwen child
  // -------------------------------------------------------------------------

  it('passes an empty finalized environment instead of ambient auth variables', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'ambient-key');
    vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key');
    const connector = await makeConnector();
    connectors.push(connector);
    await connector.initialize();

    expect(acpHarness.capturedCalls[0]?.env).toEqual({});
  });
});
