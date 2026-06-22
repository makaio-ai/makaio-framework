import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import {
  createClientDefinition,
  type ExtensionDependency,
  type NodeExtensionContext as ExtensionContext,
  type ProviderDefinition,
  type TrayManifest,
} from '@makaio/contracts';
import type { KernelMakaioExtension as MakaioExtension } from '../extension/types.js';
import { TrayMenuEntrySchema, TrayMenuSubjects, TrayMenuEntry } from '@makaio/services-core/tray-menu';
import { extensionToken } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
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
    coordinator.load(packages);
    await coordinator.startAll();

    expect(callOrder).toEqual(['a', 'b', 'c']);
  });

  it('filters out packages that do not match the runtime surface', async () => {
    const initInteractive = vi.fn();
    const initHeadless = vi.fn();

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('interactive-only', {
        surface: 'interactive',
        create: (ctx) => makeMockService(ctx.bus, initInteractive),
      }),
      makePackage('headless-only', {
        surface: 'headless',
        create: (ctx) => makeMockService(ctx.bus, initHeadless),
      }),
    ]);

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
      availableModels: [],
    };
    const clientDefinition = createClientDefinition({
      id: 'codex',
      name: 'Codex',
      version: '0.1.0',
      defaultApprovalPolicy: 'full-access',
    });
    const packages: MakaioExtension[] = [
      makePackage('catalog-ext', {
        providers: [providerDefinition],
        clients: [clientDefinition],
        create: (ctx) => makeMockService(ctx.bus),
      }),
      makePackage('disabled-ext', {
        providers: [{ id: 'disabled-provider', name: 'Disabled Provider', availableModels: [] }],
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

  // 13. Shutdown continues even when destroy throws
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

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await coordinator.shutdown();
    consoleSpy.mockRestore();

    // c and a should still have shut down despite b throwing
    expect(shutdownOrder).toContain('c');
    expect(shutdownOrder).toContain('a');
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

  // 17. persistEnabled is called when setEnabled toggles state
  it('calls persistEnabled callback when setEnabled changes state', async () => {
    const persisted: Array<{ name: string; enabled: boolean }> = [];
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      persistEnabled: async (name, enabled) => {
        persisted.push({ name, enabled });
      },
    });

    coordinator.load([makePackage('persist-pkg', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    // Disable the package
    const disableResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'persist-pkg',
      enabled: false,
    });
    expect(disableResult.success).toBe(true);
    expect(persisted).toContainEqual({ name: 'persist-pkg', enabled: false });

    // Re-enable the package
    const enableResult = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'persist-pkg',
      enabled: true,
    });
    expect(enableResult.success).toBe(true);
    expect(persisted).toContainEqual({ name: 'persist-pkg', enabled: true });

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

    await coordinator.shutdown();
  });

  it('retries persistEnabled on same-state setEnabled calls after a persistence failure', async () => {
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

    expect(retryResult.success).toBe(false);
    expect(persisted).toEqual([false, false]);

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

    await bus.request(ExtensionSubjects.setEnabled, { name: 'storage-pkg', enabled: false });

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
    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'child', enabled: true });
    expect(result.success).toBe(false);
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
    await bus.request(ExtensionSubjects.setEnabled, { name: 're-storage-pkg', enabled: false });
    await bus.request(ExtensionSubjects.setEnabled, { name: 're-storage-pkg', enabled: true });

    expect(registerHandlers).toHaveBeenCalledTimes(2);

    await coordinator.shutdown();
  });

  it('registers namespaces before enabling a package skipped at boot', async () => {
    const namespace = createBusNamespace('test-extension:reenable', {
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
      loadEnabled: () => false,
    });

    coordinator.load([
      makePackage('reenable-namespaced-pkg', {
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
    await coordinator.startAll();

    expect(bus.getSchema(namespace.subjects.ping)).toBeDefined();

    const result = await bus.request(ExtensionSubjects.setEnabled, {
      name: 'reenable-namespaced-pkg',
      enabled: true,
    });

    expect(result.success).toBe(true);
    expect(observed).toEqual(['storage', 'create', 'init']);

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
      dataDir: '/home/test/.makaio/storage-context-pkg',
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

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'failing-reenable-pkg', enabled: true });
    expect(result.success).toBe(false);
    // Called twice: once during startAll failure (startEntry cleanup)
    // and once during re-enable failure (cleanupFailedEnable).
    expect(storageCleanup).toHaveBeenCalledTimes(2);
  });

  it('rejects disable when active dependents still require the package', async () => {
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

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'dep', enabled: false });

    expect(result.success).toBe(false);
    const depInfo = coordinator.list().find((entry) => entry.name === 'dep');
    expect(depInfo).toMatchObject({
      state: 'active',
      enabled: true,
    });

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

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'dep', enabled: false });

    expect(result.success).toBe(true);
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

    const blocked = await bus.request(ExtensionSubjects.setEnabled, { name: 'dep', enabled: false });
    expect(blocked.success).toBe(false);
    expect(coordinator.list().find((entry) => entry.name === 'dep')?.error).toContain('active dependents remain');

    await bus.request(ExtensionSubjects.setEnabled, { name: 'child', enabled: false });
    const disabled = await bus.request(ExtensionSubjects.setEnabled, { name: 'dep', enabled: false });
    const depInfo = coordinator.list().find((entry) => entry.name === 'dep');

    expect(disabled.success).toBe(true);
    expect(depInfo).toMatchObject({
      state: 'stopped',
      enabled: false,
    });
    expect(depInfo?.error).toBeUndefined();

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Context derivation tests
  // ---------------------------------------------------------------------------

  // 21. dataDir is derived from makaioHome + packageName
  it('ctx.dataDir is derived from makaioHome and packageName', async () => {
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
    expect(capturedCtx!.dataDir).toBe(path.join(TEST_PKG_CTX_BASE.makaioHome, 'my-extension'));
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

  // 33. enabledChanged fires when setEnabled disables an active extension
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

    await bus.request(ExtensionSubjects.setEnabled, { name: 'event-ext', enabled: false });

    expect(events).toContainEqual({ name: 'event-ext', enabled: false });

    await coordinator.shutdown();
  });

  // 34. enabledChanged fires when setEnabled re-enables a stopped extension
  it('enabledChanged event fires with correct payload when re-enabling', async () => {
    const events: Array<{ name: string; enabled: boolean }> = [];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('toggle-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    // Disable first so re-enable has a valid transition (stopped -> active).
    await bus.request(ExtensionSubjects.setEnabled, { name: 'toggle-ext', enabled: false });

    bus.on(ExtensionSubjects.enabledChanged, (ctx) => {
      events.push({ name: ctx.payload.name, enabled: ctx.payload.enabled });
    });

    await bus.request(ExtensionSubjects.setEnabled, { name: 'toggle-ext', enabled: true });

    expect(events).toContainEqual({ name: 'toggle-ext', enabled: true });

    await coordinator.shutdown();
  });

  // ---------------------------------------------------------------------------
  // list() reflects stopped state after disable
  // ---------------------------------------------------------------------------

  // 35. list() shows stopped state after disable via setEnabled
  it('list() shows state: stopped for a disabled extension', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([makePackage('stoppable-ext', { create: (ctx) => makeMockService(ctx.bus) })]);
    await coordinator.startAll();

    await bus.request(ExtensionSubjects.setEnabled, { name: 'stoppable-ext', enabled: false });

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

    it('includes disabled packages when collecting migration sources', async () => {
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
          name: 'disabled-migrations-pkg',
          migrationsPath: '/disabled/drizzle',
          migrationSourceId: '/disabled/drizzle',
        },
        {
          name: 'enabled-migrations-pkg',
          migrationsPath: '/enabled/drizzle',
          migrationSourceId: '/enabled/drizzle',
        },
      ]);

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
