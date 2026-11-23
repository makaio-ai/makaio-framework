import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnOptionsForOwnership, WindowsTreeTerminationError, type SignalDelivery } from '../process-tree.js';
import {
  startStopEscalation,
  windowsTreeEvidence,
  type StopEscalation,
  type StopHost,
  type TreeTerminationOutcome,
} from '../stop-escalation.js';
import type { UnobservedExitReason } from '../process-end.js';
import { killQuietly } from './fixtures/jsonl-children.js';

/**
 * These cases drive the Windows branch of the stop on whatever host runs them:
 * `StopHost` carries the platform and the `taskkill` run, so the ordering of
 * the termination and the observation window is observable without Windows.
 * The child is a real, long-running process in its own group; the stub host
 * never signals it, so it stays alive until the test removes it.
 */

/** Spawned children of a test; removed after it. */
const children: ChildProcess[] = [];
/** Escalations of a test; cancelled after it so no timer outlives it. */
const escalations: StopEscalation[] = [];

afterEach(() => {
  for (const escalation of escalations.splice(0)) escalation.cancel();
  for (const child of children.splice(0)) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      killQuietly(child.pid);
    }
  }
});

it.skipIf(process.platform === 'win32').each([
  [false, 'SIGTERM'],
  [true, 'SIGKILL'],
])('selects the first stop signal with forceful policy %s', (forcefulFirst, signal) => {
  const kill = vi.fn();
  const stop = startStopEscalation({
    pid: 2,
    ownership: 'process-group',
    killGraceMs: 0,
    forcefulFirst,
    exitObservationMs: 1000,
    deadline: undefined,
    port: { kill },
    exitUnobserved: () => true,
    onUnobserved: () => undefined,
    onSignalFailure: () => undefined,
  });
  try {
    expect(kill).toHaveBeenCalledWith(-2, signal);
  } finally {
    stop.cancel();
  }
});

/**
 * Spawn a child that runs until killed, as the leader of its own group.
 * @returns The child's PID.
 */
function spawnLongRunningChild(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    ...spawnOptionsForOwnership('process-group'),
    stdio: 'ignore',
  });
  children.push(child);
  if (child.pid === undefined) throw new Error('child did not start');
  return child.pid;
}

/** What a run of the stop reported, and when. */
interface StopReport {
  readonly startedAt: number;
  /** Elapsed milliseconds and reason of the unobserved report; `undefined` while it has not come. */
  unobserved?: { readonly afterMs: number; readonly reason: UnobservedExitReason };
  readonly failures: string[];
  readonly escalation: StopEscalation;
}

/**
 * Start a stop on a simulated Windows host with an observed-exit flag the test controls.
 * @param params - Timings, the simulated `taskkill` run and the exit flag.
 * @returns The report that fills in as the stop progresses.
 */
function startWindowsStop(params: {
  readonly exitObservationMs: number;
  readonly deadline?: number;
  readonly terminate: StopHost['terminateWindowsTree'];
  readonly exitUnobserved?: () => boolean;
}): StopReport {
  const startedAt = Date.now();
  const failures: string[] = [];
  const report: Partial<StopReport> & { startedAt: number; failures: string[] } = { startedAt, failures };
  const escalation = startStopEscalation({
    pid: spawnLongRunningChild(),
    ownership: 'process-group',
    killGraceMs: 60_000,
    exitObservationMs: params.exitObservationMs,
    deadline: params.deadline,
    host: { platform: 'win32', terminateWindowsTree: params.terminate },
    exitUnobserved: params.exitUnobserved ?? (() => true),
    onUnobserved: (reason) => {
      report.unobserved = { afterMs: Date.now() - startedAt, reason };
    },
    onSignalFailure: (description) => failures.push(description),
  });
  escalations.push(escalation);
  return Object.assign(report, { escalation }) as StopReport;
}

