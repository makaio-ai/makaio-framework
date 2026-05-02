import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionWarning, MakaioExtension, NodeExtensionContext as ExtensionContext } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import { ExtensionSubjects } from '../observability/extension-namespace.js';

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
 * A warning fixture for reuse across tests.
 */
const FIXTURE_WARNING: ExtensionWarning = {
  severity: 'recommended',
  title: 'Test warning',
  message: 'Something is misconfigured.',
};

/**
 * Concrete {@link BaseService} subclass that implements `checkHealth`.
 *
 * Tracks the number of times `checkHealth` is called so tests can assert
 * on call count without mocking.
 */
class HealthService extends BaseService {
  private readonly warnings: ExtensionWarning[];
  /** Number of times {@link checkHealth} has been called. */
  public checkHealthCallCount = 0;

  /**
   * @param bus - Bus instance forwarded to BaseService.
   * @param warnings - Warnings to return from {@link checkHealth}.
   */
  public constructor(bus: IMakaioBus, warnings: ExtensionWarning[] = []) {
    super(bus);
    this.warnings = warnings;
  }

  protected async onInit(): Promise<void> {}
  protected async onDestroy(): Promise<void> {}

  /**
   * Returns the configured warnings and increments the call counter.
   * @returns Configured health warnings.
   */
  public checkHealth(): ExtensionWarning[] | Promise<ExtensionWarning[]> {
    this.checkHealthCallCount++;
    return this.warnings;
  }
}

/**
 * Create a minimal package fixture.
 * @param name - Package identifier.
 * @param options - Optional overrides.
 */
