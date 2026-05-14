import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import type { ExtensionWarning, NodeExtensionContext as ExtensionContext } from '@makaio/contracts';
import type { ToastPayload } from '@makaio/contracts/toast';
import { ToastSubjects } from '@makaio/contracts/toast';
import { BaseService } from '@makaio/service-base';
import { z } from 'zod';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { KernelMakaioExtension as MakaioExtension } from '../extension/types.js';
import { WARNING_ACTION_ID } from '../extension/warning-action-dispatcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal {@link ExtensionContext} base for test coordinators.
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

/**
 * Concrete {@link BaseService} subclass that implements `checkHealth`.
 */
class HealthService extends BaseService {
  private readonly _warnings: ExtensionWarning[];

  /**
   * @param bus - Bus instance forwarded to BaseService.
   * @param warnings - Warnings to return from {@link checkHealth}.
   */
  public constructor(bus: IMakaioBus, warnings: ExtensionWarning[] = []) {
    super(bus);
    this._warnings = warnings;
  }

  protected async onInit(): Promise<void> {}
  protected async onDestroy(): Promise<void> {}

  /**
   * Returns the configured warnings.
   * @returns Configured health warnings.
   */
  public checkHealth(): ExtensionWarning[] {
    return this._warnings;
  }
}

/**
 * Create a minimal package fixture.
 * @param name - Package identifier.
 * @param options - Optional overrides.
 */
function makePackage(name: string, options: Partial<Omit<MakaioExtension, 'name'>> = {}): MakaioExtension {
  return { name, displayName: name, version: '0.1.0', ...options };
}

/**
 * Wait for fire-and-forget warning action dispatch scheduled by toast listeners.
 */