/**
 * Resolve a simulated `taskkill` after a delay.
 * @param ms - Time the run takes.
 * @param delivery - Result it reports.
 * @returns A terminator for {@link StopHost}.
 */
function terminationTaking(
  ms: number,
  delivery: Exclude<SignalDelivery, 'denied'> = 'delivered',
): StopHost['terminateWindowsTree'] {
  return async () => {
    await delay(ms);
    return delivery;
  };
}

describe('startStopEscalation on a Windows tree', () => {
  // Pins the ordering invariant: the window that measures how the process answers
  // the forceful stage opens when the termination finished. Opened alongside it,
  // a slow taskkill would use the window up and the exit would be classed as
  // unobserved the moment the termination returned.
  it('starts the exit observation only after the tree termination finished', async () => {
    const stop = startWindowsStop({ exitObservationMs: 250, terminate: terminationTaking(200) });

    await delay(300);
    // Termination finished at ~200ms; the 250ms window has not run out yet.
    expect(stop.unobserved).toBeUndefined();

    await delay(250);
    expect(stop.unobserved?.reason).toBe('observation-timeout');
    // At least the termination plus the full window, never the window alone.
    expect(stop.unobserved?.afterMs).toBeGreaterThanOrEqual(200 + 250 - 20);
  });

  it('opens the observation window after a failed termination as well, and counts it as refused', async () => {
    const error = new WindowsTreeTerminationError('failed', '1', 1, new Error('taskkill'));
    const stop = startWindowsStop({
      exitObservationMs: 200,
      terminate: async () => {
        await delay(150);
        throw error;
      },
    });

    await delay(250);
    expect(stop.unobserved).toBeUndefined();

    await vi.waitFor(() => expect(stop.unobserved).toBeDefined());
    expect(stop.unobserved?.reason).toBe('signal-denied');
    expect(stop.unobserved?.afterMs).toBeGreaterThanOrEqual(150 + 200 - 20);
    expect(stop.failures).toEqual(['failed (WindowsTreeTerminationError)']);
  });

  it('treats a termination that threw before it started as a failed one', async () => {
    const stop = startWindowsStop({
      exitObservationMs: 100,
      terminate: () => {
        throw new Error('invalid pid');
      },
    });

    await vi.waitFor(() => expect(stop.unobserved).toBeDefined());
    expect(stop.unobserved?.reason).toBe('signal-denied');
  });

  it('lets the caller deadline end a termination that is still running', async () => {
    const stop = startWindowsStop({
      exitObservationMs: 10_000,
      deadline: Date.now() + 150,
      terminate: terminationTaking(5_000),
    });

    await vi.waitFor(() => expect(stop.unobserved).toBeDefined());
    expect(stop.unobserved?.afterMs).toBeLessThan(1_000);
    expect(stop.unobserved?.reason).toBe('observation-timeout');
  });

  it('lets a tightened deadline end a termination that is still running', async () => {
    const stop = startWindowsStop({ exitObservationMs: 10_000, terminate: terminationTaking(5_000) });

    await delay(50);
    stop.escalation.tighten(Date.now() + 100);

    await vi.waitFor(() => expect(stop.unobserved).toBeDefined());
    expect(stop.unobserved?.afterMs).toBeLessThan(1_000);
  });

  it('reports nothing when the exit is observed while the termination is still running', async () => {
    let exited = false;
    const stop = startWindowsStop({
      exitObservationMs: 100,
      terminate: terminationTaking(150),
      exitUnobserved: () => !exited,
    });

    await delay(50);
    exited = true;
    stop.escalation.cancel();

    await delay(400);
    expect(stop.unobserved).toBeUndefined();
    expect(stop.failures).toEqual([]);
  });
});

