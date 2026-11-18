import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancellationRejection } from '@makaio/kernel';
import { outerBoundMs } from '@makaio/utils';
import { installHostShutdown } from './host-shutdown.js';
import { resourceStepStopBudgetMs } from './runtime-stop-budget.js';
import {
  BOOT_FAILURE_SHUTDOWN_REASON,
  bootUnderShutdown,
  createRuntimeLifecycle,
  type LifecycleBootHooks,
  type LifecycleRuntime,
} from './runtime-lifecycle.js';

/** A runtime whose shutdown is observable. */
interface FakeRuntime extends LifecycleRuntime {
  readonly shutdownCalls: () => number;
}

/**
 * Build a runtime that has booted.
 * @param stopBudgetMs - Bound the runtime reports for its teardown.
 * @param shutdown - What its teardown does.
 * @returns The runtime.
 */
function runtime(stopBudgetMs: number, shutdown: () => Promise<void> = async () => undefined): FakeRuntime {
  let calls = 0;
  return {
    stopBudgetMs: () => stopBudgetMs,
    shutdown: async () => {
      calls += 1;
      await shutdown();
    },
    shutdownCalls: () => calls,
  };
}

/**
 * A boot that waits until it is cancelled and then rolls back like the real one:
 * it rejects with the cancellation reason, or with the aggregate of its failed rollback.
 * @param hooks - Hooks the lifecycle hands the boot.
 * @param cancellationBudgetMs - Bound the boot reports.
 * @param rollbackFailure - Failure of the rollback, if any.
 * @returns A boot that never succeeds.
 */
async function cancelledBoot(
  hooks: LifecycleBootHooks,
  cancellationBudgetMs: number,
  rollbackFailure?: Error,
): Promise<FakeRuntime> {
  hooks.onCancellationBudget(() => cancellationBudgetMs);
  await new Promise<void>((resolve) => hooks.signal.addEventListener('abort', () => resolve(), { once: true }));
  throw cancellationRejection(
    hooks.signal.reason,
    rollbackFailure === undefined ? [] : [rollbackFailure],
    'rollback failed',
  );
}

