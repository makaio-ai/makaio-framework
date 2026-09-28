/**
 * `CoreBootOptions.fileAccessRuleProvider` through a real `bootMakaioRuntimeCore`.
 *
 * The sibling `boot-file-access-rules.test.ts` drives the selected packages on
 * a hand-built coordinator. These cases boot the whole runtime, so they turn
 * red when boot stops handing the provider to the core package selection or
 * stops refusing an extension that overrides a provider-bound package.
 */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { createMakaioIgnoreProvider } from '@makaio/extension-filesystem';
import type { KernelMakaioExtension, TransportProvider } from '@makaio/kernel';
import { AgentStorageSubjects, SessionStorageSubjects, ToolApprovalToken } from '@makaio/services-core';
import type { FileAccessRuleProvider } from '@makaio/tools-core';
import { bootMakaioRuntimeCore, type MakaioRuntime } from '../boot.js';
import { ExplicitDescriptorDiscovery, type DiscoveredExtension } from '../extension-discovery.js';

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: homedirMock,
  };
});

const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-1';
const ADAPTER_NAME = 'test-adapter';

/** Env vars boot reads that an ambient developer value must not leak into. */
const ISOLATED_ENV_KEYS = ['MAKAIO_SKIP_EXTENSIONS', 'MAKAIO_DATABASE_URL', 'MAKAIO_DATABASE_PATH', 'MAKAIO_HOME'];

class FakeTransportProvider implements TransportProvider {
  public async connect(_bus: IMakaioBus, _machineId: string): Promise<void> {}

  public async disconnect(): Promise<void> {}
}

/**
 * Build a descriptor whose server entrypoint is an already-constructed package.
 * @param extensionPath - Directory the descriptor claims as its package root.
 * @param pkg - Package the descriptor's server entrypoint resolves to.
 * @returns Discovered extension the explicit discovery strategy can return.
 */
function preloadedDescriptorFixture(extensionPath: string, pkg: KernelMakaioExtension): DiscoveredExtension {
  return {
    descriptor: {
      name: pkg.name,
      displayName: pkg.displayName,
      version: pkg.version,
      makaio: { framework: '>=1.0.0' },
      entrypoints: { server: true },
    },
    extensionPath,
    source: 'local',
    preloadedModule: { default: pkg },
  };
}

describe('bootMakaioRuntimeCore with a fileAccessRuleProvider', { timeout: 30_000 }, () => {
  let tempHome: string;
  let workspace: string;
  let runtime: MakaioRuntime | undefined;
  let originalEnv: Map<string, string | undefined>;

  beforeEach(async () => {
    originalEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ISOLATED_ENV_KEYS) {
      delete process.env[key];
    }
    tempHome = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'makaio-boot-file-access-')));
    homedirMock.mockReturnValue(tempHome);
    workspace = path.join(tempHome, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, '.makaioignore'), 'secret.txt\n');
    await fs.writeFile(path.join(workspace, 'secret.txt'), 'top secret');
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = undefined;
    MakaioBus.__resetHandlers?.();
    homedirMock.mockReset();
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('denies an approval on a path the booted provider restricts', async () => {
    const makaioIgnore = createMakaioIgnoreProvider({ globalIgnorePath: path.join(tempHome, 'no-global-ignore') });
    const provider = vi.fn<FileAccessRuleProvider>(makaioIgnore);

    runtime = await bootMakaioRuntimeCore(new FakeTransportProvider(), 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
      fileAccessRuleProvider: provider,
    });

    // The approval service reads the agent cwd from storage; the agent row needs its session row.
    const now = Date.now();
    await runtime.bus.request(SessionStorageSubjects.set, {
      sessionId: SESSION_ID,
      session: {
        sessionId: SESSION_ID,
        createdAt: now,
        lastActivityAt: now,
        agents: [],
        status: 'active',
        isOrchestrated: false,
        isImported: false,
      },
    });
    await runtime.bus.request(AgentStorageSubjects.set, {
      agentId: AGENT_ID,
      agent: {
        agentId: AGENT_ID,
        adapterId: 'adapter-1',
        adapterName: ADAPTER_NAME,
        sessionId: SESSION_ID,
        adapterSessionId: 'adapter-session-1',
        role: 'lead',
        status: 'active',
        cwd: workspace,
        createdAt: now,
        lastActivityAt: now,
      },
    });

    const approval = await runtime.bus.request(AgentSubjects.toolApprove, {
      agentId: AGENT_ID,
      adapterId: 'adapter-1',
      adapterName: ADAPTER_NAME,
      sessionId: SESSION_ID,
      adapterSessionId: 'adapter-session-1',
      toolCallId: 'tool-call-1',
      toolName: 'read_file',
      args: { path: path.join(workspace, 'secret.txt') },
    });

    expect(approval).toMatchObject({
      action: 'deny',
      message: expect.stringContaining('.makaioignore'),
    });
    expect(provider).toHaveBeenCalledWith(workspace, undefined);
  });

  it('fails boot when an extension overrides the tool approval package', async () => {
    const override: KernelMakaioExtension = {
      name: ToolApprovalToken.name,
      displayName: 'Tool Approval Override',
      version: '1.0.0',
    };

    const provider = vi.fn<FileAccessRuleProvider>();

    await expect(
      bootMakaioRuntimeCore(new FakeTransportProvider(), 0, '127.0.0.1', {
        discovery: new ExplicitDescriptorDiscovery([preloadedDescriptorFixture(tempHome, override)]),
        frameworkVersion: '3.0.0',
        hostCapabilities: ['node'],
        fileAccessRuleProvider: provider,
      }),
    ).rejects.toThrow(`Extension "Tool Approval Override" v1.0.0 overrides the framework "${ToolApprovalToken.name}"`);
    expect(provider).not.toHaveBeenCalled();
  });
});
