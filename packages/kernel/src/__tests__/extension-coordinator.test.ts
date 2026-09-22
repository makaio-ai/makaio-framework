import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createBusInstance, localSubject } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import {
  createClientDefinition,
  type ExtensionDependency,
  type ExtensionOperatorConfigEntry,
  type ExtensionOperatorConfigSource,
  type NodeExtensionContext as ExtensionContext,
  type ProviderDefinition,
  type TrayManifest,
} from '@makaio/contracts';
import type { KernelMakaioExtension as MakaioExtension, ExtensionEntry } from '../extension/types.js';
import { TrayMenuEntrySchema, TrayMenuSubjects, TrayMenuEntry } from '@makaio/services-core/tray-menu';
import { extensionToken } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import { handleSetEnabled, type ToggleHost } from '../extension/extension-toggle.js';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import { ExtensionSubjects } from '../observability/extension-namespace.js';
import { BootSubjects } from '../boot-namespace.js';
import { ServiceSkipError } from '../service-skip-error.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Concrete {@link BaseService} subclass used in tests.
 *
 * Tracks `onInit` and `onDestroy` invocations via optional callbacks passed at
 * construction time. The coordinator calls the public `init()` / `destroy()`
 * methods; the callbacks let individual tests observe the call order without
 * exposing private BaseService fields.
 */
class MockService extends BaseService {
  private readonly onInitCb?: () => void | Promise<void>;
  private readonly onDestroyCb?: () => void | Promise<void>;

  /**
   * @param bus - Bus instance forwarded to BaseService.
   * @param onInit - Optional callback invoked during onInit.
   * @param onDestroy - Optional callback invoked during onDestroy.
   */
  public constructor(bus: IMakaioBus, onInit?: () => void | Promise<void>, onDestroy?: () => void | Promise<void>) {
    super(bus);
    this.onInitCb = onInit;
    this.onDestroyCb = onDestroy;
  }

  protected async onInit(): Promise<void> {
    await this.onInitCb?.();
  }

  protected async onDestroy(): Promise<void> {
    await this.onDestroyCb?.();
  }
}

/**
 * Factory that creates a {@link MockService} and returns it as a BaseService.
 *
 * The service's `init` and `destroy` methods are automatically spied on by
 * vitest so call counts can be asserted.
 * @param bus - Bus instance to pass to the service.
 * @param onInit - Optional callback invoked during init.
 * @param onDestroy - Optional callback invoked during destroy.
 * @returns Spy-wrapped MockService instance.
 */
function makeMockService(
  bus: IMakaioBus,
  onInit?: () => void | Promise<void>,
  onDestroy?: () => void | Promise<void>,
): BaseService {
  const service = new MockService(bus, onInit, onDestroy);
  vi.spyOn(service, 'init');
  vi.spyOn(service, 'destroy');
  return service;
}

/**
 * Minimal package factory for test use.
 * @param name - Package identifier.
 * @param options - Optional overrides.
 */
function makePackage(
  name: string,
  options: Partial<Omit<MakaioExtension, 'name' | 'displayName'>> = {},
): MakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    ...options,
  };
}

/**
 * Build a minimal {@link ExtensionDependency} for test fixtures.
 * @param name - Name of the required extension.
 * @returns A minimal structured dependency object.
 */
function dep(name: string): ExtensionDependency {
  return { type: 'extension', name, version: '>=0.1.0' };
}

/**
 * Build an optional structured dependency for test fixtures.
 * @param name - Name of the optional extension.
 * @returns A structured optional dependency object.
 */
function optionalDep(name: string): ExtensionDependency {
  return { ...dep(name), optional: true };
}

/**
 * Build a minimal CLI contribution for test fixtures.
 * @param name - Top-level CLI command name.
 * @returns A minimal contribution with one no-op `run` subcommand.
 */
function makeCliContribution(name: string): NonNullable<MakaioExtension['cli']> {
  return {
    name,
    description: `${name} command`,
    subcommands: [
      {
        name: 'run',
        description: 'Run',
        schema: z.object({}),
        handler: async () => undefined,
      },
    ],
  };
}

/**
 * Minimal {@link ExtensionContext} fields (excluding coordinator-owned and
 * bus-owned fields) for test coordinators.
 *
 * Provides the platform-specific context required by packages with a `create`
 * factory without coupling the test to real OS values.
 */
const TEST_PKG_CTX_BASE: Omit<
  ExtensionContext,
  'bus' | 'identity' | 'getService' | 'dataDir' | 'signal' | 'hasExtension'
