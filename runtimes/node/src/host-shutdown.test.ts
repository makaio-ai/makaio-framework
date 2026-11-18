import { writeSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { installHostShutdown, type HostShutdownStep } from './host-shutdown.js';

// `process.exit` is stubbed below, so the report of a stage that ran out of its
// window is observed as the synchronous stderr write that precedes it.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeSync: vi.fn(),
}));

/**
 * Build a stage.
 * @param name - Name of the stage.
 * @param run - What the stage does.
 * @param windowMs - Window of the stage; `null` leaves the stage to enforce its own limits.
 * @returns The stage.
 */
function step(name: string, run: HostShutdownStep['run'], windowMs: number | null = 1_000): HostShutdownStep {
  return { name, budgetMs: () => windowMs ?? undefined, run };
}

/**
 * Build a stage that never settles.
 * @param windowMs - Window of the stage.
 * @returns The stage.
 */
function hangingStep(windowMs = 20): HostShutdownStep {
  return step('hangs', () => new Promise<void>(() => undefined), windowMs);
}

describe('installHostShutdown', () => {
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(writeSync).mockClear();
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('runs the stages in order and leaves the process alone when every one finished', async () => {
    const order: string[] = [];
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('first', () => void order.push('first')), step('second', async () => void order.push('second'))],
    });

    await shutdown.request('test');

    expect(order).toEqual(['first', 'second']);
    expect(exit).not.toHaveBeenCalled();
  });

  it('gives every stage a window of its own, so slow stages do not add up against one deadline', async () => {
    const slow = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 60));
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('a', slow, 150), step('b', slow, 150), step('c', slow, 150)],
    });

    await shutdown.request('test');

    expect(exit).not.toHaveBeenCalled();
  });

  it('names a stage that does not settle inside its window, runs the stages after it and then exits', async () => {
    const order: string[] = [];
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [
        step('done', () => void order.push('done')),
        hangingStep(),
        step('later', () => void order.push('later')),
      ],
    });

    await shutdown.request('test');

    expect(order).toEqual(['done', 'later']);
    expect(writeSync).toHaveBeenCalledTimes(1);
    expect(writeSync).toHaveBeenCalledWith(
      2,
      '[test] Shutdown steps did not finish: hangs (did not settle within 20 ms). Exiting.\n',
    );
    expect(vi.mocked(writeSync).mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0] as number);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('reads the window of a stage when the stage is about to run, not when the shutdown is requested', async () => {
    let window: number | undefined;
    const lateWindow: HostShutdownStep = {
      name: 'late',
      budgetMs: () => window,
      run: () => new Promise<void>(() => undefined),
    };
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('learns', () => void (window = 20)), lateWindow],
    });

    await shutdown.request('test');

    expect(writeSync).toHaveBeenCalledWith(2, expect.stringContaining('late (did not settle within 20 ms)'));
  });

  it('keeps the first numeric window when a later read of it is undefined', async () => {
    // The guard read finds a number, the first reread of the wait finds none: the
    // number already read is the window, not a zero that ends the wait at once.
    const reads: Array<number | undefined> = [5_000, undefined];
    const stage: HostShutdownStep = {
      name: 'flaky window',
      budgetMs: () => reads.shift(),
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    };
    const shutdown = installHostShutdown({ label: 'test', signals: [], steps: [stage] });

    await shutdown.request('test');

    expect(writeSync).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('puts no window of its own on a stage that enforces its own limits', async () => {
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('self-bounded', () => new Promise<void>((resolve) => setTimeout(resolve, 80)), null)],
    });

    await shutdown.request('test');

    expect(exit).not.toHaveBeenCalled();
  });

  it('ends the host with status 1 once a failing stage has been followed by the rest', async () => {
    const order: string[] = [];
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [
        step('fails', () => {
          throw new Error('cannot release');
        }),
        step('after', () => void order.push('after')),
      ],
    });

    await shutdown.request('test');

    expect(order).toEqual(['after']);
    expect(process.exitCode).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    // Nothing ran out of its window, so there is no report of unfinished stages.
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('exits even when the report cannot be written', async () => {
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw new Error('EAGAIN');
    });
    const shutdown = installHostShutdown({ label: 'test', signals: [], steps: [hangingStep()] });

    await shutdown.request('test');

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('lets a request made from an abort listener join the shutdown instead of starting a second one', async () => {
    const ran: string[] = [];
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('only', () => void ran.push('only'))],
    });
    let joined: Promise<void> | undefined;
    let finishedInListener: Promise<void> | undefined;
    shutdown.cancellation.addEventListener('abort', () => {
      joined = shutdown.request('second');
      finishedInListener = shutdown.finished();
    });

    const first = shutdown.request('first');
    await first;

    expect(joined).toBe(first);
    expect(finishedInListener).toBe(first);
    expect(ran).toEqual(['only']);
  });

  it('does not report the teardown as finished to a listener that asks while the abort is dispatched', async () => {
    let release!: () => void;
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('slow', () => new Promise<void>((resolve) => (release = resolve)))],
    });
    let settledInListener = false;
    shutdown.cancellation.addEventListener('abort', () => {
      void shutdown.finished().then(() => (settledInListener = true));
    });

    const first = shutdown.request('first');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(settledInListener).toBe(false);
    release();
    await first;
  });

  it('rejects a signal that both stops the host and is ignored', () => {
    expect(() =>
      installHostShutdown({
        label: 'test',
        signals: ['SIGINT', 'SIGHUP'],
        ignoredSignals: ['SIGHUP'],
        steps: [],
      }),
    ).toThrow('SIGHUP cannot both stop the host and be ignored');
  });
});
