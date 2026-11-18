import { writeSync } from 'node:fs';
import { createBusInstance } from '@makaio/bus-core';
import {
  ExtensionCoordinator,
  runBoundedShutdownSteps,
  type BoundedShutdownStep,
  type KernelMakaioExtension,
} from '@makaio/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHostShutdown } from './host-shutdown.js';
import {
  bootCancellationBudgetMs,
  bootCheckpointGraceMs,
  extensionsStep,
  resourceStep,
  resourceStepStopBudgetMs,
} from './runtime-stop-budget.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeSync: vi.fn(),
}));

describe('the windows a runtime boot and its teardown run in', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the extensions step, the credential channel and the transport intact when an extension uses its whole window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closed: string[] = [];
    const windowMs = 80;
    const usesAll: KernelMakaioExtension = {
      name: 'uses-all',
      displayName: 'uses-all',
      version: '0.1.0',
      create: () => ({
        stopBudgetMs: windowMs,
        // Armed after the step's own timer: it takes exactly the declared window.
        destroy: () => new Promise<void>((resolve) => setTimeout(resolve, windowMs)),
      }),
    };
    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      extensionContextBase: {
        platform: 'linux',
        homedir: '/home/test',
        makaioHome: '/home/test/.makaio',
        username: 'test',
        machineId: 'machine-1',
        tryImport: async () => null,
      },
    });
    coordinator.load([usesAll]);
    await coordinator.startAll();

    // The order a boot registers them in, run in reverse.
    const failures = await runBoundedShutdownSteps([
      extensionsStep(coordinator),
      resourceStep('credentials channel', () => void closed.push('credentials')),
      resourceStep('bus transport', () => void closed.push('transport')),
    ]);

    expect(failures).toEqual([]);
    expect(closed).toEqual(['credentials', 'transport']);
    expect(coordinator.list().find((info) => info.name === 'uses-all')?.state).toBe('stopped');
  });

  describe('a host that waits for a cancelled boot', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      process.exitCode = undefined;
    });

    it('keeps waiting while the rollback of a resource the phase in flight registered is within its windows', async () => {
      const rollbackSteps: BoundedShutdownStep[] = [];
      const grace = bootCheckpointGraceMs();
      const closeMs = resourceStepStopBudgetMs() - 1_000;
      const closed: string[] = [];

      // A boot whose database open takes most of the grace, then registers the close of it and
      // reaches the checkpoint: the rollback needs a window that was not there when the host
      // armed its timer.
      const boot = (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, grace - 1_000));
        rollbackSteps.push(
          resourceStep('database', () =>
            new Promise<void>((resolve) => setTimeout(resolve, closeMs)).then(() => void closed.push('database')),
          ),
        );
        await runBoundedShutdownSteps([...rollbackSteps].reverse());
      })();

      const hostShutdown = installHostShutdown({
        label: 'test',
        signals: [],
        steps: [
          { name: 'runtime boot', budgetMs: () => bootCancellationBudgetMs(rollbackSteps) + 1_000, run: () => boot },
        ],
      });

      const finished = hostShutdown.request('SIGTERM');
      await vi.advanceTimersByTimeAsync(grace - 1_000 + closeMs + 10);
      await finished;

      expect(closed).toEqual(['database']);
      expect(process.exit).not.toHaveBeenCalled();
      expect(writeSync).not.toHaveBeenCalled();
    });

    it('still ends the host when the phase in flight never registers anything and never finishes', async () => {
      const hostShutdown = installHostShutdown({
        label: 'test',
        signals: [],
        steps: [
          {
            name: 'runtime boot',
            budgetMs: () => bootCancellationBudgetMs([]),
            run: () => new Promise<void>(() => undefined),
          },
        ],
      });

      const finished = hostShutdown.request('SIGTERM');
      await vi.advanceTimersByTimeAsync(bootCheckpointGraceMs() + 10);
      await finished;

      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
