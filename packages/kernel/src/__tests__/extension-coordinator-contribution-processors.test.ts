import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { NodeExtensionContext as ExtensionContext, MakaioExtension } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { ServiceSkipError } from '../service-skip-error.js';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { ContributionProcessor } from '../extension/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal {@link BaseService} subclass used when a package only needs to be
 * present in the coordinator without any service-specific behaviour.
 */
class NoopService extends BaseService {
  /**
   * @param bus - Bus instance forwarded to BaseService.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {}

  protected async onDestroy(): Promise<void> {}
}

/**
 * Minimal service that records teardown for disable-flow assertions.
 */
class TrackingService extends BaseService {
  /**
   * @param bus - Bus instance forwarded to BaseService.
   * @param events - Mutable event log owned by the test.
   */
  public constructor(
    bus: IMakaioBus,
    private readonly events: string[],
  ) {
    super(bus);
  }

  protected async onInit(): Promise<void> {}

  protected async onDestroy(): Promise<void> {
    this.events.push('service-destroyed');
  }
}

/**
 * Minimal {@link ExtensionContext} fields (excluding coordinator-owned and
 * bus-owned fields) for test coordinators.
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
 * Build a minimal extension manifest.
 * @param name - Extension name and display name.
 * @param overrides - Optional manifest property overrides.
 * @returns A {@link MakaioExtension} suitable for test coordinators.
 */
function pkg(name: string, overrides: Partial<MakaioExtension> = {}): MakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    create: (ctx) => new NoopService(ctx.bus),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtensionCoordinator contribution processor lifecycle', () => {
  it('calls processActivated on boot, processStopped on disable, and processActivated again on re-enable', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });

    const activated = vi.fn<ContributionProcessor['processActivated']>().mockResolvedValue(undefined);
    const stopped = vi.fn<NonNullable<ContributionProcessor['processStopped']>>().mockResolvedValue(undefined);

    coordinator.registerContributionProcessor({
      filter: (manifest) => manifest.name === 'feature',
      processActivated: activated,
      processStopped: stopped,
    });

    coordinator.load([pkg('feature')]);

    await coordinator.startAll();
    expect(activated).toHaveBeenCalledTimes(1);
    expect(activated.mock.calls[0]?.[0]).toBe('feature');

    await coordinator.handleSetEnabled('feature', false);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0]?.[0]).toBe('feature');

    await coordinator.handleSetEnabled('feature', true);
    expect(activated).toHaveBeenCalledTimes(2);
    expect(activated.mock.calls[1]?.[0]).toBe('feature');
  });

  it('does not call processor for extensions that do not match the filter', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });

    const activated = vi.fn<ContributionProcessor['processActivated']>().mockResolvedValue(undefined);

    coordinator.registerContributionProcessor({
      filter: (manifest) => manifest.name === 'included',
      processActivated: activated,
    });

    coordinator.load([pkg('included'), pkg('excluded')]);
    await coordinator.startAll();

    expect(activated).toHaveBeenCalledTimes(1);
    expect(activated.mock.calls[0]?.[0]).toBe('included');
  });

  it('calls processActivated for all extensions when no filter is declared', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });

    const activated = vi.fn<ContributionProcessor['processActivated']>().mockResolvedValue(undefined);

    coordinator.registerContributionProcessor({ processActivated: activated });

    coordinator.load([pkg('alpha'), pkg('beta')]);
    await coordinator.startAll();

    expect(activated).toHaveBeenCalledTimes(2);
    const names = activated.mock.calls.map((call) => call[0]);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('rolls back earlier processors when a later processor throws during activation', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });

    const firstStopped = vi.fn<NonNullable<ContributionProcessor['processStopped']>>().mockResolvedValue(undefined);

    // First processor succeeds — its processStopped must be called on rollback.
    coordinator.registerContributionProcessor({
      processActivated: async () => undefined,
      processStopped: firstStopped,
    });

    // Second processor always throws — triggers rollback.
    coordinator.registerContributionProcessor({
      processActivated: async () => {
        throw new Error('processor failed');
      },
    });

    coordinator.load([pkg('feature')]);
    await coordinator.startAll();

    // The extension must transition to failed.
    const info = coordinator.list().find((entry) => entry.name === 'feature');
    expect(info?.state).toBe('failed');
    expect(info?.error).toBe('processor failed');

    // The first processor's stopped callback must have been called during rollback.
    expect(firstStopped).toHaveBeenCalledTimes(1);
    expect(firstStopped.mock.calls[0]?.[0]).toBe('feature');
  });

  it('marks no-service extensions skipped when contribution activation raises ServiceSkipError', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });

    coordinator.registerContributionProcessor({
      processActivated: async () => {
        throw new ServiceSkipError('feature unavailable');
      },
    });

    coordinator.load([
      pkg('feature', {
        create: undefined,
      }),
    ]);

    await coordinator.startAll();

    const info = coordinator.list().find((entry) => entry.name === 'feature');
    expect(info?.state).toBe('skipped');
    expect(info?.error).toBe('feature unavailable');
  });

  it('runs processors in registration order during activation', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });

    const callOrder: string[] = [];

    coordinator.registerContributionProcessor({
      processActivated: async () => {
        callOrder.push('first');
      },
    });
    coordinator.registerContributionProcessor({
      processActivated: async () => {
        callOrder.push('second');
      },
    });

    coordinator.load([pkg('feature')]);
    await coordinator.startAll();

    expect(callOrder).toEqual(['first', 'second']);
  });

  it('runs stopped processors in reverse registration order during disable', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
    const callOrder: string[] = [];

    coordinator.registerContributionProcessor({
      processActivated: async () => undefined,
      processStopped: async () => {
        callOrder.push('first');
      },
    });
    coordinator.registerContributionProcessor({
      processActivated: async () => undefined,
      processStopped: async () => {
        callOrder.push('second');
      },
    });

    coordinator.load([pkg('feature')]);
    await coordinator.startAll();
    await coordinator.handleSetEnabled('feature', false);

    expect(callOrder).toEqual(['second', 'first']);
  });

  it('treats stopped processor errors as best-effort during disable cleanup', async () => {
    const bus = createBusInstance();
    const events: string[] = [];
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    coordinator.registerContributionProcessor({
      processActivated: async () => undefined,
      processStopped: async () => {
        events.push('processor-failed');
        throw new Error('stopped processor failed');
      },
    });

    coordinator.load([
      pkg('feature', {
        create: (ctx) => new TrackingService(ctx.bus, events),
        storage: {
          registerHandlers: () => {
            return () => {
              events.push('storage-cleaned');
            };
          },
        },
      }),
    ]);
    await coordinator.startAll();

    try {
      const disabled = await coordinator.handleSetEnabled('feature', false);
      const info = coordinator.list().find((entry) => entry.name === 'feature');

      expect(disabled).toBe(true);
      expect(info?.state).toBe('stopped');
      expect(events).toEqual(['processor-failed', 'service-destroyed', 'storage-cleaned']);
      expect(consoleError).toHaveBeenCalledWith(
        '[ExtensionCoordinator] Contribution processor error (stopped) for "feature":',
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('transitions active entries to stopped during shutdown and does not stop contributions twice', async () => {
    const bus = createBusInstance();
    const events: string[] = [];
    const coordinator = new ExtensionCoordinator(bus, {
      db: {},
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    const stopped = vi.fn<NonNullable<ContributionProcessor['processStopped']>>(async () => {
      events.push('processor-stopped');
    });

    coordinator.registerContributionProcessor({
      processActivated: async () => undefined,
      processStopped: stopped,
    });

    coordinator.load([
      pkg('feature', {
        create: (ctx) => new TrackingService(ctx.bus, events),
        storage: {
          registerHandlers: () => {
            return () => {
              events.push('storage-cleaned');
            };
          },
        },
      }),
    ]);
    await coordinator.startAll();

    await coordinator.shutdown();
    await coordinator.shutdown();

    const info = coordinator.list().find((entry) => entry.name === 'feature');
    expect(info?.state).toBe('stopped');
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['processor-stopped', 'service-destroyed', 'storage-cleaned']);
  });

  it('removed processor is not called after cleanup function is invoked', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });

    const activated = vi.fn<ContributionProcessor['processActivated']>().mockResolvedValue(undefined);
    const removeProcessor = coordinator.registerContributionProcessor({ processActivated: activated });

    // Remove before load/startAll.
    removeProcessor();

    coordinator.load([pkg('feature')]);
    await coordinator.startAll();

    expect(activated).not.toHaveBeenCalled();
  });
});