> = {
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async (_specifier) => null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtensionCoordinator', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  // 1. Dependency-order initialization
  it('initializes packages in dependency order', async () => {
    const callOrder: string[] = [];

    const packages: MakaioExtension[] = [
      makePackage('c', {
        dependencies: [dep('b')],
        create: (ctx) =>
          makeMockService(ctx.bus, () => {
            callOrder.push('c');
          }),
      }),
      makePackage('b', {
        dependencies: [dep('a')],
        create: (ctx) =>
          makeMockService(ctx.bus, () => {
            callOrder.push('b');
          }),
      }),
      makePackage('a', {
        create: (ctx) =>
          makeMockService(ctx.bus, () => {
            callOrder.push('a');
          }),
      }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    const retained = coordinator.load(packages);
    await coordinator.startAll();

    expect(callOrder).toEqual(['a', 'b', 'c']);
    expect(retained.map((pkg) => pkg.name)).toEqual(['a', 'b', 'c']);
  });

  it('prunes a dependent of a filtered package from what load reports as retained', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    const retained = coordinator.load([
      makePackage('interactive-only', { surface: 'interactive', create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('dependent', {
        dependencies: [dep('interactive-only')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
      makePackage('standalone', { create: (ctx) => makeMockService(ctx.bus) }),
    ]);

    expect(retained.map((pkg) => pkg.name)).toEqual(['standalone']);
  });

  it('reports the winning registration of an overridden name, not the one it replaced', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    const overridden = makePackage('my-ext', { create: (ctx) => makeMockService(ctx.bus) });
    const override = makePackage('my-ext', { create: (ctx) => makeMockService(ctx.bus) });

    const retained = coordinator.load([overridden, override]);

    // Manifests, not names: a caller matching names back against its own input
    // would find both registrations and re-admit the one this dropped.
    expect(retained).toHaveLength(1);
    expect(retained[0]).toBe(override);
    expect(retained).not.toContain(overridden);
  });

  it('filters out packages that do not match the runtime surface', async () => {
    const initInteractive = vi.fn();
    const initHeadless = vi.fn();

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    const retained = coordinator.load([
      makePackage('interactive-only', {
        surface: 'interactive',
        create: (ctx) => makeMockService(ctx.bus, initInteractive),
      }),
      makePackage('headless-only', {
        surface: 'headless',
        create: (ctx) => makeMockService(ctx.bus, initHeadless),
      }),
    ]);

    // What load() retained is what a composition root has to diagnose against;
    // the excluded package must not appear in it.
    expect(retained.map((pkg) => pkg.name)).toEqual(['headless-only']);

    await coordinator.startAll();

    expect(initInteractive).not.toHaveBeenCalled();
    expect(initHeadless).toHaveBeenCalledOnce();
    expect(coordinator.list()).toEqual([
      {
        name: 'headless-only',
        displayName: 'headless-only',
        state: 'active',
        surface: 'headless',
        enabled: true,
        extensionManaged: true,
        critical: false,
      },
    ]);
  });

  // 2. stateChanged events emitted on the bus
  it('emits stateChanged events for state transitions', async () => {
    const events: Array<{ from: string; to: string; name: string }> = [];

    bus.on(ExtensionSubjects.stateChanged, (ctx) => {
      events.push({ name: ctx.payload.name, from: ctx.payload.from, to: ctx.payload.to });
    });

    const pkg = makePackage('my-ext', {
      create: (ctx) => makeMockService(ctx.bus),
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    // This non-critical skip path intentionally mirrors the critical skip test below;
    // only the non-critical case should settle without throwing.
    coordinator.load([pkg]);
    await coordinator.startAll();

    const extEvents = events.filter((e) => e.name === 'my-ext');
    // discovered -> initializing, then initializing -> active
    expect(extEvents).toContainEqual({ name: 'my-ext', from: 'discovered', to: 'initializing' });
    expect(extEvents).toContainEqual({ name: 'my-ext', from: 'initializing', to: 'active' });
  });

  it('registers extension namespaces before storage, create, and init lifecycles run', async () => {
    const namespace = createBusNamespace('test-extension:lifecycle', {
      ping: z.object({ id: z.string() }),
    });
    const observed: string[] = [];
    const expectNamespaceRegistered = (stage: string): void => {
      observed.push(stage);
      expect(bus.getSchema(namespace.subjects.ping)).toBeDefined();
    };

    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('namespaced-extension', {
        namespaces: [namespace],
        storage: {
          registerHandlers: () => {
            expectNamespaceRegistered('storage');
          },
        },
        create: (ctx) => {
          expectNamespaceRegistered('create');
          return makeMockService(ctx.bus, () => {
            expectNamespaceRegistered('init');
          });
        },
      }),
    ]);

    expect(bus.getSchema(namespace.subjects.ping)).toBeDefined();
    await coordinator.startAll();

    expect(observed).toEqual(['storage', 'create', 'init']);
  });

  // 3. Failed state on init error
  it('puts package in failed state when init throws', async () => {
    const pkg = makePackage('bad-ext', {
      create: (ctx) =>
        makeMockService(ctx.bus, async () => {
          throw new Error('init failed');
        }),
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([pkg]);
    await coordinator.startAll();

    const info = coordinator.list().find((e) => e.name === 'bad-ext');
    expect(info?.state).toBe('failed');
    expect(info?.error).toBe('init failed');
  });

  // 3b. ServiceSkipError transitions to skipped
  it('puts package in skipped state when ServiceSkipError is thrown', async () => {
    const pkg = makePackage('skip-ext', {
      create: (_ctx) => {
        throw new ServiceSkipError('feature disabled');
      },
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([pkg]);
    await coordinator.startAll();

    const info = coordinator.list().find((e) => e.name === 'skip-ext');
    expect(info?.state).toBe('skipped');
    expect(info?.error).toBe('feature disabled');
  });

  it('treats ServiceSkipError from critical packages as a startup failure', async () => {
    const pkg = makePackage('critical-skip-ext', {
      critical: true,
      create: (_ctx) => {
        throw new ServiceSkipError('feature disabled');
      },
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([pkg]);

    await expect(coordinator.startAll()).rejects.toThrow(/Critical package "critical-skip-ext" failed/);

    const info = coordinator.list().find((e) => e.name === 'critical-skip-ext');
    expect(info?.state).toBe('failed');
    expect(info?.error).toBe('Critical package cannot skip startup: feature disabled');
  });

  // 4. Continues starting other packages after one fails
  it('continues starting other packages after one fails', async () => {
    const packages: MakaioExtension[] = [
      makePackage('fails', {
        create: (ctx) =>
          makeMockService(ctx.bus, async () => {
            throw new Error('boom');
          }),
      }),
      makePackage('succeeds', {
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load(packages);
    await coordinator.startAll();

    const list = coordinator.list();
    expect(list.find((e) => e.name === 'fails')?.state).toBe('failed');
    expect(list.find((e) => e.name === 'succeeds')?.state).toBe('active');
  });

  // 5. Shutdown in reverse dependency order
  it('shuts down packages in reverse dependency order', async () => {
    const shutdownOrder: string[] = [];

    const packages: MakaioExtension[] = [
      makePackage('a', {
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, () => {
            shutdownOrder.push('a');
          }),
      }),
      makePackage('b', {
        dependencies: [dep('a')],
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, () => {
            shutdownOrder.push('b');
          }),
      }),
      makePackage('c', {
        dependencies: [dep('b')],
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, () => {
            shutdownOrder.push('c');
          }),
      }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load(packages);
    await coordinator.startAll();
    await coordinator.shutdown();

    // c depends on b depends on a -> shutdown order: c, b, a
    expect(shutdownOrder).toEqual(['c', 'b', 'a']);
  });

  // 6. Cycle detection
  it('throws on circular dependency during load', () => {
    const packages: MakaioExtension[] = [
      makePackage('x', { dependencies: [dep('y')] }),
      makePackage('y', { dependencies: [dep('x')] }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    expect(() => coordinator.load(packages)).toThrow(/circular dependency/i);
  });

  // 7. Missing declared dependency throws
  it('throws when a package declares a dependency not present in the loaded set', () => {
    const packages: MakaioExtension[] = [makePackage('child', { dependencies: [dep('missing-parent')] })];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    expect(() => coordinator.load(packages)).toThrow(/missing dependencies: missing-parent/i);
  });

  // 7b. Package override
  it('uses the later package when two packages share the same name', async () => {
    const initFirst = vi.fn();
    const initSecond = vi.fn();
    const packages: MakaioExtension[] = [
      makePackage('dup', { create: (ctx) => makeMockService(ctx.bus, initFirst) }),
      makePackage('dup', { create: (ctx) => makeMockService(ctx.bus, initSecond) }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load(packages);
    await coordinator.startAll();

    expect(initFirst).not.toHaveBeenCalled();
    expect(initSecond).toHaveBeenCalledOnce();
    expect(coordinator.list()).toHaveLength(1);
  });

  // 8. Single-use invariant
  it('throws when load is called twice', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('a')]);
    expect(() => coordinator.load([makePackage('b')])).toThrow(/load\(\) called twice/);
  });

  // 8b. startAll() before load
  it('startAll() throws when called before load', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    await expect(coordinator.startAll()).rejects.toThrow(/called before load/);
  });

  // 8c. startAll() single-use invariant
  it('startAll() throws when called twice', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('a')]);
    await coordinator.startAll();
    await expect(coordinator.startAll()).rejects.toThrow(/startAll\(\) called twice/);
  });

  // 8d. Dependent failure propagation
  it('package fails when a dependency failed', async () => {
    const packages: MakaioExtension[] = [
      makePackage('a', {
        create: (ctx) =>
          makeMockService(ctx.bus, async () => {
            throw new Error('a exploded');
          }),
      }),
      makePackage('b', {
        dependencies: [dep('a')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load(packages);
    await coordinator.startAll();

    const list = coordinator.list();
    expect(list.find((e) => e.name === 'a')?.state).toBe('failed');
    const bInfo = list.find((e) => e.name === 'b');
    expect(bInfo?.state).toBe('failed');
    expect(bInfo?.error).toMatch(/Required dependencies not active: a/);
  });

  it('starts a package when an optional dependency is absent', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('child', {
        dependencies: [optionalDep('missing-optional')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);

    await coordinator.startAll();

    expect(coordinator.list().find((e) => e.name === 'child')?.state).toBe('active');
  });

  it('starts a package when an optional dependency failed', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('optional-parent', {
        create: (ctx) =>
          makeMockService(ctx.bus, async () => {
            throw new Error('optional failed');
          }),
      }),
      makePackage('child', {
        dependencies: [optionalDep('optional-parent')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);

    await coordinator.startAll();

    expect(coordinator.list().find((e) => e.name === 'optional-parent')?.state).toBe('failed');
    expect(coordinator.list().find((e) => e.name === 'child')?.state).toBe('active');
  });

  // 9. list() returns current state
  it('list() reflects state after start', async () => {
    const packages: MakaioExtension[] = [
      makePackage('ext-a', { create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('ext-b', {
        create: (ctx) =>
          makeMockService(ctx.bus, async () => {
            throw new Error('oops');
          }),
      }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load(packages);
    await coordinator.startAll();

    const list = coordinator.list();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.name === 'ext-a')).toMatchObject({
      name: 'ext-a',
      displayName: 'ext-a',
      state: 'active',
      enabled: true,
    });
    expect(list.find((e) => e.name === 'ext-b')).toMatchObject({
      name: 'ext-b',
      state: 'failed',
      enabled: true,
      error: 'oops',
    });
  });

  // 10. Packages without a create function become active
  it('marks packages with no create function as active', async () => {
    const pkg = makePackage('no-service');
    // no create property

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([pkg]);
    await coordinator.startAll();

    expect(coordinator.list()[0]?.state).toBe('active');
  });

  // 11. Shutdown is safe when startAll was never called
  it('shutdown() is safe when startAll was never called', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('safe')]);
    await expect(coordinator.shutdown()).resolves.toBeUndefined();
  });

  // 12. list RPC subject is served by the coordinator
  it('serves the extension.list RPC after load', async () => {
    const packages: MakaioExtension[] = [makePackage('rpc-ext', { create: (ctx) => makeMockService(ctx.bus) })];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load(packages);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.list, {});
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]).toMatchObject({ name: 'rpc-ext', state: 'active', enabled: true });

    await coordinator.shutdown();
  });

  it('serves active provider and client contributions through the catalog RPC', async () => {
    const providerDefinition: ProviderDefinition = {
      id: 'openai',
      name: 'OpenAI',
      authMethods: [],
      availableModels: [],
    };
    const clientDefinition = createClientDefinition({
      id: 'codex',
      name: 'Codex',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'full-access',
    });
    const packages: MakaioExtension[] = [
      makePackage('catalog-ext', {
        providers: [providerDefinition],
        clients: [clientDefinition],
        create: (ctx) => makeMockService(ctx.bus),
      }),
      makePackage('disabled-ext', {
        providers: [{ id: 'disabled-provider', name: 'Disabled Provider', authMethods: [], availableModels: [] }],
      }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => name !== 'disabled-ext',
    });
    coordinator.load(packages);

    expect(coordinator.getLoadedProviderDefinitionIds()).toEqual(new Set(['openai']));

    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.contributions.catalog, {});

    expect(result.providers).toEqual([{ packageName: 'catalog-ext', definition: providerDefinition }]);
    expect(result.clients).toEqual([{ packageName: 'catalog-ext', definition: clientDefinition }]);
    expect(coordinator.getLoadedProviderDefinitionIds()).toEqual(new Set(['openai']));

    await coordinator.shutdown();
  });

  // 13. Shutdown continues even when destroy throws, and reports it afterwards
  it('continues shutdown even when a destroy throws', async () => {
    const shutdownOrder: string[] = [];

    const packages: MakaioExtension[] = [
      makePackage('a', {
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, () => {
            shutdownOrder.push('a');
          }),
      }),
      makePackage('b', {
        dependencies: [dep('a')],
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, async () => {
            throw new Error('destroy error in b');
          }),
      }),
      makePackage('c', {
        dependencies: [dep('b')],
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, () => {
            shutdownOrder.push('c');
          }),
      }),
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load(packages);
    await coordinator.startAll();

    const rejection = await coordinator.shutdown().then(
      () => undefined,
      (error: unknown) => error,
    );

    // c and a should still have shut down despite b throwing
    expect(shutdownOrder).toContain('c');
    expect(shutdownOrder).toContain('a');
    // …and the host must not be told the drain completed.
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).message).toContain('b');
    expect((rejection as AggregateError).errors).toHaveLength(1);
  });

  it('reports a storage cleanup failure to the host after stopping every extension', async () => {
    const shutdownOrder: string[] = [];
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('storage-failing', {
        create: (ctx) => makeMockService(ctx.bus),
        storage: {
          registerHandlers: () => () => {
            throw new Error('storage cleanup failed');
          },
        },
      }),
      makePackage('storage-dependent', {
        dependencies: [dep('storage-failing')],
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, () => {
            shutdownOrder.push('storage-dependent');
          }),
      }),
    ]);
    await coordinator.startAll();

    const rejection = await coordinator.shutdown().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(shutdownOrder).toEqual(['storage-dependent']);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).message).toContain('storage-failing');
  });

  it('reports an unclean disable through the primitive as applied and still announces', async () => {
    const enabledChanged = Promise.withResolvers<{ name: string; enabled: boolean }>();
    bus.on(ExtensionSubjects.enabledChanged, (ctx) => {
      enabledChanged.resolve({ name: ctx.payload.name, enabled: ctx.payload.enabled });
    });

    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('unclean-disable-primitive', {
        create: (ctx) =>
          makeMockService(ctx.bus, undefined, () => {
            throw new Error('teardown failed');
          }),
      }),
    ]);
    await coordinator.startAll();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await coordinator.applyExtensionTransition('unclean-disable-primitive', false);
    consoleSpy.mockRestore();

    // The extension really is stopped, but teardown left a failure behind on
    // `entry.error`. That failure does not change the outcome: the runtime
    // did reach `stopped`, so this still reports `'applied'` and still
    // announces `enabledChanged` — 'applied-unclean' no longer exists as a
    // separate outcome.
    expect(outcome).toBe('applied');
    const info = coordinator.list()[0];
    expect(info?.state).toBe('stopped');
    expect(info?.error).toContain('teardown failed');
    await expect(enabledChanged.promise).resolves.toEqual({ name: 'unclean-disable-primitive', enabled: false });

    await coordinator.shutdown();
  });

  // 14. Window registration during load
  it('registers windows into windowRegistry during load', () => {
    const pkg = makePackage('windowed', {
      windows: [{ id: 'main', style: 'utility' }],
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([pkg]);

    expect(coordinator.windowRegistry.size).toBe(1);
    const reg = coordinator.windowRegistry.get('windowed:main');
    expect(reg).toBeDefined();
    expect(reg?.packageName).toBe('windowed');
  });

  // 15. Tray entries collected during load
  it('collects tray entries during load and registers them during startAll', async () => {
    const registeredEntries: TrayMenuEntry[] = [];
    bus.on(TrayMenuSubjects.register, (ctx) => {
      registeredEntries.push(TrayMenuEntrySchema.parse(ctx.payload.entry));
      ctx.setResult({ entryId: ctx.payload.entry.entryId });
    });
    const pkg = makePackage('tray-pkg', {
      tray: { label: 'My Tool', section: 'tools' },
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([pkg]);

    expect(coordinator.trayEntries).toHaveLength(1);
    expect(coordinator.trayEntries[0]).toMatchObject({ label: 'My Tool', section: 'tools' });
    (coordinator.trayEntries as Array<TrayManifest & { readonly packageName: string }>).push({
      label: 'Mutated',
      packageName: 'external',
    });
    expect(coordinator.trayEntries).toHaveLength(1);

    await coordinator.startAll();
    expect(registeredEntries[0]).toMatchObject({
      packageName: 'tray-pkg',
      entryId: 'default',
      label: 'My Tool',
      section: 'tools',
    });
  });

  // 16. loadEnabled: packages disabled at boot are skipped
  it('skips packages whose loadEnabled returns false at boot', async () => {
    const initFn = vi.fn();
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'disabled-pkg' ? false : undefined),
    });

    coordinator.load([
      makePackage('disabled-pkg', {
        http: { prefix: '/disabled', mount: vi.fn() },
        create: (ctx) => makeMockService(ctx.bus, initFn),
      }),
      makePackage('enabled-pkg', {
        http: { prefix: '/enabled', mount: vi.fn() },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);

    expect(coordinator.extensionsWithHttp().map((pkg) => pkg.http.prefix)).toEqual(['/enabled']);

    await coordinator.startAll();

    expect(initFn).not.toHaveBeenCalled();
    const list = coordinator.list();
    expect(list.find((e) => e.name === 'disabled-pkg')).toMatchObject({
      state: 'skipped',
      enabled: false,
    });
    expect(list.find((e) => e.name === 'enabled-pkg')).toMatchObject({
      state: 'active',
      enabled: true,
    });
  });

  // ---------------------------------------------------------------------------
  // extensionManagedNames: framework packages vs. operator-managed extensions
  // ---------------------------------------------------------------------------

  it('refuses setEnabled for a non-managed (framework) package before any write', async () => {
    const persistEnabled = vi.fn(async (_name: string, _enabled: boolean) => undefined);
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      // 'framework-pkg' is absent from this set, so it is not operator-managed.
      extensionManagedNames: new Set(['managed-ext']),
      persistEnabled,
    });

    coordinator.load([
      makePackage('framework-pkg', { create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('managed-ext', { create: (ctx) => makeMockService(ctx.bus) }),
    ]);
    await coordinator.startAll();

    await expect(bus.request(ExtensionSubjects.setEnabled, { name: 'framework-pkg', enabled: false })).rejects.toThrow(
      /framework packages are always loaded and have no operator enablement preference/i,
    );
    expect(persistEnabled).not.toHaveBeenCalled();

    // A managed name in the same coordinator is unaffected by the refusal.
    const managedResult = await bus.request(ExtensionSubjects.setEnabled, { name: 'managed-ext', enabled: false });
    expect(managedResult.outcome).toBe('restart-required');
    expect(persistEnabled).toHaveBeenCalledWith('managed-ext', false);

    await coordinator.shutdown();
  });

  it('reports extensionManaged and omits persistedEnabled for a non-managed (framework) package', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      extensionManagedNames: new Set(['managed-ext']),
      // Would report `persistedEnabled: true` for a managed entry; must never
      // be consulted for the non-managed one.
      loadEnabled: () => true,
    });

    coordinator.load([
      makePackage('framework-pkg', { create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('managed-ext', { create: (ctx) => makeMockService(ctx.bus) }),
    ]);
    await coordinator.startAll();

    const framework = coordinator.list().find((e) => e.name === 'framework-pkg');
    expect(framework).toMatchObject({ extensionManaged: false, enabled: true });
    expect(framework?.persistedEnabled).toBeUndefined();
    expect(coordinator.getInfo('framework-pkg')?.persistedEnabled).toBeUndefined();

    const managed = coordinator.list().find((e) => e.name === 'managed-ext');
    expect(managed).toMatchObject({ extensionManaged: true, persistedEnabled: true });

    await coordinator.shutdown();
  });

  it('boots a non-managed (framework) package enabled even when loadEnabled would return false for its name', async () => {
    const initFn = vi.fn();
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      // Nothing is extension-managed here, so 'framework-pkg' is a framework
      // package even though `loadEnabled` below would disable everything if
      // it were ever consulted for it.
      extensionManagedNames: new Set(),
      loadEnabled: () => false,
    });

    coordinator.load([makePackage('framework-pkg', { create: (ctx) => makeMockService(ctx.bus, initFn) })]);
    await coordinator.startAll();

    expect(initFn).toHaveBeenCalledOnce();
    expect(coordinator.getInfo('framework-pkg')).toMatchObject({
      state: 'active',
      enabled: true,
      extensionManaged: false,
    });

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Disabled entries are excluded from fatal dependency-graph validation
  // ---------------------------------------------------------------------------

  it('does not abort boot for a disabled extension declaring a missing dependency, and records the reason on its entry', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'orphan-disabled' ? false : undefined),
    });

    expect(() =>
      coordinator.load([makePackage('orphan-disabled', { dependencies: [dep('missing-thing')] })]),
    ).not.toThrow();

    await coordinator.startAll();

    const info = coordinator.getInfo('orphan-disabled');
    expect(info).toMatchObject({ state: 'skipped', enabled: false });
    expect(info?.error).toMatch(/missing dependencies: missing-thing/i);

    await coordinator.shutdown();
  });

  it('does not abort boot for a cycle running only through disabled extensions, and records it on both entries', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'cycle-a' || name === 'cycle-b' ? false : undefined),
    });

    expect(() =>
      coordinator.load([
        makePackage('cycle-a', { dependencies: [dep('cycle-b')] }),
        makePackage('cycle-b', { dependencies: [dep('cycle-a')] }),
      ]),
    ).not.toThrow();

    await coordinator.startAll();

    const infoA = coordinator.getInfo('cycle-a');
    const infoB = coordinator.getInfo('cycle-b');
    expect(infoA).toMatchObject({ state: 'skipped', enabled: false });
    expect(infoB).toMatchObject({ state: 'skipped', enabled: false });
    expect(infoA?.error).toMatch(/circular dependency detected among disabled packages/i);
    expect(infoB?.error).toMatch(/circular dependency detected among disabled packages/i);

    await coordinator.shutdown();
  });

  it('still aborts boot for an enabled extension declaring a missing dependency (fatal semantics preserved)', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      extensionManagedNames: new Set(['broken-ext']),
      loadEnabled: () => true,
    });

    expect(() => coordinator.load([makePackage('broken-ext', { dependencies: [dep('missing-thing')] })])).toThrow(
      /missing dependencies: missing-thing/i,
    );
  });

  it('still aborts boot for a cycle involving at least one enabled extension', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'mixed-cycle-b' ? false : undefined),
    });

    expect(() =>
      coordinator.load([
        makePackage('mixed-cycle-a', { dependencies: [dep('mixed-cycle-b')] }),
        makePackage('mixed-cycle-b', { dependencies: [dep('mixed-cycle-a')] }),
      ]),
    ).toThrow(/circular dependency detected among: mixed-cycle-a, mixed-cycle-b/i);
  });

  // ---------------------------------------------------------------------------
  // handleSetEnabled classification of the discovered state (between load()
  // and startAll())
  // ---------------------------------------------------------------------------

  it('classifies a discovered, boot-enabled entry by its own enabled flag rather than "inactive"', async () => {
    const persisted: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async (name, enabled) => {
        persisted.push({ name, enabled });
      },
    });

    coordinator.load([makePackage('discovered-enabled-ext', { create: (ctx) => makeMockService(ctx.bus) })]);

    // load() ran (the RPC handler exists) but startAll() has not, so the
    // entry is still 'discovered' with `enabled: true` from the boot-time
    // preference.
    expect(coordinator.getInfo('discovered-enabled-ext')).toMatchObject({ state: 'discovered', enabled: true });

    // A disable request here diverges from the direction the entry is
    // already headed (it is about to start), so it truthfully needs a
    // restart even though a naive `state === 'active'` check would call it
    // already 'applied'.
    const disableResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'discovered-enabled-ext',
      enabled: false,
    });
    expect(disableResult).toEqual({ success: false, outcome: 'restart-required' });
    expect(persisted).toContainEqual({ name: 'discovered-enabled-ext', enabled: false });

    // Requesting the direction the entry is already headed reports 'applied'
    // even though it has not started yet.
    const enableResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'discovered-enabled-ext',
      enabled: true,
    });
    expect(enableResult).toEqual({ success: true, outcome: 'applied' });
    expect(persisted).toContainEqual({ name: 'discovered-enabled-ext', enabled: true });

    // handleSetEnabled never mutates `entry.enabled`; startAll() reads the
    // same boot-time preference it always would have.
    await coordinator.startAll();
    expect(coordinator.getInfo('discovered-enabled-ext')).toMatchObject({ state: 'active', enabled: true });

    await coordinator.shutdown();
  });

  it('reports restart-required for an enable request while a boot-disabled entry is still discovered', async () => {
    const persisted: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'discovered-disabled-ext' ? false : undefined),
      persistEnabled: async (name, enabled) => {
        persisted.push({ name, enabled });
      },
    });

    coordinator.load([makePackage('discovered-disabled-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    expect(coordinator.getInfo('discovered-disabled-ext')).toMatchObject({ state: 'discovered', enabled: false });

    // `handleSetEnabled` persists the new preference but never mutates
    // `entry.enabled`, so the upcoming `startAll()` is still about to skip
    // this entry regardless — only a process restart picks the new
    // preference up.
    const enableResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'discovered-disabled-ext',
      enabled: true,
    });
    expect(enableResult).toEqual({ success: false, outcome: 'restart-required' });
    expect(persisted).toContainEqual({ name: 'discovered-disabled-ext', enabled: true });

    await coordinator.startAll();
    expect(coordinator.getInfo('discovered-disabled-ext')).toMatchObject({ state: 'skipped', enabled: false });

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Surface collection dependency closure
  // ---------------------------------------------------------------------------

  it('excludes an enabled package from static surface collection when a required dependency is disabled', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'dep-a' ? false : undefined),
    });

    coordinator.load([
      makePackage('dep-a', {}),
      makePackage('ext-b', {
        dependencies: [dep('dep-a')],
        windows: [{ id: 'main', style: 'utility' }],
        cli: makeCliContribution('ext-b-cmd'),
      }),
    ]);

    // `ext-b` is itself preference-enabled, but its required dependency
    // `dep-a` is disabled, so `startExtensionEntry` will refuse it at
    // `startAll` time. Its windows and CLI contribution must never have been
    // registered — they would otherwise remain dispatchable (e.g. through
    // `cli.execute`) for code that is guaranteed never to become active.
    expect(coordinator.windowRegistry.size).toBe(0);
    expect(coordinator.cliContributions.find((c) => c.name === 'ext-b-cmd')).toBeUndefined();
    expect(coordinator.cliContributions).toHaveLength(0);
  });

  it('excludes a package from static surface collection when a dependency is transitively blocked', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'root-dep' ? false : undefined),
    });

    coordinator.load([
      makePackage('root-dep', {}),
      makePackage('middle', {
        dependencies: [dep('root-dep')],
        windows: [{ id: 'middle-window', style: 'utility' }],
      }),
      makePackage('leaf', {
        dependencies: [dep('middle')],
        windows: [{ id: 'leaf-window', style: 'utility' }],
        cli: makeCliContribution('leaf-cmd'),
      }),
    ]);

    // `middle` is excluded directly (its own dependency `root-dep` is
    // disabled); `leaf` is excluded transitively because its own dependency
    // `middle` never joins the closed set. Neither package's surfaces may be
    // registered.
    expect(coordinator.windowRegistry.size).toBe(0);
    expect(coordinator.cliContributions).toHaveLength(0);
  });

  it('still collects static surfaces when a disabled dependency is optional', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'optional-dep' ? false : undefined),
    });

    coordinator.load([
      makePackage('optional-dep', {}),
      makePackage('main-ext', {
        dependencies: [optionalDep('optional-dep')],
        windows: [{ id: 'main', style: 'utility' }],
        cli: makeCliContribution('main-ext-cmd'),
      }),
    ]);

    // The disabled dependency is only optional, so `startExtensionEntry`'s
    // own dependency check never rejects `main-ext` on that basis — its
    // surfaces must be collected exactly as they were before the closure was
    // introduced.
    expect(coordinator.windowRegistry.size).toBe(1);
    expect(coordinator.windowRegistry.get('main-ext:main')).toBeDefined();
    expect(coordinator.cliContributions.map((c) => c.name)).toEqual(['main-ext-cmd']);
  });

  // ---------------------------------------------------------------------------
  // Namespace registration dependency closure
  // ---------------------------------------------------------------------------

  it('never attempts to register a disabled extension namespace, so it cannot abort boot on collision', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // A framework namespace registered outside the coordinator, exactly as
      // `framework/core/contracts`'s namespace catalog would before extension
      // boot runs. It wins any later duplicate registration attempt for the
      // same domain because namespace registration is idempotent.
      const frameworkNamespace = createBusNamespace('shared:collide', {
        ping: z.object({ id: z.string() }),
      });
      bus.registerNamespace(frameworkNamespace);

      // The active extension declares the same domain with a schema that
      // drifts from the framework's (an extra required field) — this only
      // ever warns (`warnOnSchemaCollision`), it does not throw.
      const activeNamespace = createBusNamespace('shared:collide', {
        ping: z.object({ id: z.string(), extra: z.string() }),
      });

      // The disabled extension declares the same domain with routing
      // metadata that would throw on collision (`failOnRoutingMetadataCollision`)
      // if it were ever registered: a `localSubject()` cannot silently
      // disagree with the framework's plain event on the same subject key.
      const disabledNamespace = createBusNamespace('shared:collide', {
        ping: localSubject(z.object({ id: z.string() })),
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadEnabled: (name) => (name === 'disabled-ext' ? false : undefined),
      });

      // Registering the disabled extension's namespace would throw and abort
      // load() entirely under the pre-fix behavior (namespaces registered
      // for every entry regardless of `enabled`), defeating disabling it as
      // a recovery path. It must not throw now.
      expect(() =>
        coordinator.load([
          makePackage('active-ext', {
            namespaces: [activeNamespace],
            create: (ctx) => makeMockService(ctx.bus),
          }),
          makePackage('disabled-ext', {
            namespaces: [disabledNamespace],
          }),
        ]),
      ).not.toThrow();

      await coordinator.startAll();

      // The framework's registration wins: the schema at the shared subject
      // still only accepts the framework's shape (no `extra` field required),
      // proving the active extension's colliding registerNamespaces() call
      // returned the existing namespace instead of overwriting it.
      const schema = bus.getSchema('shared:collide.ping') as z.ZodObject<z.ZodRawShape> | undefined;
      expect(schema?.safeParse({ id: 'x' }).success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Namespace 'shared:collide' already registered with different schemas"),
      );

      await coordinator.shutdown();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not register a namespace for an enabled extension whose required dependency is disabled', () => {
    const namespace = createBusNamespace('unreached:ns', {
      ping: z.object({ id: z.string() }),
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'dep-a' ? false : undefined),
    });

    coordinator.load([
      makePackage('dep-a', {}),
      makePackage('ext-b', {
        dependencies: [dep('dep-a')],
        namespaces: [namespace],
      }),
    ]);

    // `ext-b` is preference-enabled but excluded from the dependency closure
    // (`dep-a` is disabled), so it never starts `create`/`init` this process
    // and its namespace must never have been registered.
    expect(bus.getSchema('unreached:ns.ping')).toBeUndefined();
  });

  // 17. persistEnabled is called on every setEnabled request, regardless of outcome
  it('calls persistEnabled callback for every setEnabled request', async () => {
    const persisted: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async (name, enabled) => {
        persisted.push({ name, enabled });
      },
    });

    coordinator.load([makePackage('persist-pkg', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    // `setEnabled` is persist-only: it never runs a live transition, so
    // disabling an `active` extension always persists but reports
    // `restart-required` (the runtime state and the request diverge) rather
    // than `applied`.
    const disableResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'persist-pkg',
      enabled: false,
    });
    expect(disableResult).toEqual({ success: false, outcome: 'restart-required' });
    expect(persisted).toContainEqual({ name: 'persist-pkg', enabled: false });

    // Requesting `enabled: true` while the process's own runtime state is
    // still `active` (setEnabled never moved it) matches, so this one
    // reports `applied`.
    const enableResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'persist-pkg',
      enabled: true,
    });
    expect(enableResult).toEqual({ success: true, outcome: 'applied' });
    expect(persisted).toContainEqual({ name: 'persist-pkg', enabled: true });

    await coordinator.shutdown();
  });

  // `'initializing'` classification: the lifecycle lane serializes every
  // `startAll`/`applyExtensionTransition`/`handleSetEnabled` call against the
  // same entry, and every lane operation transitions an entry away from
  // `'initializing'` before it returns or throws (see `disableExtension`'s and
  // `enableExtension`'s handling of that state in `extension-toggle.ts`), so
  // the full coordinator/bus surface can never observe `handleSetEnabled`
  // running while an entry sits at `'initializing'`. `handleSetEnabled` itself
  // must still classify that state correctly, because a process crash mid
  // `create`/`init` can leave an entry there across a restart of the seam's
  // own reasoning, so these two tests call it directly against a hand-built
  // `ToggleHost` rather than through `bus.request`.
  describe('handleSetEnabled classification of the initializing state', () => {
    /**
     * Build a minimal {@link ToggleHost} that reports a single entry.
     *
     * `handleSetEnabled` only ever reads `host.entries` and calls
     * `host.persistEnabled`; every other {@link ToggleHost} member below exists
     * solely to satisfy the interface and is never invoked by the code path
     * these tests exercise.
     * @param entry - Entry the host's `entries` map reports for its own name.
     * @returns The host, plus the `persistEnabled` spy for assertions.
     */
    function makeToggleHost(entry: ExtensionEntry): { host: ToggleHost; persistEnabled: ReturnType<typeof vi.fn> } {
      const persistEnabled = vi.fn(async (_name: string, _enabled: boolean) => undefined);
      const host: ToggleHost = {
        bus,
        db: undefined,
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadConfig: undefined,
        operatorConfig: undefined,
        signal: new AbortController().signal,
        hasActiveExtension: () => false,
        getExtensionService: () => undefined,
        entries: new Map([[entry.pkg.name, entry]]),
        persistEnabled,
        contributionProcessors: [],
        runHealthCheck: async () => undefined,
        emitWarningsForEntry: async () => undefined,
      };
      return { host, persistEnabled };
    }

    /**
     * Build an {@link ExtensionEntry} sitting at `'initializing'`.
     * @param name - Extension name for the entry's package and identity.
     * @returns An entry whose `state` is `'initializing'`.
     */
    function makeInitializingEntry(name: string): ExtensionEntry {
      return {
        pkg: makePackage(name),
        identity: createExtensionIdentity(name),
        state: 'initializing',
        enabled: true,
        extensionManaged: true,
        warnings: [],
      };
    }

    it('reports restart-required for a disable request while the entry is initializing, and still persists it', async () => {
      const entry = makeInitializingEntry('initializing-disable-ext');
      const { host, persistEnabled } = makeToggleHost(entry);

      const result = await handleSetEnabled(host, entry.pkg.name, false);

      // 'initializing' resolves through the normal lifecycle to 'active', so a
      // disable persisted while it is mid-flight needs a restart to take
      // effect exactly as it would once the extension reached 'active' —
      // treating it as already-satisfied (as a naive `state === 'active'`
      // check would) would silently report the wrong outcome.
      expect(result).toEqual({ success: false, outcome: 'restart-required' });
      expect(persistEnabled).toHaveBeenCalledWith(entry.pkg.name, false);
    });

    it('reports applied for an enable request while the entry is initializing, since it is already headed to active', async () => {
      const entry = makeInitializingEntry('initializing-enable-ext');
      const { host, persistEnabled } = makeToggleHost(entry);

      const result = await handleSetEnabled(host, entry.pkg.name, true);

      expect(result).toEqual({ success: true, outcome: 'applied' });
      expect(persistEnabled).toHaveBeenCalledWith(entry.pkg.name, true);
    });
  });

  it('never lets a stale boot-time loadEnabled snapshot suppress a setEnabled write', async () => {
    // `loadEnabled` is an explicit boot snapshot (see its TSDoc on
    // `ExtensionCoordinatorOptions`): it is read once, at `load()`, to seed
    // `entry.enabled`, and it must never again decide whether `setEnabled`
    // persists. This test's `loadEnabled` never reflects the writes below —
    // it always reports the name as enabled, as if a hand-edit to the
    // enablement file after boot removed it from the disabled set. If
    // `handleSetEnabled` consulted this cache to decide "did the preference
    // actually change" before writing, it would see no change and skip the
    // write. It must persist unconditionally instead.
    const persisted: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: () => true,
      persistEnabled: async (name, enabled) => {
        persisted.push({ name, enabled });
      },
    });

    coordinator.load([makePackage('stale-cache-pkg', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    await bus.request(ExtensionSubjects.setEnabled, { name: 'stale-cache-pkg', enabled: false });
    await bus.request(ExtensionSubjects.setEnabled, { name: 'stale-cache-pkg', enabled: false });
    await bus.request(ExtensionSubjects.setEnabled, { name: 'stale-cache-pkg', enabled: true });

    // Every request wrote, including the second, identical disable — an
    // idempotent write is exactly what proves nothing was skipped as "already
    // matches the cache".
    expect(persisted).toEqual([
      { name: 'stale-cache-pkg', enabled: false },
      { name: 'stale-cache-pkg', enabled: false },
      { name: 'stale-cache-pkg', enabled: true },
    ]);

    await coordinator.shutdown();
  });

  it('list() reports persistedEnabled from loadEnabled, diverging from enabled after a live setEnabled disable', async () => {
    // `persistedEnabled` must read the durable preference live (through the
    // same `loadEnabled` reader `ExtensionEnablementStore` wires in
    // `@makaio/runtime-node`, whose in-memory disabled set updates on every
    // committed write), not the boot-time snapshot used to seed
    // `entry.enabled`. This double models that store: `disabled` starts
    // empty and is mutated by `persistEnabled`, exactly like the store's own
    // in-memory set.
    const disabled = new Set<string>();
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (disabled.has(name) ? false : undefined),
      persistEnabled: async (name, enabled) => {
        if (enabled) {
          disabled.delete(name);
        } else {
          disabled.add(name);
        }
      },
    });

    coordinator.load([makePackage('persisted-enabled-pkg', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    expect(coordinator.list().find((e) => e.name === 'persisted-enabled-pkg')).toMatchObject({
      enabled: true,
      persistedEnabled: true,
    });

    // The operator disables the still-active extension: the preference is
    // persisted, but setEnabled is persist-only, so the running process keeps
    // reporting `enabled: true` until a restart.
    const result = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'persisted-enabled-pkg',
      enabled: false,
    });
    expect(result.outcome).toBe('restart-required');

    expect(coordinator.list().find((e) => e.name === 'persisted-enabled-pkg')).toMatchObject({
      enabled: true,
      persistedEnabled: false,
    });

    await coordinator.shutdown();
  });

  it('omits persistedEnabled from list() and get() when the coordinator has no loadEnabled reader', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([makePackage('no-loadEnabled-pkg', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    const listed = coordinator.list().find((e) => e.name === 'no-loadEnabled-pkg');
    expect(listed).not.toHaveProperty('persistedEnabled');

    const { extension } = await bus.request(ExtensionSubjects.get, { name: 'no-loadEnabled-pkg' });
    expect(extension).not.toHaveProperty('persistedEnabled');

    await coordinator.shutdown();
  });

  it('rejects setEnabled when persistEnabled fails and does not emit enabledChanged', async () => {
    const enabledChanged = vi.fn();
    bus.on(ExtensionSubjects.enabledChanged, enabledChanged);

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async () => {
        throw new Error('persist failed');
      },
    });

    coordinator.load([makePackage('persist-fails', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    await expect(
      bus.request(ExtensionSubjects.setEnabled, {
        name: 'persist-fails',
        enabled: false,
      }),
    ).rejects.toThrow('persist failed');

    expect(enabledChanged).not.toHaveBeenCalled();
    expect(coordinator.list().find((entry) => entry.name === 'persist-fails')).toMatchObject({
      state: 'active',
      enabled: true,
    });

    await coordinator.shutdown();
  });

  it('retries a toggle after persistence fails without mutating runtime state', async () => {
    const persisted: boolean[] = [];
    let failFirstPersist = true;
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async (_name, enabled) => {
        persisted.push(enabled);
        if (failFirstPersist) {
          failFirstPersist = false;
          throw new Error('persist failed');
        }
      },
    });

    coordinator.load([makePackage('persist-retry', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    await expect(
      bus.request(ExtensionSubjects.setEnabled, {
        name: 'persist-retry',
        enabled: false,
      }),
    ).rejects.toThrow('persist failed');

    const retryResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'persist-retry',
      enabled: false,
    });

    // `setEnabled` never mutates runtime state (persist-only), so the retry
    // persists cleanly but still reports `restart-required`: the package is
    // still `active` and the request asks for `enabled: false`.
    expect(retryResult).toEqual({ success: false, outcome: 'restart-required' });
    expect(persisted).toEqual([false, false]);

    await coordinator.shutdown();
  });

  it('recovers a failed extension through the coordinator-internal restart primitive', async () => {
    const events: Array<{ name: string; enabled: boolean }> = [];
    let initAttempts = 0;
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('lifecycle-recovery', {
        create: (ctx) =>
          makeMockService(ctx.bus, () => {
            initAttempts += 1;
            if (initAttempts === 1) throw new Error('initial startup failure');
          }),
      }),
    ]);
    await coordinator.startAll();
    expect(coordinator.list().find((entry) => entry.name === 'lifecycle-recovery')).toMatchObject({
      state: 'failed',
      enabled: true,
    });

    bus.on(ExtensionSubjects.enabledChanged, (ctx) => {
      events.push({ name: ctx.payload.name, enabled: ctx.payload.enabled });
    });

    // `setEnabled` is persist-only and would never re-run `create`/`init` for
    // a `failed` entry — recovering it is exactly what
    // `applyExtensionTransition` is for.
    const retryOutcome = await coordinator.applyExtensionTransition('lifecycle-recovery', true);

    expect(retryOutcome).toBe('applied');
    expect(coordinator.list().find((entry) => entry.name === 'lifecycle-recovery')).toMatchObject({
      state: 'active',
      enabled: true,
    });
    expect(events).toContainEqual({ name: 'lifecycle-recovery', enabled: true });

    await coordinator.shutdown();
  });

  // 18. Storage cleanup is called when a package is disabled
  it('invokes storageCleanup when a package is disabled via setEnabled', async () => {
    const storageCleanup = vi.fn();
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('storage-pkg', {
        create: (ctx) => makeMockService(ctx.bus),
        storage: {
          registerHandlers: (_b, _db) => storageCleanup,
        },
      }),
    ]);
    await coordinator.startAll();

    expect(storageCleanup).not.toHaveBeenCalled();

    await coordinator.applyExtensionTransition('storage-pkg', false);

    expect(storageCleanup).toHaveBeenCalledOnce();

    await coordinator.shutdown();
  });

  // 19. Re-enable fails when a dependency is not active
  it('fails re-enable when a declared dependency is not active', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('dep', {
        create: (ctx) =>
          makeMockService(ctx.bus, async () => {
            throw new Error('dep failed');
          }),
      }),
      makePackage('child', {
        dependencies: [dep('dep')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    // Both are now failed or skipped — try to re-enable child (dep is still failed)
    const result = await coordinator.applyExtensionTransition('child', true);
    expect(result).toBe('rejected');
    const info = coordinator.list().find((e) => e.name === 'child');
    expect(info?.state).toBe('failed');
    expect(info?.error).toMatch(/Required dependencies not active: dep/);

    await coordinator.shutdown();
  });

  // 20. Storage handlers are re-registered when a package is re-enabled
  it('re-registers storage handlers when a package is re-enabled', async () => {
    const registerHandlers = vi.fn().mockReturnValue(vi.fn());
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('re-storage-pkg', {
        create: (ctx) => makeMockService(ctx.bus),
        storage: { registerHandlers },
      }),
    ]);
    await coordinator.startAll();

    expect(registerHandlers).toHaveBeenCalledOnce();

    // Disable then re-enable
    await coordinator.applyExtensionTransition('re-storage-pkg', false);
    await coordinator.applyExtensionTransition('re-storage-pkg', true);

    expect(registerHandlers).toHaveBeenCalledTimes(2);

    await coordinator.shutdown();
  });

  it('refuses to activate a boot-skipped entry through the internal restart primitive', async () => {
    // A package disabled at boot never runs `create`/`init` this process —
    // `startExtensionEntry` transitions it straight to `'skipped'` without
    // collecting its static surfaces. `applyExtensionTransition` must never
    // activate it: none of its boot-only contribution surfaces (namespaces,
    // client definitions, runtimeOwnership, runtimeBoot.configure(),
    // storage.migrations) were ever composed, and there is no seam to replay
    // them for one package in isolation after boot has moved on.
    const createFn = vi.fn((ctx: { bus: IMakaioBus }) => makeMockService(ctx.bus));
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: () => false,
    });

    coordinator.load([
      makePackage('boot-skipped-pkg', {
        create: createFn,
      }),
    ]);
    await coordinator.startAll();

    const bootInfo = coordinator.list().find((e) => e.name === 'boot-skipped-pkg');
    expect(bootInfo).toMatchObject({ state: 'skipped', enabled: false });
    expect(createFn).not.toHaveBeenCalled();

    const outcome = await coordinator.applyExtensionTransition('boot-skipped-pkg', true);

    expect(outcome).toBe('rejected');
    expect(createFn).not.toHaveBeenCalled();
    const afterInfo = coordinator.list().find((e) => e.name === 'boot-skipped-pkg');
    expect(afterInfo?.state).toBe('skipped');
    expect(afterInfo?.error).toMatch(/restart is required/i);

    await coordinator.shutdown();
  });

  it('passes the package context to storage handlers', async () => {
    const registerHandlers = vi.fn();
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('storage-context-pkg', {
        storage: { registerHandlers },
      }),
    ]);
    await coordinator.startAll();

    expect(registerHandlers).toHaveBeenCalledOnce();
    const storageContext = registerHandlers.mock.calls[0]?.[2];
    expect(storageContext).toMatchObject({
      bus,
      platform: TEST_PKG_CTX_BASE.platform,
      homedir: TEST_PKG_CTX_BASE.homedir,
      makaioHome: TEST_PKG_CTX_BASE.makaioHome,
      dataDir: '/home/test/.makaio/data/storage-context-pkg',
      username: TEST_PKG_CTX_BASE.username,
      machineId: TEST_PKG_CTX_BASE.machineId,
    });
    expect(storageContext?.identity.extensionName).toBe('storage-context-pkg');
    expect(typeof storageContext?.getService).toBe('function');
    expect(typeof storageContext?.hasExtension).toBe('function');

    await coordinator.shutdown();
  });

  it('cleans up re-registered storage handlers when re-enable fails', async () => {
    const storageCleanup = vi.fn();
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('failing-reenable-pkg', {
        create: () => {
          throw new Error('boom');
        },
        storage: { registerHandlers: () => storageCleanup },
      }),
    ]);
    await coordinator.startAll();

    const result = await coordinator.applyExtensionTransition('failing-reenable-pkg', true);
    expect(result).toBe('rejected');
    // Called twice: once during startAll failure (startEntry cleanup)
    // and once during re-enable failure (cleanupFailedEnable).
    expect(storageCleanup).toHaveBeenCalledTimes(2);
  });

  it('rejects disable when active dependents still require the package', async () => {
    const enabledChanged = vi.fn();
    bus.on(ExtensionSubjects.enabledChanged, enabledChanged);
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('dep', { create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('child', {
        dependencies: [dep('dep')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    const result = await coordinator.applyExtensionTransition('dep', false);

    expect(result).toBe('rejected');
    const depInfo = coordinator.list().find((entry) => entry.name === 'dep');
    expect(depInfo).toMatchObject({
      state: 'active',
      enabled: true,
    });
    expect(enabledChanged).not.toHaveBeenCalled();

    await coordinator.shutdown();
  });

  it('allows disabling a package that is only an optional dependency of active dependents', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('dep', { create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('child', {
        dependencies: [optionalDep('dep')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    const result = await coordinator.applyExtensionTransition('dep', false);

    expect(result).toBe('applied');
    expect(coordinator.list().find((entry) => entry.name === 'dep')).toMatchObject({
      state: 'stopped',
      enabled: false,
    });
    expect(coordinator.list().find((entry) => entry.name === 'child')).toMatchObject({
      state: 'active',
      enabled: true,
    });

    await coordinator.shutdown();
  });

  it('clears a stale disable error after the package can be stopped successfully', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('dep', { create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('child', {
        dependencies: [dep('dep')],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    const blocked = await coordinator.applyExtensionTransition('dep', false);
    expect(blocked).toBe('rejected');
    expect(coordinator.list().find((entry) => entry.name === 'dep')?.error).toContain('active dependents remain');

    await coordinator.applyExtensionTransition('child', false);
    const disabled = await coordinator.applyExtensionTransition('dep', false);
    const depInfo = coordinator.list().find((entry) => entry.name === 'dep');

    expect(disabled).toBe('applied');
    expect(depInfo).toMatchObject({
      state: 'stopped',
      enabled: false,
    });
    expect(depInfo?.error).toBeUndefined();

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Critical guard tests
  // ---------------------------------------------------------------------------

  // Critical guard: disable rejected for critical packages
  it('rejects setEnabled(false) for a critical extension with a clear error', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async () => undefined,
    });
    coordinator.load([
      makePackage('critical-ext', {
        critical: true,
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    await expect(bus.request(ExtensionSubjects.setEnabled, { name: 'critical-ext', enabled: false })).rejects.toThrow(
      /Cannot disable critical extension "critical-ext"/,
    );

    // Extension must remain active after the rejected attempt.
    const info = coordinator.list().find((e) => e.name === 'critical-ext');
    expect(info?.state).toBe('active');
    expect(info?.enabled).toBe(true);

    await coordinator.shutdown();
  });

  // Critical guard: persistEnabled not called when disable is rejected
  it('does not call persistEnabled when disabling a critical extension is rejected', async () => {
    const persisted: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async (name, enabled) => {
        persisted.push({ name, enabled });
      },
    });
    coordinator.load([
      makePackage('critical-ext', {
        critical: true,
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    await expect(bus.request(ExtensionSubjects.setEnabled, { name: 'critical-ext', enabled: false })).rejects.toThrow();
    expect(persisted).toHaveLength(0);

    await coordinator.shutdown();
  });

  // No durable enablement store: setEnabled must not silently no-op
  it('rejects setEnabled with a clear error when the coordinator has no persistEnabled writer', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('no-store-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    // A coordinator built without `persistEnabled` (e.g. an isolated,
    // headless workflow runtime that never wires a durable enablement file)
    // must refuse the request outright rather than reporting `success`/
    // `'applied'` for a write that never happened.
    await expect(bus.request(ExtensionSubjects.setEnabled, { name: 'no-store-ext', enabled: false })).rejects.toThrow(
      /no durable enablement store/,
    );

    // The extension's runtime state must be untouched by the rejected request.
    const info = coordinator.list().find((e) => e.name === 'no-store-ext');
    expect(info?.state).toBe('active');
    expect(info?.enabled).toBe(true);

    await coordinator.shutdown();
  });

  // Boot-time override: critical extension with persisted false starts anyway
  it('starts a critical extension even when loadEnabled returns false and emits a console warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadEnabled: (name) => (name === 'critical-disabled' ? false : undefined),
      });
      coordinator.load([
        makePackage('critical-disabled', {
          critical: true,
          create: (ctx) => makeMockService(ctx.bus),
        }),
      ]);
      await coordinator.startAll();

      const info = coordinator.list().find((e) => e.name === 'critical-disabled');
      expect(info?.state).toBe('active');
      expect(info?.enabled).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Critical extension "critical-disabled" is marked disabled'),
      );

      await coordinator.shutdown();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('settles an enable of an already-active extension as applied, still persisting idempotently', async () => {
    // `setEnabled` persists unconditionally on every request — it must never
    // skip the write because a cached preference looks unchanged (see the
    // `ToggleHost.persistEnabled` contract). The outcome comparison is what
    // reports `'applied'` here: the process's runtime state (`active`)
    // already matches the requested `enabled: true`.
    const disabled = new Set<string>();
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (disabled.has(name) ? false : undefined),
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        await Promise.resolve();
      },
    });
    coordinator.load([makePackage('already-active-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    const beforeInfo = coordinator.list().find((e) => e.name === 'already-active-ext');
    expect(beforeInfo?.state).toBe('active');

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'already-active-ext', enabled: true });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('applied');

    const afterInfo = coordinator.list().find((e) => e.name === 'already-active-ext');
    expect(afterInfo?.state).toBe('active');
    expect(afterInfo?.enabled).toBe(true);
    expect(persistCalls).toEqual([{ name: 'already-active-ext', enabled: true }]);
    expect(disabled.has('already-active-ext')).toBe(false);

    await coordinator.shutdown();
  });

  it('clears a hand-written disabled entry for a boot-forced critical extension on enable, with no recurrence', async () => {
    // The scenario the idempotent-enable fix exists for: a critical extension
    // that boot force-started despite an operator-written disabled entry in
    // the durable store (see the boot-time override test above). A live
    // `extension enable` for it must actually clear that stale entry — and
    // must not restore it moments later via the rejected-transition rollback
    // path, which is what reintroduced the documented warning on every
    // restart before this fix.
    const disabled = new Set<string>(['critical-disabled']);
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadEnabled: (name) => (disabled.has(name) ? false : undefined),
        persistEnabled: async (name, enabled) => {
          persistCalls.push({ name, enabled });
          if (enabled) disabled.delete(name);
          else disabled.add(name);
          await Promise.resolve();
        },
      });
      coordinator.load([
        makePackage('critical-disabled', {
          critical: true,
          create: (ctx) => makeMockService(ctx.bus),
        }),
      ]);
      await coordinator.startAll();

      // Boot force-started it despite the hand-written disabled entry.
      const bootInfo = coordinator.list().find((e) => e.name === 'critical-disabled');
      expect(bootInfo?.state).toBe('active');
      expect(disabled.has('critical-disabled')).toBe(true);

      const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'critical-disabled', enabled: true });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('applied');

      // The stale disabled entry is gone — cleared, not restored by a rollback.
      expect(disabled.has('critical-disabled')).toBe(false);
      expect(persistCalls).toEqual([{ name: 'critical-disabled', enabled: true }]);

      const afterInfo = coordinator.list().find((e) => e.name === 'critical-disabled');
      expect(afterInfo?.state).toBe('active');
      expect(afterInfo?.enabled).toBe(true);

      await coordinator.shutdown();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // A disabled extension still gets a coordinator entry (observable and
  // toggleable), but `setEnabled` is persist-only: it never runs a live
  // transition, so the entry stays `skipped` until the next process restart.
  it('registers a disabled extension in skipped state and defers its enable to a restart', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'skipped-ext' ? false : undefined),
      persistEnabled: async () => undefined,
    });
    coordinator.load([
      makePackage('skipped-ext', {
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    // Extension should be registered but skipped.
    const skippedInfo = coordinator.list().find((e) => e.name === 'skipped-ext');
    expect(skippedInfo?.state).toBe('skipped');
    expect(skippedInfo?.enabled).toBe(false);

    // The preference is persisted, but the process's own runtime state stays
    // `skipped` — only the next restart actually starts the extension.
    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'skipped-ext', enabled: true });
    expect(result).toEqual({ success: false, outcome: 'restart-required' });

    const afterInfo = coordinator.list().find((e) => e.name === 'skipped-ext');
    expect(afterInfo?.state).toBe('skipped');

    await coordinator.shutdown();
  });

  it('defers a runtimeOwnership extension disabled at boot to a restart on enable', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'owner-ext' ? false : undefined),
      persistEnabled: async () => undefined,
    });
    coordinator.load([
      makePackage('owner-ext', {
        runtimeOwnership: { sessionOrchestrator: true },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    // Extension is skipped (disabled at boot, never initialized this process).
    const skippedInfo = coordinator.list().find((e) => e.name === 'owner-ext');
    expect(skippedInfo?.state).toBe('skipped');

    // `setEnabled` is persist-only, so this can never activate the extension
    // live regardless of its runtimeOwnership claim — a second ownership
    // claimant reaching `active` in this process is structurally impossible
    // now, not merely refused case-by-case.
    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'owner-ext', enabled: true });
    expect(result).toEqual({ success: false, outcome: 'restart-required' });

    const afterInfo = coordinator.list().find((e) => e.name === 'owner-ext');
    expect(afterInfo?.state).toBe('skipped');

    await coordinator.shutdown();
  });

  it('keeps the persisted preference when a runtimeOwnership setEnabled reports restart-required', async () => {
    // A `restart-required` outcome is not an invalid request: the extension is
    // meant to run, it just needs a restart. Rolling the preference back here
    // would re-add the name to the disabled set and make the promised restart a no-op.
    // The store below implements the same disabled-set semantics as the
    // enablement file on disk, so the assertion is on real persistence.
    const disabled = new Set<string>(['owner-ext']);
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (disabled.has(name) ? false : undefined),
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        await Promise.resolve();
      },
    });
    coordinator.load([
      makePackage('owner-ext', {
        runtimeOwnership: { sessionOrchestrator: true },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();
    expect(disabled.has('owner-ext')).toBe(true);

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'owner-ext', enabled: true });

    // The live transition is refused...
    expect(result.success).toBe(false);
    // ...but the preference stands: the next boot must start the extension.
    expect(disabled.has('owner-ext')).toBe(false);
    expect(persistCalls).toEqual([{ name: 'owner-ext', enabled: true }]);

    await coordinator.shutdown();
  });

  it('allows the internal restart primitive to re-activate a runtimeOwnership extension started this boot', async () => {
    // The boot-skip guard in `enableExtension` only fires for a `'skipped'`
    // entry that never collected its surfaces. An extension that WAS started
    // this boot (state: active) and then stopped (state: stopped) must be
    // restartable through `applyExtensionTransition` — no second ownership
    // claimant is created, since the same package instance is restarting.
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: vi.fn().mockResolvedValue(undefined),
    });
    coordinator.load([
      makePackage('owner-ext-started', {
        runtimeOwnership: { sessionOrchestrator: true },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    // Extension started normally this boot — it should be active.
    const activeInfo = coordinator.list().find((e) => e.name === 'owner-ext-started');
    expect(activeInfo?.state).toBe('active');

    // Restart the extension via the coordinator-internal primitive.
    const disableResult = await coordinator.applyExtensionTransition('owner-ext-started', false);
    expect(disableResult).toBe('applied');
    const stoppedInfo = coordinator.list().find((e) => e.name === 'owner-ext-started');
    expect(stoppedInfo?.state).toBe('stopped');

    // Re-enable must succeed — the extension was already initialized this boot.
    const enableResult = await coordinator.applyExtensionTransition('owner-ext-started', true);
    expect(enableResult).toBe('applied');

    const reenabledInfo = coordinator.list().find((e) => e.name === 'owner-ext-started');
    expect(reenabledInfo?.state).toBe('active');

    await coordinator.shutdown();
  });

  it('defers a boot-skipped package to a restart even when it claims no runtime ownership', async () => {
    // `setEnabled` is persist-only for every boot-skipped extension, whether
    // or not it declares `runtimeOwnership`, `clients`, `runtimeBoot`, or
    // `storage.migrations` — there is no per-contribution distinction left to
    // test, since none of those surfaces are ever replayed live regardless of
    // which ones a package happens to declare.
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'non-owner-ext' ? false : undefined),
      persistEnabled: async () => undefined,
    });
    coordinator.load([
      makePackage('non-owner-ext', {
        runtimeOwnership: { sessionOrchestrator: false },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    const skippedInfo = coordinator.list().find((e) => e.name === 'non-owner-ext');
    expect(skippedInfo?.state).toBe('skipped');

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'non-owner-ext', enabled: true });
    expect(result).toEqual({ success: false, outcome: 'restart-required' });

    const afterInfo = coordinator.list().find((e) => e.name === 'non-owner-ext');
    expect(afterInfo?.state).toBe('skipped');

    await coordinator.shutdown();
  });

  it('defers a package with client definitions disabled at boot to a restart on enable', async () => {
    // `clients` is seeded into the clients-core service once, at construction
    // time, before the coordinator ever starts — one of several boot-only
    // surfaces `setEnabled` can never replay live. This is no longer a
    // client-definitions-specific refusal; every boot-skipped package defers
    // to a restart the same way.
    const disabled = new Set<string>(['client-ext']);
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (disabled.has(name) ? false : undefined),
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        await Promise.resolve();
      },
    });
    coordinator.load([
      makePackage('client-ext', {
        clients: [
          createClientDefinition({
            id: 'codex',
            name: 'Codex',
            version: '0.1.0',
            authMethods: [],
            defaultApprovalPolicy: 'full-access',
          }),
        ],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    const skippedInfo = coordinator.list().find((e) => e.name === 'client-ext');
    expect(skippedInfo?.state).toBe('skipped');

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'client-ext', enabled: true });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('restart-required');

    const afterInfo = coordinator.list().find((e) => e.name === 'client-ext');
    expect(afterInfo?.state).toBe('skipped');

    // The preference is durable and survives the deferral — it is not rolled
    // back the way a `'rejected'` outcome would be.
    expect(disabled.has('client-ext')).toBe(false);
    expect(persistCalls).toEqual([{ name: 'client-ext', enabled: true }]);

    await coordinator.shutdown();
  });

  it('defers a package with a runtimeBoot contribution disabled at boot to a restart on enable', async () => {
    // `runtimeBoot.configure()` runs exactly once, for boot-enabled packages
    // only, before `startAll()` — another boot-only surface `setEnabled` can
    // never replay live. This is no longer a runtimeBoot-specific refusal;
    // every boot-skipped package defers to a restart the same way.
    const disabled = new Set<string>(['boot-contribution-ext']);
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (disabled.has(name) ? false : undefined),
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        await Promise.resolve();
      },
    });
    coordinator.load([
      makePackage('boot-contribution-ext', {
        runtimeBoot: { configure: () => undefined },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    const skippedInfo = coordinator.list().find((e) => e.name === 'boot-contribution-ext');
    expect(skippedInfo?.state).toBe('skipped');

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'boot-contribution-ext', enabled: true });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('restart-required');

    const afterInfo = coordinator.list().find((e) => e.name === 'boot-contribution-ext');
    expect(afterInfo?.state).toBe('skipped');

    expect(disabled.has('boot-contribution-ext')).toBe(false);
    expect(persistCalls).toEqual([{ name: 'boot-contribution-ext', enabled: true }]);

    await coordinator.shutdown();
  });

  it('defers a package with storage.migrations disabled at boot to a restart on enable', async () => {
    // A disabled package's migrations are skipped at boot (the operator's
    // escape hatch when the migration itself is what is broken) — another
    // boot-only surface `setEnabled` can never replay live. This is no longer
    // a migrations-specific refusal; every boot-skipped package defers to a
    // restart the same way.
    const disabled = new Set<string>(['migration-ext']);
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (disabled.has(name) ? false : undefined),
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        await Promise.resolve();
      },
    });
    coordinator.load([
      makePackage('migration-ext', {
        storage: { migrations: '/migration-ext/drizzle' },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    const skippedInfo = coordinator.list().find((e) => e.name === 'migration-ext');
    expect(skippedInfo?.state).toBe('skipped');

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'migration-ext', enabled: true });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('restart-required');

    const afterInfo = coordinator.list().find((e) => e.name === 'migration-ext');
    expect(afterInfo?.state).toBe('skipped');

    expect(disabled.has('migration-ext')).toBe(false);
    expect(persistCalls).toEqual([{ name: 'migration-ext', enabled: true }]);

    await coordinator.shutdown();
  });

  it('persists the operator preference across a setEnabled(true) deferred to restart and a setEnabled(false) that follows', async () => {
    // Root-cause regression for the seam that infers "what was the prior
    // preference" from `entry.enabled` instead of the durable store. Step 1
    // enables a boot-skipped runtimeOwnership extension: `setEnabled` never
    // runs a live transition ('restart-required') but the preference is
    // persisted as enabled. Step 2 immediately disables the same
    // extension before any restart happens. Because the extension was never
    // started this boot, `entry.enabled` was never flipped to `true` by step
    // 1 — a seam that reads `entry.enabled` as "the prior preference" sees no
    // change between steps and skips persistence entirely, leaving the file
    // enabled against the operator's explicit second request. The persisted
    // value after step 2 must reflect what the operator asked for last: disabled.
    const disabled = new Set<string>(['owner-ext']);
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (disabled.has(name) ? false : undefined),
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        await Promise.resolve();
      },
    });
    coordinator.load([
      makePackage('owner-ext', {
        runtimeOwnership: { sessionOrchestrator: true },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();
    expect(disabled.has('owner-ext')).toBe(true);

    const enableResult = await bus.request(ExtensionSubjects.setEnabled, { name: 'owner-ext', enabled: true });
    expect(enableResult.success).toBe(false);
    expect(enableResult.outcome).toBe('restart-required');
    // The deferred enable persisted, as before.
    expect(disabled.has('owner-ext')).toBe(false);

    const disableResult = await bus.request(ExtensionSubjects.setEnabled, { name: 'owner-ext', enabled: false });
    expect(disableResult.success).toBe(true);
    expect(disableResult.outcome).toBe('applied');

    // The operator's last request — disable — must be the one on disk, not
    // the stale enable from before the (never-applied) restart.
    expect(disabled.has('owner-ext')).toBe(true);
    expect(persistCalls).toEqual([
      { name: 'owner-ext', enabled: true },
      { name: 'owner-ext', enabled: false },
    ]);

    await coordinator.shutdown();
  });

  it('durably disables an already-failed non-critical extension without a restart', async () => {
    // A failed extension carries no running service, and `setEnabled` never
    // runs a live transition anyway — but the operator's "turn this off for
    // next boot" wish is still valid and always persists. The runtime state
    // (`failed`) already matches the requested `enabled: false`, so this
    // reports `'applied'` even though nothing about the entry's runtime state
    // changed.
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
      },
    });
    coordinator.load([
      makePackage('failing-ext', {
        create: () => {
          throw new Error('boom');
        },
      }),
    ]);
    await coordinator.startAll();

    const failedInfo = coordinator.list().find((e) => e.name === 'failing-ext');
    expect(failedInfo?.state).toBe('failed');
    expect(failedInfo?.enabled).toBe(true);

    const disableResult = await bus.request(ExtensionSubjects.setEnabled, { name: 'failing-ext', enabled: false });
    expect(disableResult.success).toBe(true);
    expect(disableResult.outcome).toBe('applied');

    // `setEnabled` never touches runtime state — `entry.state` and
    // `entry.enabled` are exactly as boot left them, even though the
    // preference was durably persisted as disabled.
    const afterInfo = coordinator.list().find((e) => e.name === 'failing-ext');
    expect(afterInfo?.state).toBe('failed');
    expect(afterInfo?.enabled).toBe(true);
    expect(persistCalls).toEqual([{ name: 'failing-ext', enabled: false }]);

    await coordinator.shutdown();
  });

  it('durably disables a non-critical extension that ServiceSkipError skipped at boot', async () => {
    const persistCalls: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async (name, enabled) => {
        persistCalls.push({ name, enabled });
      },
    });
    coordinator.load([
      makePackage('skip-error-ext', {
        create: () => {
          throw new ServiceSkipError('not configured');
        },
      }),
    ]);
    await coordinator.startAll();

    const skippedInfo = coordinator.list().find((e) => e.name === 'skip-error-ext');
    expect(skippedInfo?.state).toBe('skipped');
    expect(skippedInfo?.enabled).toBe(true);

    const disableResult = await bus.request(ExtensionSubjects.setEnabled, { name: 'skip-error-ext', enabled: false });
    expect(disableResult.success).toBe(true);
    expect(disableResult.outcome).toBe('applied');

    // Persist-only: the entry's runtime snapshot is unchanged even though the
    // preference was durably recorded.
    const afterInfo = coordinator.list().find((e) => e.name === 'skip-error-ext');
    expect(afterInfo?.state).toBe('skipped');
    expect(afterInfo?.enabled).toBe(true);
    expect(persistCalls).toEqual([{ name: 'skip-error-ext', enabled: false }]);

    await coordinator.shutdown();
  });

  it('bridges a tray manifest into the live tray menu service on an internal restart', async () => {
    // Mirrors the "collects tray entries during load and registers them
    // during startAll" boot-path test above, but for an extension restarted
    // through the coordinator-internal primitive. `registerEntryTray` runs
    // after every 'active' transition, boot or restart alike, so the tray
    // stays in sync without waiting for a process restart.
    const registeredEntries: TrayMenuEntry[] = [];
    bus.on(TrayMenuSubjects.register, (ctx) => {
      registeredEntries.push(TrayMenuEntrySchema.parse(ctx.payload.entry));
      ctx.setResult({ entryId: ctx.payload.entry.entryId });
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('tray-restart-enable', {
        tray: { label: 'Hot Tool', section: 'tools' },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();
    expect(registeredEntries).toHaveLength(1);

    await coordinator.applyExtensionTransition('tray-restart-enable', false);
    const result = await coordinator.applyExtensionTransition('tray-restart-enable', true);
    expect(result).toBe('applied');

    expect(registeredEntries).toHaveLength(2);
    expect(registeredEntries[1]).toMatchObject({
      packageName: 'tray-restart-enable',
      entryId: 'default',
      label: 'Hot Tool',
      section: 'tools',
    });

    await coordinator.shutdown();
  });

  it('removes a tray manifest from the live tray menu service on an internal restart', async () => {
    // Mirrors the registration test above. Without this, a tray-owning
    // extension stopped through the internal restart primitive leaves a
    // stale, clickable entry in the running tray menu that no longer has a
    // live service behind it.
    const registeredEntries: TrayMenuEntry[] = [];
    const unregisterCalls: Array<{ packageName: string; entryId: string }> = [];
    bus.on(TrayMenuSubjects.register, (ctx) => {
      registeredEntries.push(TrayMenuEntrySchema.parse(ctx.payload.entry));
      ctx.setResult({ entryId: ctx.payload.entry.entryId });
    });
    bus.on(TrayMenuSubjects.unregister, (ctx) => {
      unregisterCalls.push({ packageName: ctx.payload.packageName, entryId: ctx.payload.entryId });
      ctx.setResult({ removed: true });
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('tray-restart-disable', {
        tray: { label: 'Disable Tool', section: 'tools' },
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();
    expect(registeredEntries).toHaveLength(1);

    const result = await coordinator.applyExtensionTransition('tray-restart-disable', false);
    expect(result).toBe('applied');

    expect(unregisterCalls).toHaveLength(1);
    expect(unregisterCalls[0]).toStrictEqual({ packageName: 'tray-restart-disable', entryId: 'default' });

    await coordinator.shutdown();
  });

  it('refuses to collect window surfaces for a boot-skipped extension through setEnabled', async () => {
    // A window-owning extension disabled at boot never had its surfaces
    // collected (see `load()`), and `setEnabled` never runs a live
    // transition — so hot-enabling it can never register the deferred
    // window. Only a process restart, which re-runs `load()`, collects it.
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'windowed-disabled' ? false : undefined),
      persistEnabled: async () => undefined,
    });
    coordinator.load([
      makePackage('windowed-disabled', {
        windows: [{ id: 'settings', style: 'utility' }],
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    // Surfaces are deferred at load time; the window is not in the registry yet.
    expect(coordinator.windowRegistry.get('windowed-disabled:settings')).toBeUndefined();

    const result = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'windowed-disabled',
      enabled: true,
    });
    expect(result).toEqual({ success: false, outcome: 'restart-required' });

    // The window stays unregistered — only a restart can collect it.
    expect(coordinator.windowRegistry.get('windowed-disabled:settings')).toBeUndefined();

    await coordinator.shutdown();
  });

  it('registers windows for a hand-disabled critical extension during load', () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => (name === 'critical-windowed' ? false : undefined),
    });
    coordinator.load([
      makePackage('critical-windowed', {
        critical: true,
        windows: [{ id: 'panel', style: 'utility' }],
      }),
    ]);

    // Critical extension is force-enabled at load; its window must be registered
    // even though loadEnabled returned false.
    const reg = coordinator.windowRegistry.get('critical-windowed:panel');
    expect(reg).toBeDefined();
    expect(reg?.packageName).toBe('critical-windowed');
  });

  // ---------------------------------------------------------------------------
  // Context derivation tests
  // ---------------------------------------------------------------------------

  // 21. dataDir is resolved to data/<encoded> under makaioHome
  it('ctx.dataDir resolves to data/<encoded-name> under makaioHome', async () => {
    let capturedCtx: ExtensionContext | undefined;
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('my-extension', {
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
    ]);
    await coordinator.startAll();

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.dataDir).toBe(path.join(TEST_PKG_CTX_BASE.makaioHome, 'data', 'my-extension'));
  });

  // 21b. dataDir encodes scoped names into a single path segment
  it('ctx.dataDir encodes a scoped name as a single path segment', async () => {
    let capturedCtx: ExtensionContext | undefined;
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('@acme/weather-tools', {
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
    ]);
    await coordinator.startAll();

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.dataDir).toBe(path.join(TEST_PKG_CTX_BASE.makaioHome, 'data', '%40acme%2Fweather-tools'));
  });

  // 21c. buildExtensionContext with an unencodable name → entry fails, not boot
  it('transitions an extension with an unencodable name to failed without aborting boot', async () => {
    // A lone high surrogate is not well-formed Unicode and cannot be encoded as
    // a filesystem path segment; buildExtensionContext must throw rather than
    // fall back to the raw name (which would violate the codec's injectivity).
    const unencodableName = '\uD800';
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage(unencodableName, {
        // The create factory triggers context building; the throw happens before
        // the factory is invoked, but the coordinator isolates it per-extension.
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);

    // startAll must resolve (not throw) — boot continues.
    await expect(coordinator.startAll()).resolves.toBeUndefined();

    const info = coordinator.list().find((e) => e.name === unencodableName);
    expect(info?.state).toBe('failed');
    expect(info?.error).toContain('cannot be encoded as a filesystem path segment');
  });

  // 21d. Unencodable name with NO create / storage / contribution-processors:
  //      the extension must still fail, NOT reach `active`.
  //
  //      Without an eager name check in startExtensionEntry, an extension with
  //      no `create`, no `storage.registerHandlers`, and no contribution
  //      processors would reach `active` without buildExtensionContext ever
  //      running. A subsequent forEachActiveExtension call would then throw
  //      outside per-extension isolation. The eager check in startExtensionEntry
  //      ensures the entry is always isolated regardless of which lifecycle
  //      hooks are declared.
  it('transitions an unencodable-name extension with no create/storage to failed, not active', async () => {
    const unencodableName = '\uD800';
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    // A bare package with no create factory, no storage, and no contributions.
    coordinator.load([makePackage(unencodableName)]);

    await expect(coordinator.startAll()).resolves.toBeUndefined();

    const info = coordinator.list().find((e) => e.name === unencodableName);
    expect(info?.state).toBe('failed');
    expect(info?.error).toContain('cannot be encoded as a filesystem path segment');

    // forEachActiveExtension must not encounter the broken entry.
    const activeNames: string[] = [];
    coordinator.forEachActiveExtension((activeName) => {
      activeNames.push(activeName);
    });
    expect(activeNames).not.toContain(unencodableName);
  });

  // 21e. The same unencodable name on a CRITICAL extension aborts startup.
  //
  //      21c and 21d prove the failure stays isolated. This proves the other
  //      half of the contract: a critical extension that cannot be given an
  //      addressable data directory must not let boot continue around it.
  it('aborts startup when a critical extension has an unencodable name', async () => {
    const unencodableName = '\uD800';
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([makePackage(unencodableName, { critical: true })]);

    await expect(coordinator.startAll()).rejects.toThrow(/cannot be encoded as a filesystem path segment/);

    const info = coordinator.list().find((e) => e.name === unencodableName);
    expect(info?.state).toBe('failed');
  });

  // 21f. Re-enabling a bare unencodable-name extension after a failed startup
  //      must not reach `active` either.
  //
  //      21d proves the eager check in startExtensionEntry keeps a bare
  //      unencodable-name extension out of `active` during boot.
  //      `kernel:extension.setEnabled(true)` is a distinct re-entry into
  //      activation (via `enableExtension`) that also never calls
  //      `buildExtensionContext` for a bare package, so it needs the same
  //      guard. Both eager checks share the `checkExtensionNameAddressable`
  //      predicate so they cannot drift apart.
  it('rejects re-enabling a bare unencodable-name extension after a failed startup', async () => {
    const unencodableName = '\uD800';
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    // A bare package with no create factory, no storage, and no contributions —
    // the same shape as 21d, which never calls buildExtensionContext.
    coordinator.load([makePackage(unencodableName)]);
    await coordinator.startAll();

    const before = coordinator.list().find((e) => e.name === unencodableName);
    expect(before?.state).toBe('failed');

    const reenabled = await coordinator.applyExtensionTransition(unencodableName, true);
    expect(reenabled).toBe('rejected');

    const after = coordinator.list().find((e) => e.name === unencodableName);
    expect(after?.state).toBe('failed');
    expect(after?.error).toContain('cannot be encoded as a filesystem path segment');

    // forEachActiveExtension must not encounter the broken entry.
    const activeNames: string[] = [];
    coordinator.forEachActiveExtension((activeName) => {
      activeNames.push(activeName);
    });
    expect(activeNames).not.toContain(unencodableName);
  });

  // 21g. Two names differing only in case no longer share a segment: the codec
  //      escapes every uppercase byte, so `Gateway` encodes to `%47ateway`
  //      while `gateway` stays `gateway`. Both extensions start and each gets
  //      its own data directory — this is the point of escaping case in the
  //      encoder rather than detecting the collision after the fact over
  //      whichever names happen to be loaded (a detector that cannot see a
  //      same-named directory left behind by an extension that is no longer
  //      loaded, or one filtered onto another surface).
  it('starts both extensions when their names differ only in case, each with its own data directory', async () => {
    const capturedDataDirs = new Map<string, string>();
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('Gateway', {
        create: (ctx) => {
          capturedDataDirs.set(ctx.identity.extensionName, ctx.dataDir);
          return makeMockService(ctx.bus);
        },
      }),
      makePackage('gateway', {
        create: (ctx) => {
          capturedDataDirs.set(ctx.identity.extensionName, ctx.dataDir);
          return makeMockService(ctx.bus);
        },
      }),
    ]);

    await coordinator.startAll();

    for (const info of coordinator.list()) {
      expect(info.state).toBe('active');
    }
    expect(capturedDataDirs.get('Gateway')).toBe(path.join(TEST_PKG_CTX_BASE.makaioHome, 'data', '%47ateway'));
    expect(capturedDataDirs.get('gateway')).toBe(path.join(TEST_PKG_CTX_BASE.makaioHome, 'data', 'gateway'));
    expect(capturedDataDirs.get('Gateway')).not.toBe(capturedDataDirs.get('gateway'));
  });

  // 21h. Restarting an extension whose name differs only in case from another
  //      loaded extension reaches `active` again, for the same reason as 21g:
  //      the two names never shared a segment in the first place. The restart
  //      goes through `applyExtensionTransition`, the coordinator's internal
  //      primitive for packages that were activated during this boot —
  //      a boot-disabled entry stays `restart-required` by design.
  it('restarts an extension whose name differs only in case from another loaded extension', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('Gateway', { create: (ctx) => makeMockService(ctx.bus) }),
      makePackage('gateway', { create: (ctx) => makeMockService(ctx.bus) }),
    ]);
    await coordinator.startAll();

    const stopOutcome = await coordinator.applyExtensionTransition('Gateway', false);
    expect(stopOutcome).toBe('applied');
    const before = coordinator.list().find((e) => e.name === 'Gateway');
    expect(before?.state).toBe('stopped');

    const reenabled = await coordinator.applyExtensionTransition('Gateway', true);
    expect(reenabled).toBe('applied');

    const after = coordinator.list().find((e) => e.name === 'Gateway');
    expect(after?.state).toBe('active');
  });

  // 21i. Two ordinary, differently-spelled names encode to distinct segments
  //      and start normally, as they always have.
  it('does not fail extensions whose data-directory segments do not collide', async () => {
    const capturedNames: string[] = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('gateway', {
        create: (ctx) => {
          capturedNames.push(ctx.identity.extensionName);
          return makeMockService(ctx.bus);
        },
      }),
      makePackage('account-manager', {
        create: (ctx) => {
          capturedNames.push(ctx.identity.extensionName);
          return makeMockService(ctx.bus);
        },
      }),
    ]);

    await coordinator.startAll();

    expect(capturedNames.sort()).toEqual(['account-manager', 'gateway']);
    for (const info of coordinator.list()) {
      expect(info.state).toBe('active');
    }
  });

  // 21j. `gateway` and `gateway.` would resolve to the same Windows path
  //      component if the codec left a trailing dot unescaped (a Win32 path
  //      resolver strips it); the codec escapes it, so both extensions get
  //      distinct, addressable data directories and neither fails.
  it('does not fail extensions whose names differ only by a trailing dot', async () => {
    const capturedDataDirs = new Map<string, string>();
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('gateway', {
        create: (ctx) => {
          capturedDataDirs.set(ctx.identity.extensionName, ctx.dataDir);
          return makeMockService(ctx.bus);
        },
      }),
      makePackage('gateway.', {
        create: (ctx) => {
          capturedDataDirs.set(ctx.identity.extensionName, ctx.dataDir);
          return makeMockService(ctx.bus);
        },
      }),
    ]);

    await coordinator.startAll();

    for (const info of coordinator.list()) {
      expect(info.state).toBe('active');
    }
    expect(capturedDataDirs.get('gateway')).toBe(path.join(TEST_PKG_CTX_BASE.makaioHome, 'data', 'gateway'));
    expect(capturedDataDirs.get('gateway.')).toBe(path.join(TEST_PKG_CTX_BASE.makaioHome, 'data', 'gateway%2E'));
    expect(capturedDataDirs.get('gateway')).not.toBe(capturedDataDirs.get('gateway.'));
  });

  // ---------------------------------------------------------------------------
  // Config injection tests
  // ---------------------------------------------------------------------------

  // 22. buildExtensionContext without config — ctx.config is absent
  it('ctx.config is absent when no configSchema is declared', async () => {
    let capturedCtx: ExtensionContext | undefined;
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('no-schema-pkg', {
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
    ]);
    await coordinator.startAll();

    expect(capturedCtx).toBeDefined();
    expect('config' in capturedCtx!).toBe(false);
  });

  // 22. buildExtensionContext with resolved config — ctx.config is the resolved value
  it('ctx.config carries resolved config when configSchema is declared', async () => {
    const ConfigSchema = z.object({ retries: z.number().default(3) });
    let capturedCtx: ExtensionContext | undefined;

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadConfig: () => ({ retries: 7 }),
    });

    coordinator.load([
      makePackage('schema-pkg', {
        configSchema: ConfigSchema,
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
    ]);
    await coordinator.startAll();

    expect(capturedCtx?.config).toEqual({ retries: 7 });
  });

  // 23. resolveConfig with valid stored config — returns parsed config
  it('resolveConfig merges defaults under stored config and parses', async () => {
    const ConfigSchema = z.object({
      timeout: z.number().default(1000),
      debug: z.boolean().default(false),
    });
    let capturedCtx: ExtensionContext | undefined;

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadConfig: () => ({ debug: true }),
    });

    coordinator.load(
      [
        makePackage('merge-pkg', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            capturedCtx = ctx;
            return makeMockService(ctx.bus);
          },
        }),
      ],
      new Map([['merge-pkg', { timeout: 500 }]]),
    );
    await coordinator.startAll();

    // descriptor defaults provide timeout=500, stored config overrides debug=true
    expect(capturedCtx?.config).toEqual({ timeout: 500, debug: true });
  });

  // 24. resolveConfig with invalid stored config — falls back to schema defaults
  it('resolveConfig falls back to schema defaults when stored config is invalid', async () => {
    const ConfigSchema = z.object({ retries: z.number().default(3) });
    let capturedCtx: ExtensionContext | undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadConfig: () => ({ retries: 'not-a-number' }), // invalid
    });

    coordinator.load([
      makePackage('invalid-config-pkg', {
        configSchema: ConfigSchema,
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
    ]);
    await coordinator.startAll();

    warnSpy.mockRestore();

    // Falls back to schema defaults: retries=3
    expect(capturedCtx?.config).toEqual({ retries: 3 });
  });

  // 25. resolveConfig without configSchema — returns undefined (config absent)
  it('resolveConfig returns undefined when no configSchema is declared', async () => {
    let capturedCtx: ExtensionContext | undefined;
    const loadConfig = vi.fn().mockReturnValue({ someKey: 'value' });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadConfig,
    });

    coordinator.load([
      makePackage('no-schema-loadconfig-pkg', {
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
    ]);
    await coordinator.startAll();

    // loadConfig is never consulted when no configSchema
    expect(capturedCtx?.config).toBeUndefined();
    expect('config' in capturedCtx!).toBe(false);
  });

  // 26. load() with configDefaults map — entries carry defaults
  it('load() with configDefaults stores defaults on entries', async () => {
    const ConfigSchema = z.object({ level: z.number().default(1) });
    let capturedCtx: ExtensionContext | undefined;

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load(
      [
        makePackage('defaults-pkg', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            capturedCtx = ctx;
            return makeMockService(ctx.bus);
          },
        }),
      ],
      new Map([['defaults-pkg', { level: 42 }]]),
    );
    await coordinator.startAll();

    // No loadConfig supplied, so only defaults flow through
    expect(capturedCtx?.config).toEqual({ level: 42 });
  });

  // 28. configDefaults and loadConfig conflict — stored config wins
  it('stored config from loadConfig wins over configDefaults for conflicting keys', async () => {
    const ConfigSchema = z.object({
      host: z.string().default('localhost'),
      port: z.number().default(8080),
    });
    let capturedCtx: ExtensionContext | undefined;

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      // loadConfig supplies stored config that conflicts with the descriptor default
      loadConfig: () => ({ host: 'stored-host', port: 9999 }),
    });

    coordinator.load(
      [
        makePackage('conflict-pkg', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            capturedCtx = ctx;
            return makeMockService(ctx.bus);
          },
        }),
      ],
      // configDefaults supplies different values for both keys
      new Map([['conflict-pkg', { host: 'default-host', port: 1234 }]]),
    );
    await coordinator.startAll();

    // Merge order is { ...defaults, ...stored } — stored values must win
    expect(capturedCtx?.config).toEqual({ host: 'stored-host', port: 9999 });
  });

  // 29. loadConfig returns undefined — descriptor defaults still flow through
  it('descriptor configDefaults flow through when loadConfig returns undefined', async () => {
    const ConfigSchema = z.object({
      timeout: z.number().default(5000),
      verbose: z.boolean().default(false),
    });
    let capturedCtx: ExtensionContext | undefined;

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      // loadConfig returns undefined — no stored config for this extension
      loadConfig: () => undefined,
    });

    coordinator.load(
      [
        makePackage('no-stored-config-pkg', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            capturedCtx = ctx;
            return makeMockService(ctx.bus);
          },
        }),
      ],
      new Map([['no-stored-config-pkg', { timeout: 2000, verbose: true }]]),
    );
    await coordinator.startAll();

    // With no stored config, configDefaults are the sole input to schema.parse
    expect(capturedCtx?.config).toEqual({ timeout: 2000, verbose: true });
  });

  // 30. Schema with required fields — both parse attempts fail — ctx.config is undefined
  it('ctx.config is undefined when schema.parse fails for both merged and empty inputs', async () => {
    // A schema with a required field that has no default — schema.parse({}) also throws
    const ConfigSchema = z.object({ apiKey: z.string() });
    let capturedCtx: ExtensionContext | undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      // loadConfig returns a value that fails schema validation (number where string expected)
      loadConfig: (): Record<string, unknown> => ({ apiKey: 123 }),
    });

    coordinator.load([
      makePackage('required-field-pkg', {
        configSchema: ConfigSchema,
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
    ]);
    await coordinator.startAll();

    warnSpy.mockRestore();

    // schema.parse({ apiKey: 123 }) fails, schema.parse({}) also fails (required field) →
    // resolveConfig returns undefined → config is absent from context
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.config).toBeUndefined();
    expect('config' in capturedCtx!).toBe(false);
  });

  // 27. getExtension() returns the extension or undefined
  it('getExtension() returns the loaded extension or undefined', async () => {
    const pkg = makePackage('query-pkg');
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([pkg]);

    expect(coordinator.getExtension('query-pkg')).toBe(pkg);
    expect(coordinator.getExtension('nonexistent')).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // extension.get RPC
  // ---------------------------------------------------------------------------

  // 31. extension.get — happy path returns wrapped ExtensionInfo for known extension
  it('extension.get returns wrapped ExtensionInfo for a known extension', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('get-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.get, { name: 'get-ext' });

    expect(result.extension).toMatchObject({
      name: 'get-ext',
      displayName: 'get-ext',
      state: 'active',
      enabled: true,
    });

    await coordinator.shutdown();
  });

  // 32. extension.get — returns null extension for unknown extension name
  it('extension.get returns null extension for an unknown extension name', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('known-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.get, { name: 'no-such-ext' });

    expect(result.extension).toBeNull();

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // extension.enabledChanged event
  // ---------------------------------------------------------------------------

  // 33. enabledChanged fires when the internal restart primitive disables an active extension
  it('enabledChanged event fires with correct payload when disabling', async () => {
    const events: Array<{ name: string; enabled: boolean }> = [];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('event-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    bus.on(ExtensionSubjects.enabledChanged, (ctx) => {
      events.push({ name: ctx.payload.name, enabled: ctx.payload.enabled });
    });

    // `setEnabled` is persist-only and never emits `enabledChanged` — only a
    // primitive that actually transitions the entry does.
    await coordinator.applyExtensionTransition('event-ext', false);

    expect(events).toContainEqual({ name: 'event-ext', enabled: false });

    await coordinator.shutdown();
  });

  // 34. enabledChanged fires when the internal restart primitive re-enables a stopped extension
  it('enabledChanged event fires with correct payload when re-enabling', async () => {
    const events: Array<{ name: string; enabled: boolean }> = [];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('toggle-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    // Disable first so re-enable has a valid transition (stopped -> active).
    await coordinator.applyExtensionTransition('toggle-ext', false);

    bus.on(ExtensionSubjects.enabledChanged, (ctx) => {
      events.push({ name: ctx.payload.name, enabled: ctx.payload.enabled });
    });

    await coordinator.applyExtensionTransition('toggle-ext', true);

    expect(events).toContainEqual({ name: 'toggle-ext', enabled: true });

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // list() reflects stopped state after disable
  // ---------------------------------------------------------------------------

  // 35. list() shows stopped state after an internal restart's disable
  it('list() shows state: stopped for a disabled extension', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('stoppable-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    await coordinator.applyExtensionTransition('stoppable-ext', false);

    const listResult = await bus.request(ExtensionSubjects.list, {});
    const info = listResult.extensions.find((e) => e.name === 'stoppable-ext');

    expect(info).toMatchObject({
      name: 'stoppable-ext',
      state: 'stopped',
      enabled: false,
    });

    await coordinator.shutdown();
  });

  // 36. Pre-fetch map pattern: loadEnabled + loadConfig work together
  it('pre-fetched map serves both loadEnabled and loadConfig', async () => {
    const ConfigSchema = z.object({ debug: z.boolean().default(false) });
    let capturedCtx: ExtensionContext | undefined;

    // Simulate the extensionConfigMap built by boot.ts
    const extensionConfigMap = new Map<string, { config?: Record<string, unknown>; enabled?: boolean }>([
      ['enabled-ext', { config: { debug: true }, enabled: true }],
      ['disabled-ext', { config: { debug: false }, enabled: false }],
    ]);

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => extensionConfigMap.get(name)?.enabled,
      loadConfig: (name) => extensionConfigMap.get(name)?.config,
    });

    coordinator.load([
      makePackage('enabled-ext', {
        configSchema: ConfigSchema,
        create: (ctx) => {
          capturedCtx = ctx;
          return makeMockService(ctx.bus);
        },
      }),
      makePackage('disabled-ext', {
        configSchema: ConfigSchema,
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    // enabled-ext should be active with config from map
    const list = coordinator.list();
    expect(list.find((e) => e.name === 'enabled-ext')).toMatchObject({
      state: 'active',
      enabled: true,
    });
    expect(capturedCtx?.config).toEqual({ debug: true });

    // disabled-ext should be skipped at boot
    expect(list.find((e) => e.name === 'disabled-ext')).toMatchObject({
      state: 'skipped',
      enabled: false,
    });

    await coordinator.shutdown();
  });

  // 37. Pre-fetch map: undefined enabled means start normally
  it('treats undefined enabled in pre-fetch map as start normally', async () => {
    const extensionConfigMap = new Map<string, { config?: Record<string, unknown>; enabled?: boolean }>([
      ['partial-ext', { config: { key: 'val' } }], // enabled is undefined
    ]);

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: (name) => extensionConfigMap.get(name)?.enabled,
      loadConfig: (name) => extensionConfigMap.get(name)?.config,
    });

    coordinator.load([
      makePackage('partial-ext', {
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    expect(coordinator.list()[0]).toMatchObject({
      state: 'active',
      enabled: true,
    });

    await coordinator.shutdown();
  });

  // 38. loadConfig callback is invoked per-package with configSchema
  it('calls loadConfig with the package name during startAll', async () => {
    const ConfigSchema = z.object({ retries: z.number().default(3) });
    const loadConfig = vi.fn().mockReturnValue({ retries: 5 });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadConfig,
    });

    coordinator.load([
      makePackage('with-schema', {
        configSchema: ConfigSchema,
        create: (ctx) => makeMockService(ctx.bus),
      }),
      makePackage('without-schema', {
        create: (ctx) => makeMockService(ctx.bus),
      }),
    ]);
    await coordinator.startAll();

    expect(loadConfig).toHaveBeenCalledWith('with-schema');
    expect(loadConfig).not.toHaveBeenCalledWith('without-schema');

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Operator config layer
  // ---------------------------------------------------------------------------

  describe('operator config layer', () => {
    const OPERATOR_SOURCE = '/operator/config/gateway.json';

    /**
     * Build an {@link ExtensionOperatorConfigSource} over a fixed entry map that
     * records every lookup, so tests can assert the source is consulted again
     * on a later resolution instead of a cached result being reused.
     * @param entries - Operator entries keyed by extension name.
     * @returns A source backed by `entries`, exposing the names it was asked for.
     */
    function makeOperatorConfig(
      entries: Readonly<Record<string, ExtensionOperatorConfigEntry>>,
    ): ExtensionOperatorConfigSource & { readonly lookups: readonly string[] } {
      const lookups: string[] = [];
      return {
        lookups,
        get: (extensionName: string): ExtensionOperatorConfigEntry | undefined => {
          lookups.push(extensionName);
          return entries[extensionName];
        },
      };
    }

    // AC4: a key present in every layer resolves to the operator's value.
    it('operator entry wins per top-level key over stored config and defaults', async () => {
      const ConfigSchema = z.object({ host: z.string(), port: z.number() });
      let capturedCtx: ExtensionContext | undefined;

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadConfig: () => ({ host: 'stored-host', port: 9999 }),
        operatorConfig: makeOperatorConfig({
          'layered-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { host: 'operator-host', port: 6299 } },
        }),
      });

      coordinator.load(
        [
          makePackage('layered-ext', {
            configSchema: ConfigSchema,
            create: (ctx) => {
              capturedCtx = ctx;
              return makeMockService(ctx.bus);
            },
          }),
        ],
        new Map([['layered-ext', { host: 'default-host', port: 1234 }]]),
      );
      await coordinator.startAll();

      expect(capturedCtx?.config).toEqual({ host: 'operator-host', port: 6299 });

      await coordinator.shutdown();
    });

    // AC5: keys the operator does not declare keep their lower-layer value.
    it('leaves keys the operator entry does not declare to the lower layers', async () => {
      const ConfigSchema = z.object({ host: z.string(), port: z.number(), timeout: z.number() });
      let capturedCtx: ExtensionContext | undefined;

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadConfig: () => ({ host: 'stored-host' }),
        operatorConfig: makeOperatorConfig({
          'partial-operator-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { port: 6299 } },
        }),
      });

      coordinator.load(
        [
          makePackage('partial-operator-ext', {
            configSchema: ConfigSchema,
            create: (ctx) => {
              capturedCtx = ctx;
              return makeMockService(ctx.bus);
            },
          }),
        ],
        new Map([['partial-operator-ext', { host: 'default-host', port: 1234, timeout: 30 }]]),
      );
      await coordinator.startAll();

      expect(capturedCtx?.config).toEqual({ host: 'stored-host', port: 6299, timeout: 30 });

      await coordinator.shutdown();
    });

    // AC6: merging is shallow, so a nested object is replaced rather than merged.
    it('replaces a nested object wholesale instead of merging into it', async () => {
      const ConfigSchema = z.object({ upstreams: z.record(z.string(), z.string()) });
      let capturedCtx: ExtensionContext | undefined;

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        operatorConfig: makeOperatorConfig({
          'nested-ext': {
            kind: 'config',
            source: OPERATOR_SOURCE,
            config: { upstreams: { primary: 'https://operator.example' } },
          },
        }),
      });

      coordinator.load(
        [
          makePackage('nested-ext', {
            configSchema: ConfigSchema,
            create: (ctx) => {
              capturedCtx = ctx;
              return makeMockService(ctx.bus);
            },
          }),
        ],
        new Map([['nested-ext', { upstreams: { primary: 'https://a.example', backup: 'https://b.example' } }]]),
      );
      await coordinator.startAll();

      expect(capturedCtx?.config).toEqual({ upstreams: { primary: 'https://operator.example' } });

      await coordinator.shutdown();
    });

    // AC7: an unusable entry fails only its own extension; startup continues.
    it('fails only the affected extension when its operator entry is unusable', async () => {
      const ConfigSchema = z.object({ retries: z.number().default(3) });
      let healthyCtx: ExtensionContext | undefined;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        operatorConfig: makeOperatorConfig({
          'broken-operator-ext': { kind: 'failure', source: OPERATOR_SOURCE, reason: 'invalid-json' },
        }),
      });

      coordinator.load([
        makePackage('broken-operator-ext', {
          configSchema: ConfigSchema,
          create: (ctx) => makeMockService(ctx.bus),
        }),
        makePackage('healthy-ext', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            healthyCtx = ctx;
            return makeMockService(ctx.bus);
          },
        }),
      ]);
      await expect(coordinator.startAll()).resolves.toBeUndefined();
      errorSpy.mockRestore();

      const list = coordinator.list();
      const broken = list.find((e) => e.name === 'broken-operator-ext');
      expect(broken?.state).toBe('failed');
      expect(broken?.error).toContain(OPERATOR_SOURCE);
      expect(broken?.error).toContain('is not valid JSON');

      expect(list.find((e) => e.name === 'healthy-ext')?.state).toBe('active');
      expect(healthyCtx?.config).toEqual({ retries: 3 });

      const state = await bus.request(BootSubjects.getState, {});
      expect(state.failedServices).toContain('broken-operator-ext');

      await coordinator.shutdown();
    });

    // AC8: the same unusable entry on a critical extension aborts startup.
    it('aborts startup with the source in the error when a critical extension has an unusable entry', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        operatorConfig: makeOperatorConfig({
          'critical-operator-ext': {
            kind: 'failure',
            source: OPERATOR_SOURCE,
            reason: 'not-an-object',
            detail: 'top-level value is an array',
          },
        }),
      });

      coordinator.load([
        makePackage('critical-operator-ext', {
          critical: true,
          configSchema: z.object({ retries: z.number().default(3) }),
          create: (ctx) => makeMockService(ctx.bus),
        }),
      ]);

      await expect(coordinator.startAll()).rejects.toThrow(
        `Operator config for extension "critical-operator-ext" (source: ${OPERATOR_SOURCE}) ` +
          'is not a JSON object: top-level value is an array',
      );
      errorSpy.mockRestore();

      expect(coordinator.list().find((e) => e.name === 'critical-operator-ext')?.state).toBe('failed');
    });

    // AC9: an operator-caused schema failure fails the extension outright.
    it('fails the extension instead of falling back to schema defaults on an operator-caused schema failure', async () => {
      const ConfigSchema = z.object({ retries: z.number().default(3) });
      let capturedCtx: ExtensionContext | undefined;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        operatorConfig: makeOperatorConfig({
          'schema-violating-ext': {
            kind: 'config',
            source: OPERATOR_SOURCE,
            config: { retries: 'not-a-number' },
          },
        }),
      });

      coordinator.load(
        [
          makePackage('schema-violating-ext', {
            configSchema: ConfigSchema,
            create: (ctx) => {
              capturedCtx = ctx;
              return makeMockService(ctx.bus);
            },
          }),
        ],
        new Map([['schema-violating-ext', { retries: 5 }]]),
      );
      await coordinator.startAll();
      errorSpy.mockRestore();

      const info = coordinator.list().find((e) => e.name === 'schema-violating-ext');
      expect(info?.state).toBe('failed');
      expect(info?.error).toContain(OPERATOR_SOURCE);
      expect(info?.error).toContain("is part of a configuration rejected by the extension's config schema");
      // No degradation to schema defaults: the extension never started.
      expect(capturedCtx).toBeUndefined();

      await coordinator.shutdown();
    });

    // AC9, sole-source case: the operator file is the only layer that supplies
    // the field, so the layers beneath it cannot parse either. The malformed
    // file must still fail the extension rather than be discarded.
    it('fails the extension when its operator entry is the only source of a rejected required field', async () => {
      const ConfigSchema = z.object({ apiKey: z.string() });
      let capturedCtx: ExtensionContext | undefined;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        operatorConfig: makeOperatorConfig({
          'sole-source-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { apiKey: 123 } },
        }),
      });

      coordinator.load([
        makePackage('sole-source-ext', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            capturedCtx = ctx;
            return makeMockService(ctx.bus);
          },
        }),
      ]);
      await coordinator.startAll();
      errorSpy.mockRestore();

      const info = coordinator.list().find((e) => e.name === 'sole-source-ext');
      expect(info?.state).toBe('failed');
      expect(info?.error).toContain(OPERATOR_SOURCE);
      expect(info?.error).toContain("is part of a configuration rejected by the extension's config schema");
      expect(capturedCtx).toBeUndefined();

      await coordinator.shutdown();
    });

    // Regression guard: an extension the operator said nothing about keeps the
    // pre-existing warn-and-default behaviour for invalid stored config.
    it('keeps the warn-and-default path for an extension with no operator entry', async () => {
      const ConfigSchema = z.object({ retries: z.number().default(3) });
      let capturedCtx: ExtensionContext | undefined;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadConfig: () => ({ retries: 'not-a-number' }),
        operatorConfig: makeOperatorConfig({
          'other-ext': { kind: 'failure', source: OPERATOR_SOURCE, reason: 'unreadable' },
        }),
      });

      coordinator.load([
        makePackage('unmentioned-ext', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            capturedCtx = ctx;
            return makeMockService(ctx.bus);
          },
        }),
      ]);
      await coordinator.startAll();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Config parse failed for "unmentioned-ext"'),
        expect.any(String),
      );
      warnSpy.mockRestore();

      expect(coordinator.list().find((e) => e.name === 'unmentioned-ext')?.state).toBe('active');
      expect(capturedCtx?.config).toEqual({ retries: 3 });

      await coordinator.shutdown();
    });

    // A stored record that changes after startup must not make the read-only
    // context builders throw, in either of the two ways it can now conflict.
    it('does not throw from read-only context builders when stored config later turns invalid', async () => {
      const ConfigSchema = z.object({ retries: z.number().default(3), label: z.string().default('fallback') });
      let storedConfig: Record<string, unknown> = { retries: 5 };

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadConfig: () => storedConfig,
        operatorConfig: makeOperatorConfig({
          'drifting-store-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { label: 'operator' } },
        }),
      });

      coordinator.load([
        makePackage('drifting-store-ext', {
          configSchema: ConfigSchema,
          create: (ctx) => makeMockService(ctx.bus),
        }),
      ]);
      await coordinator.startAll();
      expect(coordinator.list().find((e) => e.name === 'drifting-store-ext')?.state).toBe('active');

      // The storage tier now answers with a value the schema rejects outright.
      storedConfig = { retries: 'not-a-number' };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const seen: unknown[] = [];
      expect(() =>
        coordinator.forExtension('drifting-store-ext', (_n, _p, ctx) => seen.push(ctx.config)),
      ).not.toThrow();
      expect(() => coordinator.forEachActiveExtension((_n, _p, ctx) => seen.push(ctx.config))).not.toThrow();
      warnSpy.mockRestore();

      // Warn-and-default, not an operator-attributed failure.
      expect(seen).toEqual([
        { retries: 3, label: 'fallback' },
        { retries: 3, label: 'fallback' },
      ]);
      expect(coordinator.list().find((e) => e.name === 'drifting-store-ext')?.state).toBe('active');

      await coordinator.shutdown();
    });

    // The harder case: stored config parses on its own, so attribution would
    // blame the operator, yet the read must still not throw and must not
    // abandon the extensions after it in the iteration.
    it('does not throw from read-only context builders when stored config later conflicts with the operator layer', async () => {
      // A cross-field rule: `primary` and `fallback` must not both be set.
      const ConfigSchema = z
        .object({ primary: z.string().optional(), fallback: z.string().optional() })
        .refine((value) => value.primary === undefined || value.fallback === undefined, {
          message: 'primary and fallback are mutually exclusive',
        });
      let storedConfig: Record<string, unknown> = {};

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadConfig: (name) => (name === 'conflicting-store-ext' ? storedConfig : undefined),
        operatorConfig: makeOperatorConfig({
          'conflicting-store-ext': {
            kind: 'config',
            source: OPERATOR_SOURCE,
            config: { primary: 'https://operator.example' },
          },
        }),
      });

      coordinator.load([
        makePackage('conflicting-store-ext', {
          configSchema: ConfigSchema,
          create: (ctx) => makeMockService(ctx.bus),
        }),
        makePackage('later-in-load-order-ext', {
          create: (ctx) => makeMockService(ctx.bus),
        }),
      ]);
      await coordinator.startAll();
      expect(coordinator.list().find((e) => e.name === 'conflicting-store-ext')?.state).toBe('active');

      // Stored config alone still parses; only the merge with the operator
      // layer violates the cross-field rule.
      storedConfig = { fallback: 'https://stored.example' };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const visited: string[] = [];
      let observedConfig: unknown;
      expect(() =>
        coordinator.forExtension('conflicting-store-ext', (_n, _p, ctx) => {
          observedConfig = ctx.config;
        }),
      ).not.toThrow();
      expect(() => coordinator.forEachActiveExtension((name) => visited.push(name))).not.toThrow();
      warnSpy.mockRestore();

      // Warn-and-default, and the iteration reached every active extension.
      expect(observedConfig).toEqual({});
      expect(visited).toEqual(['conflicting-store-ext', 'later-in-load-order-ext']);
      expect(coordinator.list().find((e) => e.name === 'conflicting-store-ext')?.state).toBe('active');

      await coordinator.shutdown();
    });

    // Re-enable resolves against the same source, so an extension that failed
    // at boot on an unusable entry cannot be toggled back into life.
    it('keeps an extension failed when re-enabling it re-reads the same unusable entry', async () => {
      let created = 0;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        operatorConfig: makeOperatorConfig({
          'stuck-operator-ext': {
            kind: 'failure',
            source: OPERATOR_SOURCE,
            reason: 'unreadable',
            detail: 'permission denied',
          },
        }),
        persistEnabled: async () => undefined,
      });

      coordinator.load([
        makePackage('stuck-operator-ext', {
          configSchema: z.object({ retries: z.number().default(3) }),
          create: (ctx) => {
            created += 1;
            return makeMockService(ctx.bus);
          },
        }),
      ]);
      await coordinator.startAll();
      expect(coordinator.list().find((e) => e.name === 'stuck-operator-ext')?.state).toBe('failed');

      const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'stuck-operator-ext', enabled: true });
      errorSpy.mockRestore();

      expect(result.success).toBe(false);
      const info = coordinator.list().find((e) => e.name === 'stuck-operator-ext');
      expect(info?.state).toBe('failed');
      expect(info?.error).toContain(OPERATOR_SOURCE);
      expect(info?.error).toContain('could not be read: permission denied');
      expect(created).toBe(0);

      await coordinator.shutdown();
    });

    // AC14: re-enabling consults the same source again and resolves identically.
    it('resolves a re-enabled extension against the same operator source', async () => {
      const ConfigSchema = z.object({ mode: z.string() });
      const configs: unknown[] = [];
      const operatorConfig = makeOperatorConfig({
        'toggle-operator-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { mode: 'operator' } },
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadConfig: () => ({ mode: 'stored' }),
        operatorConfig,
      });

      coordinator.load([
        makePackage('toggle-operator-ext', {
          configSchema: ConfigSchema,
          create: (ctx) => {
            configs.push(ctx.config);
            return makeMockService(ctx.bus);
          },
        }),
      ]);
      await coordinator.startAll();

      const lookupsAfterStart = operatorConfig.lookups.filter((n) => n === 'toggle-operator-ext').length;
      expect(lookupsAfterStart).toBeGreaterThan(0);

      // `setEnabled` is persist-only and never re-resolves config — the
      // coordinator-internal restart primitive is what actually re-runs
      // `create` against a freshly resolved config.
      await coordinator.applyExtensionTransition('toggle-operator-ext', false);
      await coordinator.applyExtensionTransition('toggle-operator-ext', true);

      expect(coordinator.list().find((e) => e.name === 'toggle-operator-ext')?.state).toBe('active');
      expect(configs).toEqual([{ mode: 'operator' }, { mode: 'operator' }]);
      expect(operatorConfig.lookups.filter((n) => n === 'toggle-operator-ext').length).toBeGreaterThan(
        lookupsAfterStart,
      );

      await coordinator.shutdown();
    });

    // getResolvedConfig is what a settings surface reads to report which values
    // an extension is actually running with. It must report the schema-parsed
    // values, not the operator's raw input.
    describe('getResolvedConfig', () => {
      const TrimmingSchema = z.object({ locale: z.string().trim() });

      /**
       * Build a coordinator whose operator source supplies an untrimmed locale
       * for a single extension declaring {@link TrimmingSchema}.
       * @param enabled - Whether the extension is enabled, so the same fixture
       *   covers both the active and the toggled-off case.
       * @returns A loaded, not-yet-started coordinator.
       */
      function makeTrimmingCoordinator(enabled: boolean): ExtensionCoordinator {
        const coordinator = new ExtensionCoordinator(bus, {
          extensionContextBase: TEST_PKG_CTX_BASE,
          loadEnabled: () => enabled,
          operatorConfig: makeOperatorConfig({
            'trimming-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { locale: ' en-US ' } },
          }),
        });
        coordinator.load([
          makePackage('trimming-ext', {
            configSchema: TrimmingSchema,
            create: (ctx) => makeMockService(ctx.bus),
          }),
        ]);
        return coordinator;
      }

      it('returns the schema-parsed values an active extension actually received', async () => {
        const coordinator = makeTrimmingCoordinator(true);
        await coordinator.startAll();

        expect(coordinator.list().find((e) => e.name === 'trimming-ext')?.state).toBe('active');
        expect(coordinator.getResolvedConfig('trimming-ext')).toEqual({
          config: { locale: 'en-US' },
          usedSchemaDefaults: false,
        });

        await coordinator.shutdown();
      });

      // A settings page is exactly where an extension gets toggled off, so a
      // disabled extension must not start reporting the raw operator value.
      it('returns the same schema-parsed values for a disabled extension', async () => {
        const coordinator = makeTrimmingCoordinator(false);
        await coordinator.startAll();

        expect(coordinator.list().find((e) => e.name === 'trimming-ext')).toMatchObject({
          state: 'skipped',
          enabled: false,
        });
        expect(coordinator.getResolvedConfig('trimming-ext')).toEqual({
          config: { locale: 'en-US' },
          usedSchemaDefaults: false,
        });

        await coordinator.shutdown();
      });

      // A merged configuration the schema rejects falls back to the schema's own
      // defaults, with the operator layer discarded. A settings surface must be
      // able to tell that apart from a real resolution, or it would present
      // schema defaults as the values the operator manages.
      it('reports the schema-default fallback when the merged configuration is rejected', async () => {
        const coordinator = new ExtensionCoordinator(bus, {
          extensionContextBase: TEST_PKG_CTX_BASE,
          operatorConfig: makeOperatorConfig({
            'rejecting-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { locale: 42 } },
          }),
        });
        coordinator.load([
          makePackage('rejecting-ext', {
            configSchema: z.object({ locale: z.string().default('en') }),
            create: (ctx) => makeMockService(ctx.bus),
          }),
        ]);

        // The empty parse succeeds, so a config object exists — but it holds
        // schema defaults only, which the flag is what makes visible.
        expect(coordinator.getResolvedConfig('rejecting-ext')).toEqual({
          config: { locale: 'en' },
          usedSchemaDefaults: true,
        });
      });

      it('returns undefined for an extension that was never loaded', () => {
        const coordinator = makeTrimmingCoordinator(true);

        expect(coordinator.getResolvedConfig('never-loaded-ext')).toBeUndefined();
      });

      it('reports an absent config for a loaded extension that declares no config schema', async () => {
        const coordinator = new ExtensionCoordinator(bus, {
          extensionContextBase: TEST_PKG_CTX_BASE,
          operatorConfig: makeOperatorConfig({
            'schema-less-ext': { kind: 'config', source: OPERATOR_SOURCE, config: { locale: ' en-US ' } },
          }),
        });
        coordinator.load([makePackage('schema-less-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
        await coordinator.startAll();

        expect(coordinator.getResolvedConfig('schema-less-ext')).toEqual({
          config: undefined,
          usedSchemaDefaults: false,
        });

        await coordinator.shutdown();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Capability gating (requires)
  // ---------------------------------------------------------------------------

  describe('capability gating (requires)', () => {
    it('excludes a package whose requires are not met', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['bar']) },
      });

      coordinator.load([
        makePackage('needs-foo', {
          requires: [{ type: 'capability', id: 'foo' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).not.toHaveBeenCalled();
      expect(coordinator.list()).toHaveLength(0);
    });

    it('includes a package whose requires are satisfied', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['foo']) },
      });

      coordinator.load([
        makePackage('needs-foo', {
          requires: [{ type: 'capability', id: 'foo' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).toHaveBeenCalledOnce();
      expect(coordinator.list()).toHaveLength(1);
      expect(coordinator.list()[0]).toMatchObject({ name: 'needs-foo', state: 'active' });
    });

    it('requires all tokens to match (AND semantics)', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['foo']) },
      });

      coordinator.load([
        makePackage('needs-foo-and-bar', {
          requires: [
            { type: 'capability', id: 'foo' },
            { type: 'capability', id: 'bar' },
          ],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).not.toHaveBeenCalled();
      expect(coordinator.list()).toHaveLength(0);
    });

    it('includes a package whose versioned capability requirement is satisfied', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: {
          hosts: new Set(),
          capabilities: new Set(['storage.drizzle']),
          capabilityVersions: new Map([['storage.drizzle', '1.2.0']]),
        },
      });

      coordinator.load([
        makePackage('needs-storage-version', {
          requires: [{ type: 'capability', id: 'storage.drizzle', version: '>=1.0.0 <2.0.0' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).toHaveBeenCalledOnce();
      expect(coordinator.list()[0]).toMatchObject({ name: 'needs-storage-version', state: 'active' });
    });

    it('excludes a package whose versioned capability requirement is incompatible', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: {
          hosts: new Set(),
          capabilities: new Set(['storage.drizzle']),
          capabilityVersions: new Map([['storage.drizzle', '2.0.0']]),
        },
      });

      coordinator.load([
        makePackage('needs-storage-version', {
          requires: [{ type: 'capability', id: 'storage.drizzle', version: '>=1.0.0 <2.0.0' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).not.toHaveBeenCalled();
      expect(coordinator.list()).toHaveLength(0);
    });

    it('excludes a package whose versioned capability requirement has no declared host version', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: {
          hosts: new Set(),
          capabilities: new Set(['storage.drizzle']),
        },
      });

      coordinator.load([
        makePackage('needs-storage-version', {
          requires: [{ type: 'capability', id: 'storage.drizzle', version: '>=1.0.0 <2.0.0' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).not.toHaveBeenCalled();
      expect(coordinator.list()).toHaveLength(0);
    });

    it('passes all requires when no runtimeEnvironment is set on coordinator', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });

      coordinator.load([
        makePackage('needs-foo-no-caps', {
          requires: [{ type: 'capability', id: 'foo' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).toHaveBeenCalledOnce();
      expect(coordinator.list()).toHaveLength(1);
      expect(coordinator.list()[0]).toMatchObject({ name: 'needs-foo-no-caps', state: 'active' });
    });

    it('includes packages with no requires regardless of runtimeEnvironment', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['foo']) },
      });

      coordinator.load([
        makePackage('no-requires-pkg', {
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).toHaveBeenCalledOnce();
      expect(coordinator.list()).toHaveLength(1);
      expect(coordinator.list()[0]).toMatchObject({ name: 'no-requires-pkg', state: 'active' });
    });

    it('transitively prunes dependents of a gated-out package', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['bar']) },
      });

      // parent requires 'foo' (not in capabilities) → filtered out.
      // child depends on parent → transitively pruned instead of throwing.
      coordinator.load([
        makePackage('parent', {
          requires: [{ type: 'capability', id: 'foo' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
        makePackage('child', {
          dependencies: [dep('parent')],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).not.toHaveBeenCalled();
      expect(coordinator.list()).toHaveLength(0);
    });

    it('keeps siblings when only one branch is gated out', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['bar']) },
      });

      coordinator.load([
        makePackage('gated-parent', {
          requires: [{ type: 'capability', id: 'foo' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
        makePackage('gated-child', {
          dependencies: [dep('gated-parent')],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
        makePackage('independent', {
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).toHaveBeenCalledOnce();
      expect(coordinator.list()).toHaveLength(1);
      expect(coordinator.list()[0]).toMatchObject({ name: 'independent', state: 'active' });
    });

    it('gates on host identity when type is host', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(['linux']), capabilities: new Set() },
      });

      coordinator.load([
        makePackage('linux-only', {
          requires: [{ type: 'host', id: 'linux' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).toHaveBeenCalledOnce();
      expect(coordinator.list()[0]).toMatchObject({ name: 'linux-only', state: 'active' });
    });

    it('excludes package gated on host identity when running on a different host', async () => {
      const initFn = vi.fn();
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runtimeEnvironment: { hosts: new Set(['darwin']), capabilities: new Set() },
      });

      coordinator.load([
        makePackage('linux-only', {
          requires: [{ type: 'host', id: 'linux' }],
          create: (ctx) => makeMockService(ctx.bus, initFn),
        }),
      ]);
      await coordinator.startAll();

      expect(initFn).not.toHaveBeenCalled();
      expect(coordinator.list()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ExtensionToken and getService()
  // ---------------------------------------------------------------------------

  describe('ExtensionToken and getService()', () => {
    it('getService returns the service created by a dependency package', async () => {
      /**
       * A concrete service type for package A, carrying a public field that
       * lets package B verify it received the real instance.
       */
      class ServiceA extends BaseService {
        public readonly tag = 'service-a-instance';

        /**
         * @param bus - Bus instance forwarded to BaseService.
         */
        public constructor(bus: IMakaioBus) {
          super(bus);
        }

        protected async onInit(): Promise<void> {}

        protected async onDestroy(): Promise<void> {}
      }

      const tokenA = extensionToken<ServiceA>('pkg-a');
      let capturedService: ServiceA | undefined;

      const pkgA = makePackage('pkg-a', {
        create: (ctx) => new ServiceA(ctx.bus),
      });

      const pkgB = makePackage('pkg-b', {
        dependencies: [dep('pkg-a')],
        create: (ctx) => {
          capturedService = ctx.getService(tokenA);
          return makeMockService(ctx.bus);
        },
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkgA, pkgB]);
      await coordinator.startAll();

      expect(capturedService).toBeDefined();
      expect(capturedService?.tag).toBe('service-a-instance');
    });

    it('getService returns undefined for packages that have not started', async () => {
      const tokenB = extensionToken<BaseService>('pkg-b');
      let capturedService: BaseService | undefined = null as unknown as BaseService;

      // pkg-a starts before pkg-b, so when pkg-a's create() runs,
      // pkg-b has not yet started — getService(tokenB) must return undefined.
      const pkgA = makePackage('pkg-a', {
        create: (ctx) => {
          capturedService = ctx.getService(tokenB);
          return makeMockService(ctx.bus);
        },
      });

      const pkgB = makePackage('pkg-b', {
        dependencies: [dep('pkg-a')],
        create: (ctx) => makeMockService(ctx.bus),
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkgA, pkgB]);
      await coordinator.startAll();

      expect(capturedService).toBeUndefined();
    });

    it('getService returns undefined for unknown package names', async () => {
      const tokenUnknown = extensionToken<BaseService>('does-not-exist');
      let capturedService: BaseService | undefined = null as unknown as BaseService;

      const pkg = makePackage('only-pkg', {
        create: (ctx) => {
          capturedService = ctx.getService(tokenUnknown);
          return makeMockService(ctx.bus);
        },
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkg]);
      await coordinator.startAll();

      expect(capturedService).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // ExtensionIdentity injection
  // ---------------------------------------------------------------------------

  describe('ExtensionIdentity', () => {
    it('injects an identity whose packageName matches the package name', async () => {
      let capturedIdentity: ExtensionContext['identity'] | undefined;

      const pkg = makePackage('identity-pkg', {
        create: (ctx) => {
          capturedIdentity = ctx.identity;
          return makeMockService(ctx.bus);
        },
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkg]);
      await coordinator.startAll();

      expect(capturedIdentity).toBeDefined();
      expect(capturedIdentity?.extensionName).toBe('identity-pkg');
    });

    it('gives distinct identity objects to two different packages', async () => {
      let identityA: ExtensionContext['identity'] | undefined;
      let identityB: ExtensionContext['identity'] | undefined;

      const pkgA = makePackage('pkg-identity-a', {
        create: (ctx) => {
          identityA = ctx.identity;
          return makeMockService(ctx.bus);
        },
      });

      const pkgB = makePackage('pkg-identity-b', {
        create: (ctx) => {
          identityB = ctx.identity;
          return makeMockService(ctx.bus);
        },
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkgA, pkgB]);
      await coordinator.startAll();

      expect(identityA).toBeDefined();
      expect(identityB).toBeDefined();
      expect(identityA?.extensionName).toBe('pkg-identity-a');
      expect(identityB?.extensionName).toBe('pkg-identity-b');
      expect(identityA).not.toBe(identityB);
    });

    it('provides a frozen identity object', async () => {
      let capturedIdentity: ExtensionContext['identity'] | undefined;

      const pkg = makePackage('frozen-pkg', {
        create: (ctx) => {
          capturedIdentity = ctx.identity;
          return makeMockService(ctx.bus);
        },
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkg]);
      await coordinator.startAll();

      expect(capturedIdentity).toBeDefined();
      expect(Object.isFrozen(capturedIdentity)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // BootProgressObserver lifecycle events
  // ---------------------------------------------------------------------------

  describe('BootProgressObserver lifecycle events', () => {
    it('emits boot.service.starting for each package during startAll', async () => {
      const startingEvents: Array<{ name: string; displayName: string }> = [];

      bus.on(BootSubjects.service.starting, (ctx) => {
        startingEvents.push({ name: ctx.payload.name, displayName: ctx.payload.displayName });
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([
        makePackage('svc-a', { create: (ctx) => makeMockService(ctx.bus) }),
        makePackage('svc-b', { create: (ctx) => makeMockService(ctx.bus) }),
      ]);
      await coordinator.startAll();

      expect(startingEvents).toContainEqual({ name: 'svc-a', displayName: 'svc-a' });
      expect(startingEvents).toContainEqual({ name: 'svc-b', displayName: 'svc-b' });
    });

    it('emits boot.service.ready with duration after successful init', async () => {
      const readyEvents: Array<{ name: string; durationMs: number }> = [];

      bus.on(BootSubjects.service.ready, (ctx) => {
        readyEvents.push({ name: ctx.payload.name, durationMs: ctx.payload.durationMs });
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([makePackage('ready-svc', { create: (ctx) => makeMockService(ctx.bus) })]);
      await coordinator.startAll();

      expect(readyEvents).toHaveLength(1);
      expect(readyEvents[0]?.name).toBe('ready-svc');
      expect(readyEvents[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('emits only serializable boot service identity fields from package metadata', async () => {
      const servicePayloads: object[] = [];
      const pkg = makePackage('cyclic-svc', { create: (ctx) => makeMockService(ctx.bus) }) as MakaioExtension & {
        self?: unknown;
      };
      pkg.self = pkg;

      bus.on(BootSubjects.service.starting, (ctx) => {
        servicePayloads.push(ctx.payload);
      });
      bus.on(BootSubjects.service.ready, (ctx) => {
        servicePayloads.push(ctx.payload);
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkg]);
      await coordinator.startAll();

      expect(servicePayloads).toHaveLength(2);
      expect(servicePayloads[0]).toEqual({ name: 'cyclic-svc', displayName: 'cyclic-svc' });
      expect(servicePayloads[1]).toEqual({
        name: 'cyclic-svc',
        displayName: 'cyclic-svc',
        durationMs: expect.any(Number),
      });
    });

    it('emits boot.progress with completedCount and totalCount', async () => {
      const progressEvents: Array<{ completedCount: number; totalCount: number }> = [];

      bus.on(BootSubjects.progress, (ctx) => {
        progressEvents.push({
          completedCount: ctx.payload.completedCount,
          totalCount: ctx.payload.totalCount,
        });
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([
        makePackage('prog-a', { create: (ctx) => makeMockService(ctx.bus) }),
        makePackage('prog-b', { create: (ctx) => makeMockService(ctx.bus) }),
      ]);
      await coordinator.startAll();

      // One progress event per settled package (2 total)
      expect(progressEvents).toHaveLength(2);
      expect(progressEvents[0]).toMatchObject({ completedCount: 1, totalCount: 2 });
      expect(progressEvents[1]).toMatchObject({ completedCount: 2, totalCount: 2 });
    });

    it('emits boot.complete after all packages settle', async () => {
      const completeEvents: Array<{ totalDurationMs: number; failedServices: string[] }> = [];

      bus.on(BootSubjects.complete, (ctx) => {
        completeEvents.push({
          totalDurationMs: ctx.payload.totalDurationMs,
          failedServices: ctx.payload.failedServices,
        });
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([
        makePackage('complete-a', { create: (ctx) => makeMockService(ctx.bus) }),
        makePackage('complete-b', {
          create: (ctx) =>
            makeMockService(ctx.bus, async () => {
              throw new Error('boom');
            }),
        }),
      ]);
      await coordinator.startAll();

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]?.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(completeEvents[0]?.failedServices).toContain('complete-b');
    });

    it('serves boot.getState RPC reflecting current boot progress', async () => {
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([
        makePackage('state-a', { create: (ctx) => makeMockService(ctx.bus) }),
        makePackage('state-b', {
          create: (ctx) =>
            makeMockService(ctx.bus, async () => {
              throw new Error('state-b failed');
            }),
        }),
      ]);
      await coordinator.startAll();

      const state = await bus.request(BootSubjects.getState, {});

      expect(state.complete).toBe(true);
      expect(state.totalCount).toBe(2);
      expect(state.completedCount).toBe(2);
      expect(state.failedServices).toContain('state-b');
      expect(state.totalDurationMs).toBeGreaterThanOrEqual(0);

      await coordinator.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Critical package failure with regular Error
  // ---------------------------------------------------------------------------

  describe('critical package failure', () => {
    it('throws when critical package fails with regular Error (not ServiceSkipError)', async () => {
      const fatalError = new Error('fatal');
      const pkg = makePackage('critical-pkg', {
        critical: true,
        create: (_ctx) => {
          throw fatalError;
        },
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });
      coordinator.load([pkg]);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(coordinator.startAll()).rejects.toThrow('fatal');
      consoleSpy.mockRestore();

      const state = await bus.request(BootSubjects.getState, {});
      const info = coordinator.list().find((e) => e.name === 'critical-pkg');

      expect(state.complete).toBe(true);
      expect(state.failedServices).toContain('critical-pkg');
      expect(info?.state).toBe('failed');
      expect(info?.error).toBe('fatal');
    });
  });

  // ---------------------------------------------------------------------------
  // runMigrations callback
  // ---------------------------------------------------------------------------

  describe('runMigrations callback', () => {
    it('invokes runMigrations with sources from packages that declare storage.migrations', async () => {
      const migrationSources: Array<{ name: string; migrationsPath: string; migrationSourceId: string }> = [];
      const runMigrations = vi.fn(
        async (sources: ReadonlyArray<{ name: string; migrationsPath: string; migrationSourceId: string }>) => {
          for (const s of sources) {
            migrationSources.push(s);
          }
        },
      );

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runMigrations,
      });

      coordinator.load([
        makePackage('no-migrations-pkg', {
          create: (ctx) => makeMockService(ctx.bus),
        }),
        makePackage('with-migrations-pkg', {
          storage: { migrations: 'drizzle', packageRoot: '/abs/path' },
          create: (ctx) => makeMockService(ctx.bus),
        }),
      ]);
      await coordinator.startAll();

      expect(runMigrations).toHaveBeenCalledOnce();
      expect(migrationSources).toEqual([
        {
          name: 'with-migrations-pkg',
          migrationsPath: path.resolve('/abs/path', 'drizzle'),
          migrationSourceId: path.resolve('/abs/path', 'drizzle'),
        },
      ]);

      await coordinator.shutdown();
    });

    it('does not invoke runMigrations when no packages declare storage.migrations', async () => {
      const runMigrations = vi.fn(async () => {});

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runMigrations,
      });

      coordinator.load([makePackage('plain-pkg', { create: (ctx) => makeMockService(ctx.bus) })]);
      await coordinator.startAll();

      expect(runMigrations).not.toHaveBeenCalled();

      await coordinator.shutdown();
    });

    it('invokes runMigrations before any package service is initialized', async () => {
      const callOrder: string[] = [];
      const runMigrations = vi.fn(async () => {
        callOrder.push('migrations');
      });

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runMigrations,
      });

      coordinator.load([
        makePackage('ordered-pkg', {
          storage: { migrations: '/drizzle' },
          create: (ctx) =>
            makeMockService(ctx.bus, () => {
              callOrder.push('init');
            }),
        }),
      ]);
      await coordinator.startAll();

      expect(callOrder).toEqual(['migrations', 'init']);

      await coordinator.shutdown();
    });

    it('passes sources in topological dependency order', async () => {
      const capturedOrder: string[] = [];
      const runMigrations = vi.fn(
        async (sources: ReadonlyArray<{ name: string; migrationsPath: string; migrationSourceId: string }>) => {
          for (const s of sources) {
            capturedOrder.push(s.name);
          }
        },
      );

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runMigrations,
      });

      // b depends on a — so a must appear first in migration sources
      coordinator.load([
        makePackage('b', {
          dependencies: [dep('a')],
          storage: { migrations: '/b/drizzle' },
        }),
        makePackage('a', {
          storage: { migrations: '/a/drizzle' },
        }),
      ]);
      await coordinator.startAll();

      expect(capturedOrder).toEqual(['a', 'b']);

      await coordinator.shutdown();
    });

    it('excludes a disabled package from migration sources but keeps its entry toggleable via setEnabled', async () => {
      // A disabled extension is the operator's escape hatch when its own
      // migration is what is breaking boot. Running that migration anyway —
      // before `startExtensionEntry` ever gets a chance to skip the disabled
      // entry — would defeat the escape hatch and could still mutate the
      // database or abort startup. Only an enabled package's migrations run;
      // the disabled package still gets a coordinator entry so it is
      // observable and toggleable, even though `setEnabled` on it can only
      // ever report `'restart-required'` — its migrations were skipped here,
      // so nothing this process could enable would run against a schema they
      // never created.
      const migrationSources: Array<{ name: string; migrationsPath: string; migrationSourceId: string }> = [];
      const runMigrations = vi.fn(
        async (sources: ReadonlyArray<{ name: string; migrationsPath: string; migrationSourceId: string }>) => {
          for (const s of sources) {
            migrationSources.push(s);
          }
        },
      );

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        loadEnabled: (name) => (name === 'disabled-migrations-pkg' ? false : undefined),
        runMigrations,
      });

      coordinator.load([
        makePackage('disabled-migrations-pkg', {
          storage: { migrations: '/disabled/drizzle' },
        }),
        makePackage('enabled-migrations-pkg', {
          storage: { migrations: '/enabled/drizzle' },
        }),
      ]);
      await coordinator.startAll();

      expect(runMigrations).toHaveBeenCalledOnce();
      expect(migrationSources).toEqual([
        {
          name: 'enabled-migrations-pkg',
          migrationsPath: '/enabled/drizzle',
          migrationSourceId: '/enabled/drizzle',
        },
      ]);

      const disabledInfo = coordinator.list().find((e) => e.name === 'disabled-migrations-pkg');
      expect(disabledInfo?.state).toBe('skipped');
      expect(disabledInfo?.enabled).toBe(false);

      await coordinator.shutdown();
    });

    it('resolves relative migrations against storage.packageRoot', async () => {
      const migrationSources: Array<{ name: string; migrationsPath: string; migrationSourceId: string }> = [];
      const runMigrations = vi.fn(
        async (sources: ReadonlyArray<{ name: string; migrationsPath: string; migrationSourceId: string }>) => {
          migrationSources.push(...sources);
        },
      );

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runMigrations,
      });

      coordinator.load([
        makePackage('relative-migrations-pkg', {
          storage: {
            migrations: './drizzle',
            packageRoot: '/pkg/root',
          },
        }),
      ]);
      await coordinator.startAll();

      expect(migrationSources).toEqual([
        {
          name: 'relative-migrations-pkg',
          migrationsPath: '/pkg/root/drizzle',
          migrationSourceId: '/pkg/root/drizzle',
        },
      ]);

      await coordinator.shutdown();
    });

    it('passes explicit storage.migrationSourceId through to the host callback', async () => {
      const migrationSources: Array<{ name: string; migrationsPath: string; migrationSourceId: string }> = [];
      const runMigrations = vi.fn(
        async (sources: ReadonlyArray<{ name: string; migrationsPath: string; migrationSourceId: string }>) => {
          migrationSources.push(...sources);
        },
      );

      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
        runMigrations,
      });

      coordinator.load([
        makePackage('stable-source-pkg', {
          storage: {
            migrations: './drizzle',
            packageRoot: '/pkg/root',
            migrationSourceId: 'host/services/src/stable-source/drizzle',
          },
        }),
      ]);
      await coordinator.startAll();

      expect(migrationSources).toEqual([
        {
          name: 'stable-source-pkg',
          migrationsPath: '/pkg/root/drizzle',
          migrationSourceId: 'host/services/src/stable-source/drizzle',
        },
      ]);

      await coordinator.shutdown();
    });

    it('skips runMigrations entirely when the callback is not provided', async () => {
      // No runMigrations option — packages with storage.migrations should not cause errors
      const coordinator = new ExtensionCoordinator(bus, {
        extensionContextBase: TEST_PKG_CTX_BASE,
      });

      coordinator.load([
        makePackage('silent-migrations-pkg', {
          storage: { migrations: '/some/drizzle' },
          create: (ctx) => makeMockService(ctx.bus),
        }),
      ]);

      await expect(coordinator.startAll()).resolves.toBeUndefined();
      const info = coordinator.list().find((e) => e.name === 'silent-migrations-pkg');
      expect(info?.state).toBe('active');

      await coordinator.shutdown();
    });
  });
});