describe('createRuntimeLifecycle', () => {
  it('has nothing to stop before a boot, and a boot that starts afterwards is already cancelled', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();

    await lifecycle.stop('early');

    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.stopBudgetMs()).toBeUndefined();
    let seenAborted: boolean | undefined;
    await lifecycle.boot(async (hooks) => {
      seenAborted = hooks.signal.aborted;
      return runtime(10);
    });
    expect(seenAborted).toBe(true);
  });

  it('cancels a boot in flight, awaits its rollback and reports the boot bound as the stop budget', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const booting = lifecycle.boot((hooks) => cancelledBoot(hooks, 7_000));
    const outcome = booting.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(lifecycle.stopBudgetMs()).toBe(7_000);

    await lifecycle.stop('SIGTERM');

    expect(lifecycle.signal.aborted).toBe(true);
    expect(String(lifecycle.signal.reason)).toContain('SIGTERM');
    // The boot rejected with exactly the cancellation reason, so its owner reads a clean stop.
    await expect(outcome).resolves.toBe(lifecycle.signal.reason);
    expect(lifecycle.stopBudgetMs()).toBeUndefined();
  });

  it('shuts a booted runtime down and reports its own stop budget', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const booted = runtime(9_000);
    await lifecycle.boot(async () => booted);

    expect(lifecycle.runtime).toBe(booted);
    expect(lifecycle.stopBudgetMs()).toBe(9_000);
    await lifecycle.stop('SIGINT');

    expect(booted.shutdownCalls()).toBe(1);
  });

  it('joins repeated stops into one shutdown', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const booted = runtime(1_000);
    await lifecycle.boot(async () => booted);

    const first = lifecycle.stop('SIGINT');
    const second = lifecycle.stop('SIGTERM');

    expect(second).toBe(first);
    await first;
    expect(booted.shutdownCalls()).toBe(1);
  });

  it('joins a stop requested by a listener of the lifecycle signal while the first stop aborts it', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const booted = runtime(1_000);
    await lifecycle.boot(async () => booted);
    let fromListener: Promise<void> | undefined;
    lifecycle.signal.addEventListener('abort', () => {
      fromListener = lifecycle.stop('listener');
    });

    const first = lifecycle.stop('SIGINT');
    await Promise.all([first, fromListener]);

    expect(fromListener).toBe(first);
    expect(booted.shutdownCalls()).toBe(1);
  });

  it('starts a new attempt after a shutdown that failed, and joins one that is in flight', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    let attempts = 0;
    const booted = runtime(1_000, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('could not release');
    });
    await lifecycle.boot(async () => booted);

    await expect(lifecycle.stop('first')).rejects.toThrow('could not release');
    const retry = lifecycle.stop('again');
    expect(lifecycle.stop('joined')).toBe(retry);
    await retry;

    expect(attempts).toBe(2);
  });

  it('shuts down a runtime whose boot finished before it saw the stop request', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const booted = runtime(1_000);
    let finishBoot!: () => void;
    const booting = lifecycle.boot(
      () =>
        new Promise<FakeRuntime>((resolve) => {
          finishBoot = () => resolve(booted);
        }),
    );

    const stopping = lifecycle.stop('SIGTERM');
    finishBoot();
    await booting;
    await stopping;

    expect(booted.shutdownCalls()).toBe(1);
  });

  it('rejects the stop with the rollback failures when the cancelled boot could not roll back', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const booting = lifecycle.boot((hooks) => cancelledBoot(hooks, 1_000, new Error('child would not stop')));
    booting.catch(() => undefined);

    const stopped = lifecycle.stop('SIGTERM');

    await expect(stopped).rejects.toMatchObject({ errors: [new Error('child would not stop')] });
  });

  it('does not report a boot that failed on its own as a failure of the stop', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const booting = lifecycle.boot(async () => {
      throw new Error('extension failed to start');
    });
    await expect(booting).rejects.toThrow('extension failed to start');

    await expect(lifecycle.stop('boot failure')).resolves.toBeUndefined();
    expect(lifecycle.stopBudgetMs()).toBeUndefined();
  });

  it('cancels the boot when the external cancellation aborts, with that reason', async () => {
    const external = new AbortController();
    const lifecycle = createRuntimeLifecycle<FakeRuntime>({ cancellation: external.signal });
    const booting = lifecycle.boot((hooks) => cancelledBoot(hooks, 1_000));

    external.abort('SIGINT');

    await expect(booting).rejects.toBe('SIGINT');
    expect(lifecycle.signal.reason).toBe('SIGINT');
  });

  it('refuses a second boot', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    await lifecycle.boot(async () => runtime(1));

    expect(() => lifecycle.boot(async () => runtime(1))).toThrow('already booted');
  });

  it('builds a teardown stage whose window is the stop budget plus the outer-bound headroom, and a finite default before one is known', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const step = lifecycle.shutdownStep('runtime');
    // No bound is known yet: the stage is bounded by one bounded stop, never left without a window.
    expect(step.budgetMs()).toBe(outerBoundMs(resourceStepStopBudgetMs()));

    const booted = runtime(4_000);
    await lifecycle.boot(async () => booted);

    expect(step.budgetMs()).toBe(outerBoundMs(4_000));
    await step.run();
    expect(booted.shutdownCalls()).toBe(1);
  });
});

