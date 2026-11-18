import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { ExtensionInitOptions, ExtensionServiceLifecycle, NodeExtensionContext } from '@makaio/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { KernelMakaioExtension } from '../extension/types.js';

/** Host fields the coordinator needs to build the context of an extension with a service. */
const CTX_BASE: Omit<NodeExtensionContext, 'bus' | 'identity' | 'getService' | 'dataDir' | 'signal' | 'hasExtension'> =
  {
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    username: 'test',
    machineId: 'machine-1',
    tryImport: async () => null,
  };

/** What the services of {@link probe} observed, and how they are told to behave. */
interface Probe {
  /** Signals the `init` calls received, in order. */
  readonly initSignals: Array<AbortSignal | undefined>;
  /** Number of `destroy` calls. */
  destroyCalls: number;
  /** Whether an `init` that waits for its signal is running. */
  waiting: boolean;
  /** Makes every later `destroy` reject with this error. */
  failDestroyWith: Error | undefined;
  /** Makes later `init` calls reject with this error. */
  initFailure: Error | undefined;
  /** Makes later `init` calls wait for their signal and reject with its reason. */
  waitInInit: boolean;
}

/**
 * Build an extension whose services record how they are initialised and destroyed.
 * @param observed - Receives the record the services write to and read their behaviour from.
 * @returns The extension.
 */
function probe(observed: Probe): KernelMakaioExtension {
  return {
    name: 'subject',
    displayName: 'subject',
    version: '0.1.0',
    create: (): ExtensionServiceLifecycle => ({
      init: (options?: ExtensionInitOptions) => {
        observed.initSignals.push(options?.signal);
        if (observed.initFailure) return Promise.reject(observed.initFailure);
        if (!observed.waitInInit) return Promise.resolve();
        observed.waiting = true;
        return new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
      destroy: () => {
        observed.destroyCalls += 1;
        if (observed.failDestroyWith) throw observed.failDestroyWith;
      },
    }),
  };
}

describe('ExtensionCoordinator cancelled init', () => {
  let bus: IMakaioBus;
  let observed: Probe;

  beforeEach(() => {
    bus = createBusInstance();
    observed = {
      initSignals: [],
      destroyCalls: 0,
      waiting: false,
      failDestroyWith: undefined,
      initFailure: undefined,
      waitInInit: false,
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  /**
   * Start the extension, then leave it disabled so that the test can re-enable it.
   * @returns The coordinator, running with the extension stopped.
   */
  async function stoppedCoordinator(): Promise<ExtensionCoordinator> {
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
    coordinator.load([probe(observed)]);
    await coordinator.startAll();
    await expect(coordinator.applyExtensionTransition('subject', false)).resolves.toBe('applied');
    observed.destroyCalls = 0;
    return coordinator;
  }

  describe('a re-enable that is in flight when the shutdown starts', () => {
    it('hands init the shutdown signal, cancels it promptly and destroys the service', async () => {
      const coordinator = await stoppedCoordinator();
      observed.waitInInit = true;

      const reEnabled = coordinator.applyExtensionTransition('subject', true);
      await vi.waitFor(() => expect(observed.waiting).toBe(true));
      const initSignal = observed.initSignals.at(-1);
      expect(initSignal).toBeDefined();
      expect(initSignal?.aborted).toBe(false);

      const shutdown = coordinator.shutdown();

      await expect(reEnabled).resolves.toBe('rejected');
      await expect(shutdown).resolves.toBeUndefined();
      expect(initSignal?.aborted).toBe(true);
      expect(observed.destroyCalls).toBe(1);
      expect(coordinator.stopBudgetMs()).toBe(0);
    });

    it('reports a failed destroy at the shutdown instead of dropping the service', async () => {
      const coordinator = await stoppedCoordinator();
      const destroyFailure = new Error('child would not die');
      observed.waitInInit = true;
      observed.failDestroyWith = destroyFailure;

      const reEnabled = coordinator.applyExtensionTransition('subject', true);
      await vi.waitFor(() => expect(observed.waiting).toBe(true));
      const shutdown = coordinator.shutdown();
      await reEnabled;

      const rejection = await shutdown.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(AggregateError);
      expect((rejection as AggregateError).errors).toEqual([destroyFailure]);
      // The re-enable's own destroy, then the shutdown's retry.
      expect(observed.destroyCalls).toBe(2);
    });
  });

  it('keeps the service of a failed re-enable whose destroy failed, refuses a second instance and reports it at the shutdown', async () => {
    const coordinator = await stoppedCoordinator();
    const destroyFailure = new Error('stuck');
    observed.initFailure = new Error('init failed');
    observed.failDestroyWith = destroyFailure;

    await expect(coordinator.applyExtensionTransition('subject', true)).resolves.toBe('rejected');
    observed.initFailure = undefined;
    await expect(coordinator.applyExtensionTransition('subject', true)).resolves.toBe('rejected');
    expect(coordinator.list().find((info) => info.name === 'subject')?.error).toContain('could not be destroyed');
    expect(observed.initSignals).toHaveLength(2);

    const rejection = await coordinator.shutdown().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([destroyFailure]);
  });

  describe('a start that the coordinator shutdown cancels', () => {
    it('cancels init without any boot signal, destroys the service and reports a failed destroy', async () => {
      const destroyFailure = new Error('child would not die');
      observed.waitInInit = true;
      observed.failDestroyWith = destroyFailure;
      const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
      coordinator.load([probe(observed)]);

      const started = coordinator.startAll();
      await vi.waitFor(() => expect(observed.waiting).toBe(true));
      const shutdown = coordinator.shutdown();
      await started.catch(() => undefined);

      expect(observed.initSignals.at(-1)?.aborted).toBe(true);
      const rejection = await shutdown.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(AggregateError);
      expect((rejection as AggregateError).errors).toEqual([destroyFailure]);
    });

    it('also ends when only the boot signal aborts', async () => {
      const controller = new AbortController();
      observed.waitInInit = true;
      const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
      coordinator.load([probe(observed)]);

      const started = coordinator.startAll({ signal: controller.signal });
      await vi.waitFor(() => expect(observed.waiting).toBe(true));
      const reason = new Error('stop requested');
      controller.abort(reason);

      await expect(started).rejects.toBe(reason);
      await expect(coordinator.shutdown()).resolves.toBeUndefined();
    });
  });

  it('retains the service of a failed, uncancelled start whose destroy failed, so the shutdown reports it', async () => {
    const destroyFailure = new Error('child would not die');
    observed.failDestroyWith = destroyFailure;
    const failing: KernelMakaioExtension = {
      ...probe(observed),
      create: () => ({
        init: () => Promise.reject(new Error('init failed')),
        destroy: () => {
          observed.destroyCalls += 1;
          throw destroyFailure;
        },
      }),
    };
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
    coordinator.load([failing]);

    await coordinator.startAll();
    expect(coordinator.list().find((info) => info.name === 'subject')?.state).toBe('failed');

    const rejection = await coordinator.shutdown().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([destroyFailure]);
    expect(observed.destroyCalls).toBe(2);
  });
});
