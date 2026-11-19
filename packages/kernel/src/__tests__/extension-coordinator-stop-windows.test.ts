import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { ExtensionDependency, ExtensionServiceLifecycle } from '@makaio/contracts';
import { OUTER_BOUND_HEADROOM_MS, outerBoundMs } from '@makaio/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCancellation } from '../cancellation.js';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import { DEFAULT_EXTENSION_STOP_BUDGET_MS } from '../extension/extension-shutdown-runner.js';
import type { ExtensionContextBase, KernelMakaioExtension } from '../extension/types.js';

/** Host fields the coordinator needs to build the context of an extension with a service. */
const CTX_BASE: ExtensionContextBase = {
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async () => null,
};

/**
 * Build an extension whose service does what the test needs on `destroy()`.
 * @param name - Extension name.
 * @param service - Service members besides the lifecycle `init`, which does nothing.
 * @param dependsOn - Name of the extension this one starts after.
 * @returns The extension.
 */
function extension(
  name: string,
  service: Pick<ExtensionServiceLifecycle, 'destroy' | 'stopBudgetMs'>,
  dependsOn?: string,
): KernelMakaioExtension {
  const dependencies: ExtensionDependency[] =
    dependsOn === undefined ? [] : [{ type: 'extension', name: dependsOn, version: '>=0.1.0' }];
  return { name, displayName: name, version: '0.1.0', dependencies, create: () => service };
}

