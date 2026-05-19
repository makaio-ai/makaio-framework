import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { NodeExtensionContext as ExtensionContext } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { KernelMakaioExtension as MakaioExtension } from '../extension/types.js';
import { KernelSubjects } from '../namespace/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal {@link BaseService} subclass that does nothing — used when a
 * package only needs to register bus handlers during `create()` rather than
 * during `onInit()`.
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
 * Minimal package factory for test use.
 * @param name - Package identifier.
 * @param options - Optional overrides for the package manifest.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lifecycle broadcast subjects', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  // 1. coordinatorReady invokes a registered handler
  it('coordinatorReady broadcast invokes a handler registered during create()', async () => {
    const handler = mock((ctx) => {
      ctx.setResult({});
    });

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('pkg-coordinator', {
        create: (ctx) => {
          ctx.bus.on(KernelSubjects.phase.coordinatorReady, handler);
          return new NoopService(ctx.bus);
        },
      }),
    ]);

    await coordinator.startAll();

    const results = await bus.broadcast(KernelSubjects.phase.coordinatorReady, {
      machineId: 'machine-1',
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]?.payload).toMatchObject({
      machineId: 'machine-1',
    });
    expect(results).toHaveLength(1);
  });

  // 2. Multiple handlers on the same broadcast all execute
  it('all handlers on coordinatorReady execute when two packages register', async () => {
    const handlerA = mock((ctx) => ctx.setResult({}));
    const handlerB = mock((ctx) => ctx.setResult({}));

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('pkg-a', {
        create: (ctx) => {
          ctx.bus.on(KernelSubjects.phase.coordinatorReady, handlerA);
          return new NoopService(ctx.bus);
        },
      }),
      makePackage('pkg-b', {
        create: (ctx) => {
          ctx.bus.on(KernelSubjects.phase.coordinatorReady, handlerB);
          return new NoopService(ctx.bus);
        },
      }),
    ]);

    await coordinator.startAll();

    const results = await bus.broadcast(KernelSubjects.phase.coordinatorReady, {
      machineId: 'machine-1',
    });

    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
  });

  // 3. Broadcast with zero handlers resolves to empty array
  it('broadcast with no registered handlers resolves to an empty array', async () => {
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([makePackage('pkg-silent')]);
    await coordinator.startAll();

    const results = await bus.broadcast(KernelSubjects.phase.coordinatorReady, {
      machineId: 'machine-1',
    });

    expect(results).toEqual([]);
  });

  // 4. Handler registered in create() is present before the broadcast fires
  it('handler registered during create() is in the map before broadcast fires', async () => {
    const registrationOrder: string[] = [];

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });

    coordinator.load([
      makePackage('pkg-timing', {
        create: (ctx) => {
          // Record registration during create()
          registrationOrder.push('registered');
          ctx.bus.on(KernelSubjects.phase.coordinatorReady, (hCtx) => {
            registrationOrder.push('invoked');
            hCtx.setResult({});
          });
          return new NoopService(ctx.bus);
        },
      }),
    ]);

    // startAll() calls create() for all packages — handler is registered here
    await coordinator.startAll();
    registrationOrder.push('startAll-done');

    // broadcast() fires after startAll() — handler must already be present
    await bus.broadcast(KernelSubjects.phase.coordinatorReady, {
      machineId: 'machine-1',
    });

    expect(registrationOrder).toEqual(['registered', 'startAll-done', 'invoked']);
  });
});