describe('bootUnderShutdown', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('returns the runtime of a boot that succeeded', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const shutdown = installHostShutdown({ label: 't', signals: [], steps: [lifecycle.shutdownStep()] });
    const booted = runtime(1);

    await expect(bootUnderShutdown(lifecycle, shutdown, async () => booted)).resolves.toBe(booted);
    shutdown.release();
  });

  it('ends quietly, after the shutdown has finished, when a stop request interrupted the boot', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const order: string[] = [];
    const shutdown = installHostShutdown({
      label: 't',
      signals: [],
      steps: [lifecycle.shutdownStep(), { name: 'after', budgetMs: () => 1_000, run: () => void order.push('after') }],
    });
    const booting = bootUnderShutdown(lifecycle, shutdown, (hooks) => cancelledBoot(hooks, 1_000));

    void shutdown.request('SIGTERM');

    await expect(booting).resolves.toBeUndefined();
    expect(order).toEqual(['after']);
  });

  it('tears the finished runtime down when the boot completed before it saw the stop request', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const shutdown = installHostShutdown({ label: 't', signals: [], steps: [lifecycle.shutdownStep()] });
    const booted = runtime(1);
    let finishBoot!: () => void;
    const booting = bootUnderShutdown(
      lifecycle,
      shutdown,
      () => new Promise<FakeRuntime>((resolve) => (finishBoot = () => resolve(booted))),
    );

    void shutdown.request('SIGTERM');
    finishBoot();

    await expect(booting).resolves.toBeUndefined();
    expect(booted.shutdownCalls()).toBe(1);
  });

  it('requests the shutdown itself for a boot that failed, and rethrows the failure once it has finished', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const reasons: string[] = [];
    const shutdown = installHostShutdown({
      label: 't',
      signals: [],
      steps: [lifecycle.shutdownStep()],
      onRequest: (reason) => reasons.push(reason),
    });

    await expect(
      bootUnderShutdown(lifecycle, shutdown, async () => {
        throw new Error('boot broke');
      }),
    ).rejects.toThrow('boot broke');

    expect(reasons).toEqual([BOOT_FAILURE_SHUTDOWN_REASON]);
  });

  it('requests the host teardown when the external cancellation source interrupted the boot', async () => {
    const external = new AbortController();
    const lifecycle = createRuntimeLifecycle<FakeRuntime>({ cancellation: external.signal });
    const reasons: string[] = [];
    const order: string[] = [];
    const shutdown = installHostShutdown({
      label: 't',
      signals: [],
      steps: [
        lifecycle.shutdownStep(),
        { name: 'server', budgetMs: () => 1_000, run: () => void order.push('server') },
      ],
      onRequest: (reason) => reasons.push(reason),
    });
    const booting = bootUnderShutdown(lifecycle, shutdown, (hooks) => cancelledBoot(hooks, 1_000));

    external.abort('SIGINT');

    await expect(booting).resolves.toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(order).toEqual(['server']);
  });

  it('requests the host teardown when the external cancellation source aborted a boot that had completed', async () => {
    const external = new AbortController();
    const lifecycle = createRuntimeLifecycle<FakeRuntime>({ cancellation: external.signal });
    const order: string[] = [];
    const shutdown = installHostShutdown({
      label: 't',
      signals: [],
      steps: [
        lifecycle.shutdownStep(),
        { name: 'server', budgetMs: () => 1_000, run: () => void order.push('server') },
      ],
    });
    const booted = runtime(1);
    let finishBoot!: () => void;
    const booting = bootUnderShutdown(
      lifecycle,
      shutdown,
      () => new Promise<FakeRuntime>((resolve) => (finishBoot = () => resolve(booted))),
    );

    external.abort('SIGINT');
    finishBoot();

    await expect(booting).resolves.toBeUndefined();
    expect(booted.shutdownCalls()).toBe(1);
    expect(order).toEqual(['server']);
  });

  it('joins the shutdown already in progress instead of requesting another one', async () => {
    const lifecycle = createRuntimeLifecycle<FakeRuntime>();
    const reasons: string[] = [];
    const shutdown = installHostShutdown({
      label: 't',
      signals: [],
      steps: [lifecycle.shutdownStep()],
      onRequest: (reason) => reasons.push(reason),
    });
    const booting = bootUnderShutdown(lifecycle, shutdown, (hooks) => cancelledBoot(hooks, 1_000));

    void shutdown.request('SIGTERM');

    await expect(booting).resolves.toBeUndefined();
    expect(reasons).toEqual(['SIGTERM']);
  });
});