describe('ExtensionCoordinator stop windows', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('names an extension that never settles, goes on with the extensions before it and reports it once all are handled', async () => {
    const stopped: string[] = [];
    let release: () => void = () => undefined;
    const stuckUntilReleased = (): Promise<void> => new Promise<void>((resolve) => (release = resolve));
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE, defaultStopBudgetMs: 40 });
    coordinator.load([
      extension('first', { destroy: () => void stopped.push('first') }),
      extension('stuck', { destroy: stuckUntilReleased }, 'first'),
      extension('last', { destroy: () => void stopped.push('last') }, 'stuck'),
    ]);
    await coordinator.startAll();

    const rejection = await coordinator.shutdown().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Reverse dependency order: `last` stops, `stuck` runs out of its window, `first` still stops.
    expect(stopped).toEqual(['last', 'first']);
    expect(rejection).toBeInstanceOf(AggregateError);
    const enforced = outerBoundMs(40);
    expect((rejection as AggregateError).message).toContain(`stuck (not stopped within ${enforced} ms)`);
    expect((rejection as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      `Extension "stuck" did not finish stopping within ${enforced} ms; continuing with the next one`,
    ]);
    // Its stop has not finished, so it is not published as stopped; it is once the stop settles.
    expect(coordinator.list().find((info) => info.name === 'stuck')?.state).toBe('active');
    expect(coordinator.list().find((info) => info.name === 'first')?.state).toBe('stopped');
    release();
    await vi.waitFor(() => expect(coordinator.list().find((info) => info.name === 'stuck')?.state).toBe('stopped'));
  });

  it('gives each extension the window its service declares, not the default', async () => {
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE, defaultStopBudgetMs: 30 });
    coordinator.load([
      extension('slow', {
        stopBudgetMs: 400,
        destroy: () => new Promise<void>((resolve) => setTimeout(resolve, 120)),
      }),
    ]);
    await coordinator.startAll();

    await expect(coordinator.shutdown()).resolves.toBeUndefined();
  });

  it('adds up the windows of the extensions that hold something to stop', async () => {
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE, defaultStopBudgetMs: 1_000 });
    coordinator.load([
      extension('declares', { stopBudgetMs: 250, destroy: () => undefined }),
      extension('defaults', { destroy: () => undefined }),
      // An extension whose start failed holds nothing.
      {
        name: 'failed',
        displayName: 'failed',
        version: '0.1.0',
        create: () => {
          throw new Error('cannot start');
        },
      },
    ]);
    expect(coordinator.stopBudgetMs()).toBe(0);

    await coordinator.startAll();

    expect(coordinator.stopBudgetMs()).toBe(outerBoundMs(250) + outerBoundMs(1_000));
    await coordinator.shutdown();
  });

  it('takes the documented default window when neither the host nor the service gives one', async () => {
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
    coordinator.load([extension('plain', { destroy: () => undefined })]);
    await coordinator.startAll();

    expect(coordinator.stopBudgetMs()).toBe(outerBoundMs(DEFAULT_EXTENSION_STOP_BUDGET_MS));
    await coordinator.shutdown();
  });

  it('does not report an extension that uses its whole declared window as not stopped', async () => {
    // Its own timer is armed after the coordinator's, so a coordinator window of exactly
    // the declared length would close first.
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
    coordinator.load([
      extension('uses-all', {
        stopBudgetMs: 60,
        destroy: () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
      }),
    ]);
    await coordinator.startAll();

    await expect(coordinator.shutdown()).resolves.toBeUndefined();
  });

  it('refuses a default stop window that is negative, infinite or NaN', () => {
    for (const defaultStopBudgetMs of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE, defaultStopBudgetMs })).toThrow(
        RangeError,
      );
    }
  });

  it('fails the start of an extension whose service declares an invalid stop window, and stops it', async () => {
    const destroyed: string[] = [];
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
    coordinator.load([
      extension('bad', { stopBudgetMs: Number.NaN, destroy: () => void destroyed.push('bad') }),
      extension('negative', { stopBudgetMs: -5, destroy: () => void destroyed.push('negative') }),
    ]);

    await coordinator.startAll();

    const states = Object.fromEntries(coordinator.list().map((info) => [info.name, info.state]));
    expect(states).toEqual({ bad: 'failed', negative: 'failed' });
    expect(coordinator.list().find((info) => info.name === 'bad')?.error).toContain(
      'Extension "bad" stopBudgetMs must be a non-negative finite number',
    );
    expect(destroyed).toEqual(['bad', 'negative']);
    expect(coordinator.stopBudgetMs()).toBe(0);
  });

  it('stops a retained service whose invalid stop window was refused within the default window', async () => {
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE, defaultStopBudgetMs: 1_000 });
    const destroy = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    coordinator.load([extension('bad', { stopBudgetMs: Number.NaN, destroy })]);

    // The start is refused, and the cleanup of the refused service fails: it stays owned.
    await coordinator.startAll();
    expect(coordinator.list().find((info) => info.name === 'bad')?.state).toBe('failed');

    const budget = coordinator.stopBudgetMs();
    expect(budget).toBe(outerBoundMs(1_000));
    await expect(coordinator.shutdown()).rejects.toBeInstanceOf(AggregateError);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  describe('a start that the host cancels', () => {
    let initRunning = false;
    beforeEach(() => {
      initRunning = false;
    });

    /**
     * Build an extension whose `init` waits for the cancellation and then fails.
     * @param destroy - What destroying the service does.
     * @param stopBudgetMs - Window the service declares.
     * @returns The extension.
     */
    function cancellable(destroy: () => void, stopBudgetMs?: number): KernelMakaioExtension {
      return extension('cancellable', {
        stopBudgetMs,
        destroy,
        init: (options?: { signal?: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            initRunning = true;
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          }),
      } as Pick<ExtensionServiceLifecycle, 'destroy' | 'stopBudgetMs'>);
    }

    it('rejects with the reason alone when releasing what it started was clean', async () => {
      const controller = new AbortController();
      const reason = new Error('stop requested');
      const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
      coordinator.load([cancellable(() => undefined)]);

      const started = coordinator.startAll({ signal: controller.signal });
      await vi.waitFor(() => expect(initRunning).toBe(true));
      controller.abort(reason);

      await expect(started).rejects.toBe(reason);
    });

    it('does not hide a failed service cleanup behind the cancellation reason', async () => {
      const controller = new AbortController();
      const reason = new Error('stop requested');
      const destroyFailure = new Error('child would not die');
      const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
      coordinator.load([
        cancellable(() => {
          throw destroyFailure;
        }),
      ]);

      const started = coordinator.startAll({ signal: controller.signal });
      await vi.waitFor(() => expect(initRunning).toBe(true));
      controller.abort(reason);

      const rejection = await started.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(AggregateError);
      expect((rejection as AggregateError).errors).toEqual([destroyFailure]);
      expect((rejection as AggregateError).cause).toBe(reason);
      // The one reading of a cancellation sees the failures it carries.
      expect(readCancellation(rejection, controller.signal)).toEqual([destroyFailure]);
      expect(readCancellation(reason, controller.signal)).toEqual([]);
      expect(readCancellation(new Error('other'), controller.signal)).toBeUndefined();
    });

    it('counts the destroy window of a service whose init is still running', async () => {
      const controller = new AbortController();
      const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CTX_BASE });
      coordinator.load([cancellable(() => undefined, 7_000)]);

      const started = coordinator.startAll({ signal: controller.signal });
      await vi.waitFor(() => expect(coordinator.stopBudgetMs()).toBe(outerBoundMs(7_000)));

      controller.abort(new Error('stop requested'));
      await started.catch(() => undefined);
      // The failed start released it: nothing is left to stop.
      expect(coordinator.stopBudgetMs()).toBe(0);
      expect(OUTER_BOUND_HEADROOM_MS).toBeGreaterThan(0);
    });
  });
});