async function settleWarningActionDispatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Extension warning emission', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits toast.show for degraded warnings', async () => {
    const toasts: ToastPayload[] = [];

    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    const degradedWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Missing token',
      message: 'API token is not configured.',
      action: { kind: 'configure-integration', clientId: 'my-client', bundle: 'my-bundle' },
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('degraded-pkg', {
        displayName: 'Degraded Package',
        create: (ctx) => new HealthService(ctx.bus, [degradedWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      level: 'warning',
      title: 'Missing token',
      message: 'Degraded Package: API token is not configured.',
      toastId: 'degraded-pkg:Missing token:0',
      durationMs: null,
      actions: [{ id: WARNING_ACTION_ID, label: 'Configure' }],
    });

    await coordinator.shutdown();
  });

  it('does not emit toast for info warnings', async () => {
    const toasts: ToastPayload[] = [];

    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    const infoWarning: ExtensionWarning = {
      severity: 'info',
      title: 'Optional feature',
      message: 'An optional integration is not configured.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('info-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [infoWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(toasts).toHaveLength(0);

    await coordinator.shutdown();
  });

  it('does not emit toast for recommended warnings', async () => {
    const toasts: ToastPayload[] = [];

    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    const recommendedWarning: ExtensionWarning = {
      severity: 'recommended',
      title: 'Recommended setup',
      message: 'Configure X for best experience.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('recommended-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [recommendedWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(toasts).toHaveLength(0);

    await coordinator.shutdown();
  });

  it('logs console.warn for degraded warnings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const degradedWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Service down',
      message: 'Backend is unreachable.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('warn-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [degradedWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(warnSpy).toHaveBeenCalledWith('[warn-pkg] ⚠ Service down: Backend is unreachable.');

    await coordinator.shutdown();
  });

  it('does not log console.warn for info warnings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const infoWarning: ExtensionWarning = {
      severity: 'info',
      title: 'FYI',
      message: 'Nothing serious.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('no-warn-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [infoWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(warnSpy).not.toHaveBeenCalled();

    await coordinator.shutdown();
  });

  it('emits toast without actions when warning has no action', async () => {
    const toasts: ToastPayload[] = [];

    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    const degradedWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'No action',
      message: 'Degraded with no remediation.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('no-action-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [degradedWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).not.toHaveProperty('actions');
    expect(toasts[0]?.durationMs).toBeNull();

    await coordinator.shutdown();
  });

  it('emits warnings for a newly enabled package', async () => {
    const toasts: ToastPayload[] = [];

    const degradedWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Re-enable issue',
      message: 'Something is broken after re-enable.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      loadEnabled: () => false,
    });
    coordinator.load([
      makePackage('toggle-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [degradedWarning]),
      }),
    ]);
    await coordinator.startAll();

    // Subscribe AFTER startAll to only observe enable-time emission.
    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    await coordinator.handleSetEnabled('toggle-pkg', true);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      level: 'warning',
      title: 'Re-enable issue',
      message: 'toggle-pkg: Something is broken after re-enable.',
    });

    await coordinator.shutdown();
  });

  it('does not log console.warn for recommended warnings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const recommendedWarning: ExtensionWarning = {
      severity: 'recommended',
      title: 'Optional config',
      message: 'Set up X for better results.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('no-warn-recommended-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [recommendedWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(warnSpy).not.toHaveBeenCalled();

    await coordinator.shutdown();
  });

  it('completes boot and logs console.warn when no toast handler is registered', async () => {
    // Headless mode: no toast.show subscriber registered on the bus.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const degradedWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Headless warning',
      message: 'No toast handler present.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('headless-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [degradedWarning]),
      }),
    ]);

    // Must not throw even though no toast.show handler is registered
    await expect(coordinator.startAll()).resolves.toBeUndefined();

    // console.warn for the degraded warning must still fire
    expect(warnSpy).toHaveBeenCalledWith('[headless-pkg] ⚠ Headless warning: No toast handler present.');

    await coordinator.shutdown();
  });

  it('completes boot when a registered toast handler throws', async () => {
    // Register a handler that throws to simulate a broken toast consumer.
    bus.on(ToastSubjects.show, () => {
      throw new Error('toast handler exploded');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const degradedWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Throwing toast',
      message: 'The toast handler will throw.',
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('throwing-toast-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [degradedWarning]),
      }),
    ]);

    // Must not throw even though the toast handler raises
    await expect(coordinator.startAll()).resolves.toBeUndefined();

    // console.warn for the degraded warning still fires before the toast attempt
    expect(warnSpy).toHaveBeenCalledWith('[throwing-toast-pkg] ⚠ Throwing toast: The toast handler will throw.');

    await coordinator.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by action-dispatch tests
// ---------------------------------------------------------------------------

/**
 * Register a minimal `client:<clientId>.wiring.apply` namespace on the bus
 * so the dispatcher's `requestOptional` call can be handled in tests.
 * @param bus - Test bus instance.
 * @param clientId - Client identifier (e.g. `'test-client'`).
 * @returns Typed subjects for the registered namespace.
 */
function registerWiringApplyNamespace(bus: IMakaioBus, clientId: string) {
  return bus.registerNamespace(
    createBusNamespace(`client:${clientId}`, {
      'wiring.apply': {
        request: z.object({ scope: z.string(), makaioCommand: z.string() }),
        response: z.object({ applied: z.number(), skipped: z.number() }),
      },
    }),
  ).subjects;
}

// ---------------------------------------------------------------------------
// Action dispatch tests
// ---------------------------------------------------------------------------

describe('Extension warning toast action dispatch', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes actions in toast.show payload when warning has an action', async () => {
    const toasts: ToastPayload[] = [];
    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    const warning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Wiring missing',
      message: 'Hooks not installed.',
      action: { kind: 'configure-integration', clientId: 'my-client', bundle: 'my-bundle' },
    };

    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.load([makePackage('wired-pkg', { create: (ctx) => new HealthService(ctx.bus, [warning]) })]);
    await coordinator.startAll();

    expect(toasts[0]?.actions).toHaveLength(1);
    expect(toasts[0]?.actions?.[0]).toMatchObject({ id: WARNING_ACTION_ID, label: 'Configure' });

    await coordinator.shutdown();
  });

  it('emits no actions in toast.show when warning has no action', async () => {
    const toasts: ToastPayload[] = [];
    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    const warning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Silent degraded',
      message: 'Something is wrong but no action is available.',
    };

    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.load([makePackage('silent-pkg', { create: (ctx) => new HealthService(ctx.bus, [warning]) })]);
    await coordinator.startAll();

    expect(toasts[0]).not.toHaveProperty('actions');

    await coordinator.shutdown();
  });

  it('routes configure-integration action to client wiring.apply on toast.interacted', async () => {
    const subjects = registerWiringApplyNamespace(bus, 'test-client');

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const cleanupHandler = bus.on(subjects.wiring.apply, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ applied: 2, skipped: 0 });
    });

    const warning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Wiring needed',
      message: 'Integration hooks not installed.',
      action: { kind: 'configure-integration', clientId: 'test-client', bundle: 'test-bundle' },
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
      launcherCommand: 'host-makaio',
    });
    coordinator.load([makePackage('wiring-pkg', { create: (ctx) => new HealthService(ctx.bus, [warning]) })]);
    await coordinator.startAll();

    const toastId = 'wiring-pkg:Wiring needed:0';
    const originalArgv = [...process.argv];
    process.argv[1] = '/host/entrypoint-that-must-not-leak';

    try {
      await bus.emit(ToastSubjects.interacted, {
        toastId,
        actionId: WARNING_ACTION_ID,
        timestamp: Date.now(),
      });
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }

    await settleWarningActionDispatch();

    cleanupHandler();

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0]).toMatchObject({ scope: 'user', makaioCommand: 'host-makaio' });

    await coordinator.shutdown();
  });

  it('does not route warning actions when toast emission fails', async () => {
    const subjects = registerWiringApplyNamespace(bus, 'failed-toast-client');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let dispatchCount = 0;
    const cleanupHandler = bus.on(subjects.wiring.apply, (ctx) => {
      dispatchCount++;
      ctx.setResult({ applied: 1, skipped: 0 });
    });
    bus.on(ToastSubjects.show, () => {
      throw new Error('toast unavailable');
    });

    const warning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Toast failed',
      message: 'Action should not be registered without a toast.',
      action: { kind: 'configure-integration', clientId: 'failed-toast-client', bundle: 'test-bundle' },
    };

    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.load([makePackage('failed-toast-pkg', { create: (ctx) => new HealthService(ctx.bus, [warning]) })]);
    await coordinator.startAll();

    await bus.emit(ToastSubjects.interacted, {
      toastId: 'failed-toast-pkg:Toast failed:0',
      actionId: WARNING_ACTION_ID,
      timestamp: Date.now(),
    });
    await settleWarningActionDispatch();

    cleanupHandler();
    warnSpy.mockRestore();

    expect(dispatchCount).toBe(0);

    await coordinator.shutdown();
  });

  it('is a no-op when toast.interacted references an unknown toastId', async () => {
    const subjects = registerWiringApplyNamespace(bus, 'unknown-client');

    const dispatchCount = { count: 0 };
    const cleanupHandler = bus.on(subjects.wiring.apply, (ctx) => {
      dispatchCount.count++;
      ctx.setResult({ applied: 0, skipped: 0 });
    });

    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.load([makePackage('no-warning-pkg')]);
    await coordinator.startAll();

    await bus.emit(ToastSubjects.interacted, {
      toastId: 'nonexistent:toast:0',
      actionId: WARNING_ACTION_ID,
      timestamp: Date.now(),
    });

    await settleWarningActionDispatch();

    cleanupHandler();

    expect(dispatchCount.count).toBe(0);

    await coordinator.shutdown();
  });

  it('clears action map on shutdown so stale interactions are no-ops', async () => {
    const subjects = registerWiringApplyNamespace(bus, 'cleanup-client');

    const dispatchCount = { count: 0 };
    const cleanupHandler = bus.on(subjects.wiring.apply, (ctx) => {
      dispatchCount.count++;
      ctx.setResult({ applied: 1, skipped: 0 });
    });

    const warning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Cleanup test',
      message: 'Action should not fire after shutdown.',
      action: { kind: 'configure-integration', clientId: 'cleanup-client', bundle: 'test-bundle' },
    };

    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.load([makePackage('cleanup-pkg', { create: (ctx) => new HealthService(ctx.bus, [warning]) })]);
    await coordinator.startAll();

    // Shut down before interacting — map should be cleared.
    await coordinator.shutdown();

    await bus.emit(ToastSubjects.interacted, {
      toastId: 'cleanup-pkg:Cleanup test:0',
      actionId: WARNING_ACTION_ID,
      timestamp: Date.now(),
    });

    await settleWarningActionDispatch();

    cleanupHandler();

    expect(dispatchCount.count).toBe(0);
  });

  it('prunes stale actions when a package refreshes its warnings', async () => {
    const subjects = registerWiringApplyNamespace(bus, 'stale-client');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let createCount = 0;
    let dispatchCount = 0;
    const cleanupHandler = bus.on(subjects.wiring.apply, (ctx) => {
      dispatchCount++;
      ctx.setResult({ applied: 1, skipped: 0 });
    });

    const staleActionWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Needs wiring',
      message: 'Initial warning has an action.',
      action: { kind: 'configure-integration', clientId: 'stale-client', bundle: 'test-bundle' },
    };
    const refreshedWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Needs wiring',
      message: 'Refreshed warning no longer has an action.',
    };

    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.load([
      makePackage('refresh-pkg', {
        create: (ctx) => {
          createCount++;
          return new HealthService(ctx.bus, [createCount === 1 ? staleActionWarning : refreshedWarning]);
        },
      }),
    ]);
    await coordinator.startAll();

    await coordinator.handleSetEnabled('refresh-pkg', false);
    await coordinator.handleSetEnabled('refresh-pkg', true);

    await bus.emit(ToastSubjects.interacted, {
      toastId: 'refresh-pkg:Needs wiring:0',
      actionId: WARNING_ACTION_ID,
      timestamp: Date.now(),
    });
    await settleWarningActionDispatch();

    cleanupHandler();
    warnSpy.mockRestore();

    expect(dispatchCount).toBe(0);

    await coordinator.shutdown();
  });

  it('does not emit toast actions for warning action kinds the runtime cannot route', async () => {
    const toasts: ToastPayload[] = [];
    bus.on(ToastSubjects.show, (ctx) => {
      toasts.push(ctx.payload);
    });

    const openUrlWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Open link',
      message: 'Visit the docs.',
      action: { kind: 'open-url', url: 'https://example.com' },
    };
    const installWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Install needed',
      message: 'Install the extension.',
      action: { kind: 'install-extension', extensionName: 'some-extension' },
    };
    const runCmdWarning: ExtensionWarning = {
      severity: 'degraded',
      title: 'Run setup',
      message: 'Run the setup command.',
      action: { kind: 'run-command', command: 'setup run' },
    };

    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.load([
      makePackage('unsupported-actions-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [openUrlWarning, installWarning, runCmdWarning]),
      }),
    ]);
    await coordinator.startAll();

    expect(toasts).toHaveLength(3);
    expect(toasts[0]).not.toHaveProperty('actions');
    expect(toasts[1]).not.toHaveProperty('actions');
    expect(toasts[2]).not.toHaveProperty('actions');

    await coordinator.shutdown();
  });
});
