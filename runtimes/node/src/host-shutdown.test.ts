import { writeSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { installHostShutdown, type HostShutdown, type HostShutdownStep } from './host-shutdown.js';

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
 * @param windowMs - Window of the stage.
 * @returns The stage.
 */
function step(name: string, run: HostShutdownStep['run'], windowMs = 1_000): HostShutdownStep {
  return { name, budgetMs: () => windowMs, run };
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
    let window = 1_000;
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

  it('hands the reason of the first request to onRequest before the cancellation aborts and before a stage runs', async () => {
    const order: string[] = [];
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('only', () => void order.push('stage'))],
      onRequest: (reason) => order.push(`onRequest:${reason}`),
    });
    shutdown.cancellation.addEventListener('abort', () => order.push('abort'));

    await shutdown.request('SIGINT');
    await shutdown.request('SIGTERM');

    expect(order).toEqual(['onRequest:SIGINT', 'abort', 'stage']);
  });

  it('still aborts and tears down when onRequest throws, and never throws from request', async () => {
    const ran: string[] = [];
    const shutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('only', () => void ran.push('stage'))],
      onRequest: () => {
        throw new Error('callback failed');
      },
    });

    await expect(shutdown.request('SIGINT')).resolves.toBeUndefined();

    expect(shutdown.cancellation.aborted).toBe(true);
    expect(ran).toEqual(['stage']);
  });

  it('joins a request made from inside onRequest instead of starting a second shutdown', async () => {
    const ran: string[] = [];
    const requests: string[] = [];
    const shutdown: HostShutdown = installHostShutdown({
      label: 'test',
      signals: [],
      steps: [step('only', () => void ran.push('stage'))],
      onRequest: (reason) => {
        requests.push(reason);
        void shutdown.request('nested');
      },
    });

    await shutdown.request('SIGINT');

    expect(requests).toEqual(['SIGINT']);
    expect(ran).toEqual(['stage']);
  });

  it('keeps the signals through a shutdown in progress when release is called', async () => {
    let finish!: () => void;
    const shutdown = installHostShutdown({
      label: 'test',
      signals: ['SIGINT'],
      steps: [step('slow', () => new Promise<void>((resolve) => (finish = resolve)))],
    });
    const listenersWhileInstalled = process.listenerCount('SIGINT');
    const requested = shutdown.request('first');
    // The first stage starts on the next microtask.
    await Promise.resolve();

    shutdown.release();
    expect(process.listenerCount('SIGINT')).toBe(listenersWhileInstalled);
    finish();
    await requested;

    expect(process.listenerCount('SIGINT')).toBe(listenersWhileInstalled - 1);
  });

  it('removes the signal listeners on release when no shutdown was requested', () => {
    const before = process.listenerCount('SIGINT');
    const shutdown = installHostShutdown({ label: 'test', signals: ['SIGINT'], steps: [] });
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    shutdown.release();

    expect(process.listenerCount('SIGINT')).toBe(before);
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