describe('the tree termination of a stop on Windows', () => {
  // The owner reports the end of the child only after the tree termination has
  // finished, also when the child exited by itself while `taskkill` was running.
  it('settles only when taskkill has finished, also after the exit was observed and the stop cancelled', async () => {
    let exited = false;
    const stop = startWindowsStop({
      exitObservationMs: 1_000,
      terminate: terminationTaking(250),
      exitUnobserved: () => !exited,
    });
    exited = true;
    stop.escalation.cancel();

    let settledAfterMs: number | undefined;
    const outcome = await stop.escalation.termination?.then((value) => {
      settledAfterMs = Date.now() - stop.startedAt;
      return value;
    });

    expect(outcome).toBe('delivered');
    expect(settledAfterMs).toBeGreaterThanOrEqual(250 - 20);
    expect(stop.failures).toEqual([]);
  });

  it('settles with a refusal, never a rejection, when taskkill failed', async () => {
    const stop = startWindowsStop({
      exitObservationMs: 1_000,
      terminate: async () => {
        throw new WindowsTreeTerminationError('failed', '1', 1, new Error('taskkill'));
      },
    });
    stop.escalation.cancel();

    await expect(stop.escalation.termination).resolves.toBe('refused');
  });

  it('settles as timed out when taskkill did not finish in its bound', async () => {
    const stop = startWindowsStop({
      exitObservationMs: 1_000,
      terminate: async () => {
        throw new WindowsTreeTerminationError('timed-out', 'SIGTERM', 1, new Error('taskkill'));
      },
    });

    await expect(stop.escalation.termination).resolves.toBe('timed-out');
  });

  it('has no termination to join on a POSIX stop', () => {
    const escalation = startStopEscalation({
      pid: spawnLongRunningChild(),
      ownership: 'process-group',
      killGraceMs: 60_000,
      exitObservationMs: 1_000,
      deadline: undefined,
      exitUnobserved: () => true,
      onUnobserved: () => undefined,
      onSignalFailure: () => undefined,
    });
    escalations.push(escalation);

    expect(escalation.termination).toBeUndefined();
  });
});

describe('windowsTreeEvidence', () => {
  /**
   * Evidence for a termination that settles after a delay.
   * @param ms - Delay before the termination settles.
   * @param outcome - Its outcome.
   * @param signal - Abort signal of the owner's stop deadline.
   * @returns Evidence and the time it took.
   */
  async function evidenceAfter(
    ms: number,
    outcome: TreeTerminationOutcome,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ evidence: Awaited<ReturnType<typeof windowsTreeEvidence>>; afterMs: number }> {
    const startedAt = Date.now();
    const evidence = await windowsTreeEvidence(
      delay(ms).then(() => outcome),
      signal,
    );
    return { evidence, afterMs: Date.now() - startedAt };
  }

  it('waits for a termination that is still running before it reports', async () => {
    const { evidence, afterMs } = await evidenceAfter(200, 'delivered');

    expect(evidence).toEqual({ kind: 'quiescent' });
    expect(afterMs).toBeGreaterThanOrEqual(200 - 20);
  });

  it('reports a refused termination as descendants that may still run', async () => {
    const { evidence } = await evidenceAfter(0, 'refused');

    expect(evidence).toEqual({ kind: 'unproven', reason: 'signal-error' });
  });

  it('reports an unfinished termination as such', async () => {
    const { evidence } = await evidenceAfter(0, 'timed-out');

    expect(evidence).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
  });

  it('reports a termination that found no process as unproven (no-termination)', async () => {
    const { evidence } = await evidenceAfter(0, 'absent');

    expect(evidence).toEqual({ kind: 'unproven', reason: 'no-termination' });
  });

  it('proves nothing about quiescence when no termination ran', async () => {
    await expect(windowsTreeEvidence(undefined, new AbortController().signal)).resolves.toEqual({
      kind: 'unproven',
      reason: 'no-termination',
    });
  });

  it('ends the wait at the owner deadline and counts the termination as unfinished', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);

    const { evidence, afterMs } = await evidenceAfter(5_000, 'delivered', abort.signal);

    expect(evidence).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
    expect(afterMs).toBeLessThan(2_000);
  });
});
