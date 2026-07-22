/**
 * Integration tests for {@link createClientsCorePackage}.
 *
 * Proves that a package created with initial managed definitions returns them
 * from `client.list` immediately after `service.init()` — without any
 * post-start definition mutation. This is the core invariant of Phase 2:
 * the registry is fully seeded before `init()` runs.
 *
 * Uses a real bus instance with real Drizzle storage handlers registered
 * against an in-memory SQLite database. No I/O strategy calls are made
 * because no install jobs are enqueued — `client.list` only reads from
 * the definition registry and storage.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { ClientSubjects, createClientDefinition } from '@makaio/contracts/client';
import { createPluginTestDb, type PluginTestDbContext } from '@makaio/test-utils/drizzle-harness';
import type { KernelExtensionContext } from '@makaio/kernel/extension';
import { z } from 'zod';
import { createClientsCorePackage, registerStorageHandlersWithRollback } from '../package.js';
import type { ClientsCorePackageOptions, ClientsCoreService } from '../package.js';
import { CLIENTS_CORE_DDL } from './test-ddl.js';

// ---------------------------------------------------------------------------
// Test client definitions
// ---------------------------------------------------------------------------

const MANAGED_DEFINITION = createClientDefinition({
  id: 'claude-code',
  name: 'Claude Code',
  version: '0.1.0',
  authMethods: [],
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: {
    type: 'npm',
    package: '@anthropic-ai/claude-code',
    version: '1.0.17',
  },
  versionCommand: { executable: 'bin/claude-code', args: ['--version'] },
});

const UNMANAGED_DEFINITION = createClientDefinition({
  id: 'codex',
  name: 'Codex',
  version: '0.1.0',
  authMethods: [],
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: false },
});

// ---------------------------------------------------------------------------
// Minimal ExtensionContext for tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link ExtensionContext} for invoking the package factory.
 *
 * Only the fields accessed by {@link createClientsCorePackage} `create` are
 * populated: `bus` and `makaioHome`.
 * @param bus - Bus instance to wire into the service
 * @returns Minimal package context
 */
