/**
 * Tests consumption of centrally finalized GitHub Copilot runtime inputs.
 *
 * Verifies that `performSessionInit()` does not re-resolve or re-merge binary,
 * environment, or authentication inputs.
 *
 * Design invariants under test:
 * - When `client.resolveBinary` returns a managed context, `CopilotClient` receives
 *   its selected `cliPath` and the already-finalized connector environment.
 * - When `client.resolveBinary` returns a global context (`binaryPath: null`, empty
 *   env), no `cliPath` is passed and no binary environment is merged again.
 * - When `client.resolveBinary` has no handler (framework-only boot), the connector
 *   initializes successfully with an explicit empty environment instead of ambient auth.
 */

import os from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { ClientExecutionContext } from '@makaio/contracts/client';
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
    githubToken?: string;
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
    constructor(options: { cliPath?: string; env?: Record<string, string | undefined>; githubToken?: string }) {
      sdkHarness.capturedOptions.push({
        cliPath: options.cliPath,
        env: options.env,
        githubToken: options.githubToken,
      });
      const mock = sdkHarness.makeMockClient();
      Object.assign(this, mock);
    }
  }

  return {
    CopilotClient,
  };
});

import { GitHubCopilotConnectorNamespace } from '../namespaces/index.js';
import { GitHubCopilotConnector } from '../connector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal centrally resolved `ClientExecutionContext`.
 * @param binaryPath - Absolute path to the binary, or `null` for global.
 * @param env - Environment variables to inject, or empty object.
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

/** Minimal user message used to trigger session initialization via `sendMessage()`. */
const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'Hello',
  blocks: [{ type: 'text', content: 'Hello' }],
};

/**
 * Create a `GitHubCopilotConnector` configured for unit tests.
 * @param connectorEnv - Base environment variables for the connector.
 * @param clientExecution - Central binary selection.
 * @returns Connector instance ready for `ensureSession()`.
 */
async function makeConnector(
  connectorEnv: Record<string, string> = {},
  clientExecution?: ClientExecutionContext,
): Promise<GitHubCopilotConnector> {
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
    clientExecution,
    adapterAuth: {
      processEnv: {},
      connectorDeliveries: [{ target: 'github-copilot-sdk.constructor', values: { githubToken: 'test-github-token' } }],
      configInheritance: 'empty',
    },
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

describe('GitHubCopilotConnector — central runtime inputs', () => {
  let connectors: GitHubCopilotConnector[];

  beforeEach(() => {
    sdkHarness.capturedOptions.length = 0;
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

  it('passes the centrally selected cliPath and finalized environment', async () => {
    const connector = await makeConnector(
      { COPILOT_HOME: '/isolated/copilot' },
      makeExecutionContext('/usr/local/lib/makaio/copilot/1.0.0/gh-copilot', {
        COPILOT_HOME: '/must-not-be-merged-again',
      }),
    );
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBe('/usr/local/lib/makaio/copilot/1.0.0/gh-copilot');
    expect(sdkHarness.capturedOptions[0]?.env).toEqual({ COPILOT_HOME: '/isolated/copilot' });
    expect(sdkHarness.capturedOptions[0]?.githubToken).toBe('test-github-token');
  });

  // -------------------------------------------------------------------------
  // Global context — no cliPath, no extra env
  // -------------------------------------------------------------------------

  it('does not pass cliPath for a centrally selected global binary', async () => {
    const connector = await makeConnector({}, makeExecutionContext(null, {}, 'global'));
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBeUndefined();
  });

  it('keeps constructor token delivery out of the subprocess environment', async () => {
    const connector = await makeConnector({ EXISTING_VAR: 'base-value' }, makeExecutionContext(null, {}, 'global'));
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    expect(sdkHarness.capturedOptions[0]?.env).toEqual({ EXISTING_VAR: 'base-value' });
    expect(sdkHarness.capturedOptions[0]?.env).not.toHaveProperty('COPILOT_TOKEN');
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Absent central binary selection — PATH lookup remains the connector default
  // -------------------------------------------------------------------------

  it('initializes without a managed binary selection', async () => {
    const connector = await makeConnector();
    connectors.push(connector);
    await expect(triggerInit(connector)).resolves.toBeUndefined();

    expect(sdkHarness.capturedOptions).toHaveLength(1);
    expect(sdkHarness.capturedOptions[0]?.cliPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Ambient environment is never inherited by the Copilot child
  // -------------------------------------------------------------------------

  it('passes an empty finalized environment instead of ambient auth variables', async () => {
    vi.stubEnv('COPILOT_TOKEN', 'ambient-token');
    vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token');
    const connector = await makeConnector();
    connectors.push(connector);
    await triggerInit(connector);

    expect(sdkHarness.capturedOptions[0]?.env).toEqual({});
    expect(sdkHarness.capturedOptions[0]?.githubToken).toBe('test-github-token');
  });
});
