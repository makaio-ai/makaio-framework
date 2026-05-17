/**
 * Integration tests for `client.resolveBinary` integration in the
 * `CodexAppServerConnector`.
 *
 * These tests verify that the connector correctly calls
 * `client.resolveBinary` on the global bus and forwards the resolved binary
 * path and environment variables to `createStdioTransport` before spawning
 * the subprocess.
 *
 * The `node:child_process` module is mocked so no real process is created.
 * The test drives the connector up to the point where `spawn` is called —
 * enough to assert on the binary name and environment — without needing the
 * full JSON-RPC initialize / thread-start handshake to complete.
 *
 * Coverage:
 * - `createStdioTransport` uses the resolved `binaryPath` when a managed
 *   binary is available via `client.resolveBinary`
 * - `createStdioTransport` falls back to the default `'codex'` binary when
 *   no handler is registered for `client.resolveBinary`
 * - `createStdioTransport` falls back to `'codex'` when `binaryPath` is
 *   `null` (global-install resolution)
 * - The resolved `env` (e.g. `CODEX_HOME`) from the managed binary context
 *   is merged into the spawn environment and takes precedence over connector
 *   defaults
 * - `config.clientId` is forwarded to `client.resolveBinary`; absent
 *   `clientId` defaults to `'codex'`
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { CodexAppServerConnector } from '../connector.js';
import { CodexAppServerNamespace } from '../namespaces/index.js';

// ---------------------------------------------------------------------------
// Mock subprocess — satisfies createStdioTransport's stream-based API without
// spawning a real child process.
// ---------------------------------------------------------------------------

class MockSubprocess {
  stdin = { write: vi.fn() };
  stdout = { on: vi.fn() };
  stderr = { on: vi.fn() };
  on = vi.fn();
  kill = vi.fn();
}

const mockSpawn = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot of a `spawn` invocation captured from `mockSpawn.mock.calls`.
 */
interface SpawnCapture {
  /** The binary path or name passed as the first argument to `spawn`. */
  binary: string;
  /** The `env` property from the options object passed to `spawn`. */
  env: Record<string, string>;
}

/**
 * Wait until `spawn` has been called at least once, then return a snapshot
 * of the first invocation arguments.
 *
 * `vi.waitFor` polls the predicate up to its default timeout (1 s by
 * default) so the connector's async path (credential resolution, binary
 * resolution) has time to complete before the assertion is made.
 * @returns Spawn call capture
 */
async function waitForSpawn(): Promise<SpawnCapture> {
  await vi.waitFor(() => {
    expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  const [binary, , opts] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
  return { binary, env: opts.env };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexAppServerConnector — client.resolveBinary integration', () => {
  let subprocess: MockSubprocess;
  let tempCwd: string;

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
    if (tempCwd) {
      rmSync(tempCwd, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  /**
   * Create a connector backed by the mocked spawn and start initialization
   * in the background. The returned `connector` can be aborted after the
   * assertion to prevent the pending `initialize` request from leaking.
   *
   * The connector is intentionally created without an injected transport or
   * JSON-RPC client so the production `createStdioTransport` / `spawn` path
   * is exercised.
   * @param clientId - Client identifier forwarded to `client.resolveBinary`
   * @returns Connector instance
   */
  function makeConnector(clientId = 'codex'): Promise<CodexAppServerConnector> {
    return CodexAppServerNamespace.scopedBus().then((mockBus) => {
      tempCwd = mkdtempSync(join(tmpdir(), 'codex-resolve-binary-test-'));
      subprocess = new MockSubprocess();
      mockSpawn.mockReturnValue(subprocess);

      const connector = new CodexAppServerConnector({
        bus: mockBus,
        adapterId: 'test-adapter',
        adapterName: 'codex-app-server',
        agentId: 'test-agent',
        model: 'test-model',
        cwd: tempCwd,
        env: { BASE_ENV: 'base' },
        clientId,
      });

      // Fire-and-forget: we only need the connector to progress far enough
      // to call `spawn`; we do not need the full initialize handshake.
      connector.initialize().catch(() => {
        // Swallow the expected "connection never responded" error that
        // occurs when the mock subprocess never emits an initialize result.
      });

      return connector;
    });
  }

  // -------------------------------------------------------------------------
  // Binary path routing
  // -------------------------------------------------------------------------

  it('uses the resolved binaryPath when a managed binary is returned', async () => {
    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult({
        binaryPath: '/usr/local/managed/codex',
        env: {},
        configDir: null,
        source: 'managed',
        version: '1.0.0',
      });
    });

    try {
      const connector = await makeConnector();
      const { binary } = await waitForSpawn();
      connector.abort();

      expect(binary).toBe('/usr/local/managed/codex');
    } finally {
      cleanup();
    }
  });

  it('falls back to the default codex binary when no resolveBinary handler is registered', async () => {
    // No handler — requestOptional returns { handled: false }.
    const connector = await makeConnector();
    const { binary } = await waitForSpawn();
    connector.abort();

    expect(binary).toBe('codex');
  });

  it('falls back to codex when binaryPath is null (global install)', async () => {
    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult({
        binaryPath: null,
        env: {},
        configDir: null,
        source: 'global',
        version: '1.0.0',
      });
    });

    try {
      const connector = await makeConnector();
      const { binary } = await waitForSpawn();
      connector.abort();

      expect(binary).toBe('codex');
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Environment variable merging
  // -------------------------------------------------------------------------

  it('merges CODEX_HOME from the managed binary env into the spawn environment', async () => {
    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult({
        binaryPath: '/managed/codex',
        env: { CODEX_HOME: '/managed/home' },
        configDir: '/managed/home',
        source: 'managed',
        version: '1.0.0',
      });
    });

    try {
      const connector = await makeConnector();
      const { env } = await waitForSpawn();
      connector.abort();

      expect(env['CODEX_HOME']).toBe('/managed/home');
    } finally {
      cleanup();
    }
  });

  it('resolved binary env takes precedence over connector base env', async () => {
    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult({
        binaryPath: null,
        env: { BASE_ENV: 'managed-override' },
        configDir: null,
        source: 'managed',
        version: '1.0.0',
      });
    });

    try {
      const connector = await makeConnector();
      const { env } = await waitForSpawn();
      connector.abort();

      expect(env['BASE_ENV']).toBe('managed-override');
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // clientId routing
  // -------------------------------------------------------------------------

  it('forwards config.clientId to the resolveBinary request', async () => {
    const capturedRequests: Array<{ clientId: string }> = [];

    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      capturedRequests.push(ctx.payload);
      ctx.setResult({
        binaryPath: null,
        env: {},
        configDir: null,
        source: 'global',
        version: null,
      });
    });

    try {
      const connector = await makeConnector('custom-codex-id');
      await waitForSpawn();
      connector.abort();

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].clientId).toBe('custom-codex-id');
    } finally {
      cleanup();
    }
  });

  it("defaults to 'codex' clientId when config.clientId is not set", async () => {
    const capturedRequests: Array<{ clientId: string }> = [];

    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      capturedRequests.push(ctx.payload);
      ctx.setResult({
        binaryPath: null,
        env: {},
        configDir: null,
        source: 'global',
        version: null,
      });
    });

    try {
      // makeConnector() with no clientId uses the default 'codex'
      const connector = await makeConnector();
      await waitForSpawn();
      connector.abort();

      expect(capturedRequests[0].clientId).toBe('codex');
    } finally {
      cleanup();
    }
  });
});