function makeTestExtensionContext(bus: IMakaioBus): KernelExtensionContext {
  return {
    bus,
    makaioHome: '/opt/makaio/test',
    platform: 'linux',
    homedir: '/home/test',
    username: 'test',
    machineId: 'test-machine-id',
    dataDir: '/opt/makaio/test/clients-core',
    identity: {
      extensionName: 'makaio.clients-core',
    } as KernelExtensionContext['identity'],
    getService: () => undefined,
    tryImport: async (_specifier) => null,
    signal: new AbortController().signal,
    hasExtension: (_name) => false,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createClientsCorePackage (integration)', () => {
  let bus: IMakaioBus;
  let service: ClientsCoreService;
  let storageCleanup: () => void;
  let dbCtx: PluginTestDbContext;

  beforeAll(async () => {
    dbCtx = await createPluginTestDb({
      name: 'clients-core-package',
      schemas: CLIENTS_CORE_DDL,
      tables: ['client_binary_versions', 'client_binary_state', 'client_runtimes', 'client_profiles'],
      registerHandlers: () => () => {},
    });
  });

  it('rolls back earlier storage registrations when a later registration throws', () => {
    const calls: string[] = [];
    const cleanupRuntime = vi.fn(() => {
      calls.push('cleanup-runtime');
    });
    const failure = new Error('binary registration failed');

    expect(() =>
      registerStorageHandlersWithRollback([
        () => {
          calls.push('register-runtime');
          return cleanupRuntime;
        },
        () => {
          calls.push('register-binary');
          throw failure;
        },
      ]),
    ).toThrow(failure);

    expect(calls).toEqual(['register-runtime', 'register-binary', 'cleanup-runtime']);
    expect(cleanupRuntime).toHaveBeenCalledOnce();
  });

  afterAll(async () => {
    await dbCtx.close();
  });

  beforeEach(async () => {
    await dbCtx.clearData();
    bus = createBusInstance();
  });

  afterEach(async () => {
    await service?.destroy();
    storageCleanup?.();
  });

  /**
   * Create and initialize a service from the package factory, wiring storage
   * handlers against the test database.
   * @param definitions - Definitions to seed into the package registry
   */
  async function bootService(definitions: ClientsCorePackageOptions['definitions']): Promise<void> {
    const pkg = createClientsCorePackage({ definitions });

    // Register storage handlers the same way the coordinator does.
    if (pkg.storage?.registerHandlers) {
      const cleanup = pkg.storage.registerHandlers(bus, dbCtx.db, makeTestExtensionContext(bus));
      storageCleanup = cleanup ?? (() => {});
    }

    const ctx = makeTestExtensionContext(bus);
    service = (await pkg.create?.(ctx)) as ClientsCoreService;
    await service.init();
  }

  // -------------------------------------------------------------------------
  // Core invariant: definitions available immediately after init()
  // -------------------------------------------------------------------------

  it('client.list returns a managed definition before any version is installed', async () => {
    await bootService([MANAGED_DEFINITION]);

    const result = await bus.request(ClientSubjects.list, {});
    expect(result.clients).toHaveLength(1);
    expect(result.clients[0]?.clientId).toBe('claude-code');
    expect(result.clients[0]?.installedVersions).toHaveLength(0);
    expect(result.clients[0]?.activeVersion).toBeNull();
  });

  it('client.list includes multiple managed definitions seeded at construction', async () => {
    const secondManaged = createClientDefinition({
      id: 'gemini-code',
      name: 'Gemini Code',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: { supportsManagedBinary: true },
      managedInstall: {
        type: 'npm',
        package: '@google/gemini-code',
        version: '2.0.0',
      },
      versionCommand: { executable: 'bin/gemini-code', args: ['--version'] },
    });

    await bootService([MANAGED_DEFINITION, secondManaged]);

    const result = await bus.request(ClientSubjects.list, {});
    const ids = result.clients.map((c) => c.clientId);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('gemini-code');
  });

  it('snapshots the caller-owned definitions array at factory creation', async () => {
    const definitions = [MANAGED_DEFINITION];
    const pkg = createClientsCorePackage({ definitions });
    definitions.push(
      createClientDefinition({
        id: 'late-added',
        name: 'Late Added',
        version: '0.1.0',
        authMethods: [],
        defaultApprovalPolicy: 'always-ask',
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: {
          type: 'npm',
          package: '@example/late-added',
          version: '0.1.0',
        },
        versionCommand: { executable: 'bin/late-added', args: ['--version'] },
      }),
    );

    if (pkg.storage?.registerHandlers) {
      const cleanup = pkg.storage.registerHandlers(bus, dbCtx.db, makeTestExtensionContext(bus));
      storageCleanup = cleanup ?? (() => {});
    }

    const ctx = makeTestExtensionContext(bus);
    service = (await pkg.create?.(ctx)) as ClientsCoreService;
    await service.init();

    const result = await bus.request(ClientSubjects.list, {});
    expect(result.clients.map((client) => client.clientId)).toEqual(['claude-code']);
  });

  it('client.list returns an empty list when no definitions are seeded', async () => {
    await bootService([]);

    const result = await bus.request(ClientSubjects.list, {});
    expect(result.clients).toHaveLength(0);
  });

  it('client.list omits unmanaged definitions from the managed binary inventory', async () => {
    // Unmanaged definitions (no `managedInstall`) are registered for lookup
    // purposes but must not appear in the binary management list.
    await bootService([MANAGED_DEFINITION, UNMANAGED_DEFINITION]);

    const result = await bus.request(ClientSubjects.list, {});
    const ids = result.clients.map((c) => c.clientId);
    expect(ids).toContain('claude-code');
    expect(ids).not.toContain('codex');
  });

  it('client.list returns the descriptor pin and updateAvailable:false before any install', async () => {
    await bootService([MANAGED_DEFINITION]);

    const result = await bus.request(ClientSubjects.list, {});
    const entry = result.clients.find((c) => c.clientId === 'claude-code');
    expect(entry?.pinnedVersion).toBe('1.0.17');
    expect(entry?.updateAvailable).toBe(false);
  });

  it('client.config.prime delegates to the client-owned config prime subject', async () => {
    const observed: unknown[] = [];
    const primeNs = createBusNamespace('client:claude-code', {
      'config.prime': {
        request: z.object({
          clientId: z.string(),
          configDir: z.string(),
          phase: z.string(),
          binaryVersion: z.string().optional(),
          adapterName: z.string().optional(),
          projectDir: z.string().optional(),
        }),
        response: z.object({ primed: z.boolean() }),
      },
    });
    const unsubPrime = bus.on(primeNs.subjects.config.prime, (ctx) => {
      observed.push(ctx.payload);
      ctx.setResult({ primed: true });
    });

    await bootService([MANAGED_DEFINITION]);

    try {
      const result = await bus.request(ClientSubjects.config.prime, {
        clientId: 'claude-code',
        configDir: '/tmp/claude-config',
        phase: 'managed-install',
        binaryVersion: '1.0.17',
      });

      expect(result).toEqual({ primed: true });
      expect(observed).toEqual([
        {
          clientId: 'claude-code',
          configDir: '/tmp/claude-config',
          phase: 'managed-install',
          binaryVersion: '1.0.17',
        },
      ]);
    } finally {
      unsubPrime();
    }
  });

  it('client.config.prime reports primed:false when no client-owned handler exists', async () => {
    await bootService([MANAGED_DEFINITION]);

    const result = await bus.request(ClientSubjects.config.prime, {
      clientId: 'claude-code',
      configDir: '/tmp/claude-config',
      phase: 'profile-create',
    });

    expect(result).toEqual({ primed: false });
  });

  // -------------------------------------------------------------------------
  // Verify no post-start mutation is needed
  // -------------------------------------------------------------------------

  it('does not require any post-start definition registration to be called after init()', async () => {
    // This test documents and enforces the core invariant: the package must
    // return correct results from client.list without any caller mutating
    // definitions after service.init(). The registry is fully seeded at
    // construction time via createClientsCorePackage({ definitions }).
    await bootService([MANAGED_DEFINITION]);

    const result = await bus.request(ClientSubjects.list, {});
    const entry = result.clients.find((c) => c.clientId === 'claude-code');
    expect(entry).toBeDefined();
    expect(entry?.clientId).toBe('claude-code');
  });

  // -------------------------------------------------------------------------
  // Service surface: hook response registries
  // -------------------------------------------------------------------------

  it('exposes providerContractRegistry on the service surface', async () => {
    await bootService([MANAGED_DEFINITION]);

    expect(service.providerContractRegistry).toBeDefined();
    expect(typeof service.providerContractRegistry.registerProviderContract).toBe('function');
    expect(typeof service.providerContractRegistry.getProviderContract).toBe('function');
  });

  it('exposes hookResponseRegistry on the service surface', async () => {
    await bootService([MANAGED_DEFINITION]);

    expect(service.hookResponseRegistry).toBeDefined();
    expect(typeof service.hookResponseRegistry.installContributors).toBe('function');
    expect(typeof service.hookResponseRegistry.removeContributors).toBe('function');
    expect(typeof service.hookResponseRegistry.snapshot).toBe('function');
  });

  it('provider runtime can register and unregister contracts through the service surface', async () => {
    await bootService([]);

    const catalog = {
      clientId: 'claude-code',
      contractId: 'anthropic.tool-response',
      version: '1.0.0',
      supportedInteractions: ['PreToolUse'],
      blockability: [{ interaction: 'PreToolUse', blockable: true }],
      validate: () => true as const,
    };

    // Register.
    service.providerContractRegistry.registerProviderContract('ext-provider', catalog);
    const found = service.providerContractRegistry.getProviderContract('claude-code', 'anthropic.tool-response');
    expect(found?.contractId).toBe('anthropic.tool-response');

    // Unregister.
    service.providerContractRegistry.unregisterProviderContract(
      'ext-provider',
      'claude-code',
      'anthropic.tool-response',
    );
    expect(
      service.providerContractRegistry.getProviderContract('claude-code', 'anthropic.tool-response'),
    ).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // runtimeBoot contribution
  // -------------------------------------------------------------------------

  it('declares a runtimeBoot contribution that registers a processor', () => {
    const pkg = createClientsCorePackage();
    expect(pkg.runtimeBoot).toBeDefined();

    const processors: unknown[] = [];
    pkg.runtimeBoot?.configure({
      bus: createBusInstance(),
      registerContributionProcessor: (processor) => {
        processors.push(processor);
      },
      forEachActiveExtension: () => {},
    });

    expect(processors).toHaveLength(1);
  });
});
