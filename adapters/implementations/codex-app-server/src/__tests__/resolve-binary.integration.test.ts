/** Connector consumption tests for centrally prepared Codex runtime config. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { ClientSubjects, type ClientExecutionContext } from '@makaio/contracts/client';
import { CodexAppServerConnector } from '../connector.js';
import { CodexAppServerNamespace } from '../namespaces/index.js';
import { createApiKeyAdapterAuth } from './shared.js';

/** Minimal child-process surface required by createStdioTransport. */
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

interface SpawnCapture {
  readonly binary: string;
  readonly env: Record<string, string>;
}

/** Wait for the production spawn boundary and return its finalized inputs. */
async function waitForSpawn(): Promise<SpawnCapture> {
  await vi.waitFor(() => {
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
  const [binary, , options] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
  return { binary, env: options.env };
}

/**
 * Build one central client execution selection.
 * @param binaryPath - Exact managed path, or null for global discovery
 * @param env - Binary-resolution environment retained for comparison
 * @returns Central client execution selection
 */
function execution(binaryPath: string | null, env: Record<string, string> = {}): ClientExecutionContext {
  return {
    binaryPath,
    env,
    configDir: null,
    source: binaryPath === null ? 'global' : 'managed',
    version: null,
  };
}

/**
 * Create a connector and advance it only as far as subprocess spawn.
 * @param options - Finalized runtime inputs supplied to the connector
 * @returns Connector whose initialization has reached the spawn boundary
 */
async function makeConnector(
  options: {
    env?: Record<string, string>;
    clientExecution?: ClientExecutionContext;
    adapterAuth?: ResolvedAdapterAuth;
  } = {},
): Promise<CodexAppServerConnector> {
  const bus = await CodexAppServerNamespace.scopedBus();
  const cwd = mkdtempSync(join(tmpdir(), 'codex-central-runtime-test-'));
  tempDirectories.push(cwd);
  mockSpawn.mockReturnValue(new MockSubprocess());

  const connector = new CodexAppServerConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'codex-app-server',
    agentId: 'agent-test',
    model: 'test-model',
    cwd,
    ...(options.env !== undefined && { env: options.env }),
    clientId: 'codex',
    clientExecution: options.clientExecution,
    adapterAuth: options.adapterAuth,
  });
  connectors.push(connector);
  void connector.initialize().catch(() => undefined);
  return connector;
}

const connectors: CodexAppServerConnector[] = [];
const tempDirectories: string[] = [];

afterEach(() => {
  for (const connector of connectors.splice(0)) {
    connector.abort();
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  MakaioBus.__resetHandlers?.();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('CodexAppServerConnector — central runtime config', () => {
  it('uses the centrally selected managed binary and finalized lease environment', async () => {
    await makeConnector({
      env: { PATH: '/base/bin', CODEX_HOME: '/isolated/codex' },
      clientExecution: execution('/managed/bin/codex', { CODEX_HOME: '/must-not-be-merged-again' }),
    });

    const spawn = await waitForSpawn();

    expect(spawn.binary).toBe('/managed/bin/codex');
    expect(spawn.env).toEqual({ PATH: '/base/bin', CODEX_HOME: '/isolated/codex' });
  });

  it('uses PATH lookup for a global or absent central binary selection', async () => {
    await makeConnector({ clientExecution: execution(null) });
    expect((await waitForSpawn()).binary).toBe('codex');

    connectors.splice(0).forEach((connector) => connector.abort());
    mockSpawn.mockClear();
    await makeConnector();
    expect((await waitForSpawn()).binary).toBe('codex');
  });

  it('treats an omitted host environment as empty instead of inheriting ambient authentication', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key');
    vi.stubEnv('CODEX_API_KEY', 'ambient-codex-key');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'ambient-access-token');

    await makeConnector();

    expect((await waitForSpawn()).env).toEqual({});
  });

  it('passes only the selected access-token process auth', async () => {
    await makeConnector({
      env: { CODEX_HOME: '/isolated/codex', CODEX_ACCESS_TOKEN: 'selected-access-token' },
      adapterAuth: {
        processEnv: { CODEX_ACCESS_TOKEN: 'selected-access-token' },
        connectorDeliveries: [],
        configInheritance: 'empty',
      },
    });

    const { env } = await waitForSpawn();

    expect(env).toEqual({ CODEX_HOME: '/isolated/codex', CODEX_ACCESS_TOKEN: 'selected-access-token' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
  });

  it('uses isolated native state without ambient process authentication fallback', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key');
    vi.stubEnv('CODEX_API_KEY', 'ambient-codex-key');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'ambient-access-token');
    await makeConnector({
      env: { CODEX_HOME: '/isolated/native-codex' },
      adapterAuth: { processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' },
    });

    const { env } = await waitForSpawn();

    expect(env).toEqual({ CODEX_HOME: '/isolated/native-codex' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
    expect(env).not.toHaveProperty('CODEX_ACCESS_TOKEN');
  });

  it('keeps provider API-key delivery out of the subprocess environment', async () => {
    await makeConnector({
      env: { CODEX_HOME: '/isolated/api-key-codex' },
      adapterAuth: createApiKeyAdapterAuth('private-api-key'),
    });

    const { env } = await waitForSpawn();

    expect(env).toEqual({ CODEX_HOME: '/isolated/api-key-codex' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
    expect(env).not.toHaveProperty('CODEX_ACCESS_TOKEN');
  });

  it('does not resolve or replace the client binary inside the connector', async () => {
    const resolveBinary = vi.fn();
    const cleanup = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      resolveBinary();
      ctx.setResult(execution('/unexpected/bin/codex'));
    });
    await makeConnector({ clientExecution: execution('/selected/bin/codex') });

    const spawn = await waitForSpawn();
    cleanup();

    expect(resolveBinary).not.toHaveBeenCalled();
    expect(spawn.binary).toBe('/selected/bin/codex');
  });
});
