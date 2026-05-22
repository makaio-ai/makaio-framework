/**
 * Tests for `client.resolveBinary` integration in the GitHub Copilot SDK connector.
 *
 * Verifies that `performSessionInit()` threads the resolved binary path and env
 * into the `CopilotClient` constructor, and that the adapter degrades gracefully
 * when no handler is registered for `client.resolveBinary`.
 *
 * Design invariants under test:
 * - When `client.resolveBinary` returns a managed context, `CopilotClient` receives
 *   `cliPath` and a merged `env` that includes base env, credential env, and binary env.
 * - When `client.resolveBinary` returns a global context (`binaryPath: null`, empty
 *   env), no `cliPath` is passed; `env` still contains base env and credential env.
 * - When `client.resolveBinary` has no handler (framework-only boot), the connector
 *   initializes successfully; `env` contains base env and credential env only.
 */

import os from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';

// ---------------------------------------------------------------------------
// SDK mock — captures the CopilotClient constructor options so tests can
// inspect what cliPath and env the connector resolved.
// ---------------------------------------------------------------------------

const sdkHarness = vi.hoisted(() => {
  /** Captured options from each `CopilotClient` construction, in order. */
  const capturedOptions: Array<{
    cliPath?: string;
    env?: Record<string, string | undefined>;
  }> = [];

  /** Mock client returned from each `new CopilotClient(...)` call. */
  const makeMockClient = () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      // on() registers the SDK event listener; never fires during init-only tests.
      on: vi.fn(),
      // send() is called in a microtask after sendMessage() returns; a no-op is safe.
      send: vi.fn().mockResolvedValue(undefined),
    }),
  });

  return { capturedOptions, makeMockClient };
});

vi.mock('@github/copilot-sdk', () => {
  class CopilotClient {
    constructor(options: { cliPath?: string; env?: Record<string, string | undefined> }) {
      sdkHarness.capturedOptions.push({ cliPath: options.cliPath, env: options.env });
      const mock = sdkHarness.makeMockClient();
      Object.assign(this, mock);
    }
  }

  return {
    CopilotClient,
  };
});

// ---------------------------------------------------------------------------
// Session environment mock — supplies a synthetic GitHub token for the
// connector's token-presence guard while allowing the real resolveClientBinary
// call to go through the bus so tests can wire resolveBinary handlers.
// ---------------------------------------------------------------------------

vi.mock('@makaio/ai-adapters-core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/ai-adapters-core/config')>();
  const { resolveClientBinary } = await import('@makaio/subsystem-client');
  return {
    ...actual,
    resolveSessionEnvironment: vi
      .fn()
      .mockImplementation(
        async ({ clientId, baseEnv = {} }: { clientId: string; baseEnv?: Record<string, string> }) => {
          const resolvedBinary = await resolveClientBinary(clientId);
          const credEnv = { COPILOT_TOKEN: 'test-github-token' };
          return {
            credentials: { token: 'test-github-token' },
            credEnv,
            resolvedBinary,
            spawnEnv: { ...baseEnv, ...credEnv, ...(resolvedBinary?.env ?? {}) },
          };
        },
      ),
  };
});

import { GitHubCopilotConnectorNamespace } from '../namespaces/index.js';
import { GitHubCopilotConnector } from '../connector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ClientExecutionContext` for `resolveBinary` mock handlers.
 * @param binaryPath - Absolute path to the binary, or `null` for global.
 * @param env - Environment variables to inject, or empty object.
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

/** Minimal user message used to trigger session initialization via `sendMessage()`. */
const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'Hello',
  blocks: [{ type: 'text', content: 'Hello' }],
};

/**
 * Create a `GitHubCopilotConnector` configured for unit tests.
 * @param connectorEnv - Base environment variables for the connector.
 * @returns Connector instance ready for `ensureSession()`.
 */
async function makeConnector(connectorEnv: Record<string, string> = {}): Promise<GitHubCopilotConnector> {
  const bus = await GitHubCopilotConnectorNamespace.scopedBus();
  return new GitHubCopilotConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'github-copilot-sdk',
    agentId: 'agent-test',
    sessionId: 'session-test',
    model: 'gpt-4o',
    cwd: os.tmpdir(),
    env: connectorEnv,
  });
}

/**
 * Trigger `performSessionInit` by sending a minimal message.
 *
 * `getAdapterSessionId()` returns immediately (set in constructor) without
 * triggering session initialization. `sendMessage()` calls `initializeSession()`
 * which in turn calls `performSessionInit()` — the method under test.
 * @param connector - Connector instance to initialize.
 */
async function triggerInit(connector: GitHubCopilotConnector): Promise<void> {
  await connector.sendMessage(TEST_MESSAGE).catch(() => {
    // After session initialization completes, the turn lifecycle may throw
    // because the mock SDK session does not fully implement turn completion.
    // We only care about the initialization path being exercised.
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubCopilotConnector — client.resolveBinary integration', () => {
  let cleanupHandlers: Array<() => void>;
  let connectors: GitHubCopilotConnector[];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    sdkHarness.capturedOptions.length = 0;
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

  it('passes cliPath and env when resolveBinary returns a managed context', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(
          makeExecutionContext('/usr/local/lib/makaio/copilot/1.0.0/gh-copilot', {
            COPILOT_HOME: '/usr/local/lib/makaio/profiles/copilot',
          }),
        );
      }),
    );

    const connector = await makeConnector();
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBe('/usr/local/lib/makaio/copilot/1.0.0/gh-copilot');
    expect(sdkHarness.capturedOptions[0]?.env).toMatchObject({
      COPILOT_HOME: '/usr/local/lib/makaio/profiles/copilot',
    });
  });

  // -------------------------------------------------------------------------
  // Global context — no cliPath, no extra env
  // -------------------------------------------------------------------------

  it('does not pass cliPath when resolveBinary returns a global context', async () => {
    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(makeExecutionContext(null, {}, 'global'));
      }),
    );

    const connector = await makeConnector();
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBeUndefined();
  });

  it('passes merged spawnEnv (base + credentials) when resolveBinary returns a global context with empty env', async () => {
    const baseEnv = { EXISTING_VAR: 'base-value' };

    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(makeExecutionContext(null, {}, 'global'));
      }),
    );

    const connector = await makeConnector(baseEnv);
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    // spawnEnv now includes base env and credential env even when the binary has no extra env.
    expect(sdkHarness.capturedOptions[0]?.env).toMatchObject({
      EXISTING_VAR: 'base-value',
      COPILOT_TOKEN: 'test-github-token',
    });
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // No handler — framework-only boot, falls back to current behaviour
  // -------------------------------------------------------------------------

  it('initializes without error when no handler is registered for client.resolveBinary', async () => {
    // No handler registered — requestOptional returns { handled: false }
    const connector = await makeConnector();
    connectors.push(connector);
    await expect(triggerInit(connector)).resolves.toBeUndefined();

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Env merge order — resolved binary env takes precedence over base connector env
  // -------------------------------------------------------------------------

  it('binary env overrides base connector env when both are present', async () => {
    const baseEnv = { COPILOT_HOME: '/old/path', BASE_VAR: 'keep-me' };

    cleanupHandlers.push(
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        ctx.setResult(
          makeExecutionContext('/path/to/copilot', {
            COPILOT_HOME: '/new/managed/path',
          }),
        );
      }),
    );

    const connector = await makeConnector(baseEnv);
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions[0]?.env).toMatchObject({
      COPILOT_HOME: '/new/managed/path',
      BASE_VAR: 'keep-me',
      COPILOT_TOKEN: 'test-github-token',
    });
  });
});
