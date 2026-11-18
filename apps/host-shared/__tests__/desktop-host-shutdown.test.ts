import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cancellationRejection } from '@makaio/kernel';
import { createRuntimeLifecycle, type HostShutdownStep, type LifecycleRuntime } from '@makaio/runtime-node';
import { cleanupsStep, installDesktopHostShutdown } from '../src/desktop-host-shutdown.js';

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Build a teardown stage that records its run.
 * @param name - Stage name.
 * @param order - Where the run is recorded.
 * @returns The stage.
 */
function recorded(name: string, order: string[]): HostShutdownStep {
  return { name, budgetMs: () => 1_000, run: () => void order.push(name) };
}

/**
 * Build a runtime that records its shutdown.
 * @param order - Where the shutdown is recorded.
 * @returns The runtime.
 */
function runtimeRecording(order: string[]): LifecycleRuntime {
  return { stopBudgetMs: () => 1_000, shutdown: async () => void order.push('runtime') };
}

describe('installDesktopHostShutdown', () => {
  let exitProcess: MockInstance<typeof process.exit>;
  const baseline = Object.fromEntries(STOP_SIGNALS.map((signal) => [signal, process.listenerCount(signal)]));

  beforeEach(() => {
    exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it.each(STOP_SIGNALS)('stops on %s: stages around the runtime in order, then ends the host once', async (signal) => {
    const order: string[] = [];
    const lifecycle = createRuntimeLifecycle<LifecycleRuntime>();
    await lifecycle.boot(async () => runtimeRecording(order));
    const exit = vi.fn(() => void order.push('exit'));
    const shutdown = installDesktopHostShutdown({
      label: 'test',
      lifecycle,
      beforeRuntime: [recorded('before', order)],
      afterRuntime: [recorded('after', order)],
      exit,
    });

    process.emit(signal);
    await shutdown.finished();
    await Promise.resolve();

    expect(order).toEqual(['before', 'runtime', 'after', 'exit']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
    for (const stopSignal of STOP_SIGNALS) {
      expect(process.listenerCount(stopSignal)).toBe(baseline[stopSignal]);
    }
  });

  it('cancels a boot a quit interrupts, awaits its rollback and still runs the stages after the runtime', async () => {
    const order: string[] = [];
    const lifecycle = createRuntimeLifecycle<LifecycleRuntime>();
    const booting = lifecycle.boot(async (hooks) => {
      hooks.onCancellationBudget(() => 1_000);
      await new Promise<void>((resolve) => hooks.signal.addEventListener('abort', () => resolve(), { once: true }));
      order.push('rollback');
      throw cancellationRejection(hooks.signal.reason, [], 'rollback failed');
    });
    const outcome = booting.then(
      () => undefined,
      (error: unknown) => error,
    );
    const exit = vi.fn();
    const shutdown = installDesktopHostShutdown({
      label: 'test',
      lifecycle,
      afterRuntime: [recorded('after', order)],
      exit,
    });

    // A host trigger (Electron's before-quit, a tray item) requests the shutdown the same way a signal does.
    await shutdown.request('before-quit');
    await Promise.resolve();

    expect(order).toEqual(['rollback', 'after']);
    await expect(outcome).resolves.toBe(lifecycle.signal.reason);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps joining signals while the teardown runs, and ends the host only once', async () => {
    let finish!: () => void;
    const lifecycle = createRuntimeLifecycle<LifecycleRuntime>();
    const exit = vi.fn();
    const slow: HostShutdownStep = {
      name: 'slow',
      budgetMs: () => 5_000,
      run: () => new Promise<void>((resolve) => (finish = resolve)),
    };
    const shutdown = installDesktopHostShutdown({ label: 'test', lifecycle, beforeRuntime: [slow], exit });

    process.emit('SIGTERM');
    await Promise.resolve();
    process.emit('SIGTERM');
    process.emit('SIGINT');
    process.emit('SIGHUP');
    void shutdown.request('before-quit');

    expect(exit).not.toHaveBeenCalled();
    for (const signal of STOP_SIGNALS) expect(process.listenerCount(signal)).toBe(baseline[signal] + 1);
    finish();
    await shutdown.finished();
    await Promise.resolve();

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('ends the process with status 1 instead of calling exit when a stage failed', async () => {
    const lifecycle = createRuntimeLifecycle<LifecycleRuntime>();
    const exit = vi.fn();
    const failing: HostShutdownStep = {
      name: 'fails',
      budgetMs: () => 1_000,
      run: () => {
        throw new Error('cannot release');
      },
    };
    const shutdown = installDesktopHostShutdown({ label: 'test', lifecycle, afterRuntime: [failing], exit });

    await shutdown.request('before-quit');
    await Promise.resolve();

    expect(exitProcess).toHaveBeenCalledWith(1);
  });
});

describe('cleanupsStep', () => {
  it('gives every cleanup its turn and reports all failures afterwards', async () => {
    const ran: string[] = [];
    const cleanups: Array<() => void | Promise<void>> = [
      () => {
        ran.push('first');
        throw new Error('first failed');
      },
      async () => void ran.push('second'),
    ];
    const step = cleanupsStep(
      'bus handlers',
      () => 1_000,
      () => cleanups,
    );

    await expect(step.run()).rejects.toMatchObject({ errors: [new Error('first failed')] });
    expect(ran).toEqual(['first', 'second']);
  });

  it('reads the cleanups when it runs, so later registrations are included', async () => {
    const cleanups: Array<() => void> = [];
    const step = cleanupsStep(
      'bus handlers',
      () => 1_000,
      () => cleanups,
    );
    const ran: string[] = [];
    cleanups.push(() => void ran.push('late'));

    await step.run();

    expect(ran).toEqual(['late']);
  });
});