function makePackage(
  name: string,
  options: Partial<Omit<MakaioExtension, 'name' | 'displayName'>> = {},
): MakaioExtension {
  return { name, displayName: name, ...options };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Extension health warnings', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects warnings from checkHealth after startAll', async () => {
    let healthService: HealthService | undefined;

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('health-pkg', {
        create: (ctx) => {
          healthService = new HealthService(ctx.bus, [FIXTURE_WARNING]);
          return healthService;
        },
      }),
    ]);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      extensionName: 'health-pkg',
      warnings: [FIXTURE_WARNING],
    });

    await coordinator.shutdown();
  });

  it('emits warnings.changed after health check runs', async () => {
    const changedEvents: Array<{ extensionName: string; warnings: ExtensionWarning[] }> = [];

    bus.on(ExtensionSubjects.warnings.changed, (ctx) => {
      changedEvents.push({ extensionName: ctx.payload.extensionName, warnings: ctx.payload.warnings });
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('emitting-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [FIXTURE_WARNING]),
      }),
    ]);
    await coordinator.startAll();

    expect(changedEvents).toHaveLength(1);
    expect(changedEvents[0]).toMatchObject({
      extensionName: 'emitting-pkg',
      warnings: [FIXTURE_WARNING],
    });

    await coordinator.shutdown();
  });

  it('returns empty entries for packages without checkHealth', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('no-health-pkg', {
        // HealthService with an empty warning list has checkHealth — use a
        // plain service without it to exercise the no-checkHealth branch.
        create: () => ({
          init: async () => {},
          destroy: async () => {},
        }),
      }),
    ]);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(result.entries).toHaveLength(0);

    await coordinator.shutdown();
  });

  it('clears warnings when a package is disabled', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('clearable-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [FIXTURE_WARNING]),
      }),
    ]);
    await coordinator.startAll();

    // Confirm warnings are present after boot
    const before = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(before.entries).toHaveLength(1);

    // Disable the package
    await bus.request(ExtensionSubjects.setEnabled, { name: 'clearable-pkg', enabled: false });

    // Warnings should now be cleared
    const after = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(after.entries).toHaveLength(0);

    await coordinator.shutdown();
  });

  it('emits warnings.changed with empty array when a package is disabled', async () => {
    const changedEvents: Array<{ extensionName: string; warnings: ExtensionWarning[] }> = [];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('disable-emitting-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [FIXTURE_WARNING]),
      }),
    ]);
    await coordinator.startAll();

    // Clear boot events, then subscribe for disable event
    bus.on(ExtensionSubjects.warnings.changed, (ctx) => {
      changedEvents.push({ extensionName: ctx.payload.extensionName, warnings: ctx.payload.warnings });
    });

    await bus.request(ExtensionSubjects.setEnabled, { name: 'disable-emitting-pkg', enabled: false });

    expect(changedEvents).toHaveLength(1);
    expect(changedEvents[0]).toMatchObject({
      extensionName: 'disable-emitting-pkg',
      warnings: [],
    });

    await coordinator.shutdown();
  });

  it('runs checkHealth again after enablePackage', async () => {
    // Each call to `create` produces a HealthService with a call-specific
    // warning title so the re-enable assertion can prove checkHealth ran on the
    // second instance, not that stale warnings survived the disable/enable cycle.
    let createCallCount = 0;

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('re-enable-pkg', {
        create: (ctx) => {
          createCallCount++;
          const warning: ExtensionWarning = {
            severity: 'recommended',
            title: `Warning from call ${createCallCount}`,
            message: 'Health check ran.',
          };
          return new HealthService(ctx.bus, [warning]);
        },
      }),
    ]);
    await coordinator.startAll();

    // First create call happened; first checkHealth run produced call-1 warning
    expect(createCallCount).toBe(1);
    const before = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(before.entries[0]?.warnings[0]?.title).toBe('Warning from call 1');

    // Disable clears warnings; re-enable must call create again and run checkHealth
    await bus.request(ExtensionSubjects.setEnabled, { name: 're-enable-pkg', enabled: false });
    await bus.request(ExtensionSubjects.setEnabled, { name: 're-enable-pkg', enabled: true });

    // The result must carry the second instance's specific warning, proving
    // checkHealth ran on the freshly created service and not on stale state.
    expect(createCallCount).toBe(2);
    const result = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.warnings[0]?.title).toBe('Warning from call 2');

    await coordinator.shutdown();
  });

  it('warnings.list filters by extensionName when provided', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('alpha-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [FIXTURE_WARNING]),
      }),
      makePackage('beta-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [FIXTURE_WARNING]),
      }),
    ]);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.warnings.list, { extensionName: 'alpha-pkg' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.extensionName).toBe('alpha-pkg');

    await coordinator.shutdown();
  });

  it('does not crash boot when checkHealth throws', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('throwing-health-pkg', {
        create: (ctx) => {
          const svc = new HealthService(ctx.bus, []);
          // Override checkHealth to throw
          svc.checkHealth = () => {
            throw new Error('health check exploded');
          };
          return svc;
        },
      }),
    ]);

    // Must not throw
    await expect(coordinator.startAll()).resolves.toBeUndefined();

    const info = coordinator.list().find((e) => e.name === 'throwing-health-pkg');
    expect(info?.state).toBe('active');

    // Warnings default to empty on checkHealth error
    const result = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(result.entries).toHaveLength(0);

    await coordinator.shutdown();
  });

  it('treats malformed checkHealth return value as empty and logs an error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('malformed-health-pkg', {
        create: (ctx) => {
          const svc = new HealthService(ctx.bus, []);
          // Return data that does not conform to ExtensionWarning[] — intentional type lie via JSON roundtrip
          const malformed = JSON.parse('[{"bad":"data"}]') as ReturnType<typeof svc.checkHealth>;
          svc.checkHealth = () => malformed;
          return svc;
        },
      }),
    ]);

    await coordinator.startAll();

    // Malformed payload must be discarded — warnings list stays empty
    const result = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(result.entries).toHaveLength(0);

    // A console.error must have been logged for the parse failure
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ExtensionCoordinator]'), expect.anything());

    await coordinator.shutdown();
  });

  it('handles async checkHealth returning a Promise', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('async-health-pkg', {
        create: (ctx) => {
          const svc = new HealthService(ctx.bus, []);
          // Override to return a Promise so the async branch is exercised
          svc.checkHealth = async (): Promise<ExtensionWarning[]> => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            return [FIXTURE_WARNING];
          };
          return svc;
        },
      }),
    ]);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      extensionName: 'async-health-pkg',
      warnings: [FIXTURE_WARNING],
    });

    await coordinator.shutdown();
  });

  it('collects all warnings when checkHealth returns multiple entries with different severities', async () => {
    const multiWarnings: ExtensionWarning[] = [
      { severity: 'info', title: 'Info title', message: 'Informational.' },
      { severity: 'recommended', title: 'Recommended title', message: 'A recommendation.' },
      { severity: 'degraded', title: 'Degraded title', message: 'Something is broken.' },
      { severity: 'info', title: 'Another info', message: 'Another note.' },
    ];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('multi-warning-pkg', {
        create: (ctx) => new HealthService(ctx.bus, multiWarnings),
      }),
    ]);
    await coordinator.startAll();

    const result = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.extensionName).toBe('multi-warning-pkg');
    expect(entry?.warnings).toHaveLength(4);
    expect(entry?.warnings).toEqual(multiWarnings);

    await coordinator.shutdown();
  });

  it('deregisters warnings.list RPC handler after shutdown', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.load([
      makePackage('shutdown-pkg', {
        create: (ctx) => new HealthService(ctx.bus, [FIXTURE_WARNING]),
      }),
    ]);
    await coordinator.startAll();

    // Confirm warnings are present before shutdown
    const before = await bus.request(ExtensionSubjects.warnings.list, {});
    expect(before.entries).toHaveLength(1);

    await coordinator.shutdown();

    // The RPC handler is deregistered on shutdown — the request must now reject
    await expect(bus.request(ExtensionSubjects.warnings.list, {})).rejects.toThrow();
  });
});
