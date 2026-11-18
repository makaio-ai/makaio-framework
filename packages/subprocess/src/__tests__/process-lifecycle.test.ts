import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProcessLifecycle } from '../process-lifecycle.js';
import type {
  ProcessLifecycleHandle,
  ProcessLifecycleOptions,
  ProcessRunOutcome,
  ProcessState,
} from '../process-lifecycle.js';
import type { IJsonlTransport, SubprocessSpawnOptions } from '../types.js';
import {
  GRANDCHILD_AND_STAY,
  GRANDCHILD_IGNORES_SIGTERM,
  IGNORE_SIGTERM_AND_STAY,
  READY_AND_STAY,
  denyingPort,
  isAlive,
  killQuietly,
} from './fixtures/jsonl-children.js';

const ON_WINDOWS = process.platform === 'win32';
const PROCESS_TEST_TIMEOUT_MS = 30_000;
const READY_HEALTH_TIMEOUT_MS = 10_000;
const WAIT_FOR_TIMEOUT_MS = 10_000;

/** Writes its PID as the readiness message and stays alive. */
const READY_WITH_PID_AND_STAY = `
process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
setInterval(() => {}, 1000);
`;

/** Writes the readiness message and exits with code 1 as soon as it reached the pipe. */
const READY_THEN_CRASH = `
process.stdout.write('{"ready":true}\\n', () => process.exit(1));
`;

/** Writes the readiness message and exits cleanly shortly after. */
const READY_THEN_CLEAN_EXIT = `
process.stdout.write('{"ready":true}\\n', () => setTimeout(() => process.exit(0), 50));
`;

/**
 * Leaves a grandchild in its process group, reports it as readiness and
 * crashes once that message reached the pipe.
 */
const READY_THEN_CRASH_LEAVING_GRANDCHILD = `
const grandchild = require('node:child_process').spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'ignore' },
);
grandchild.unref();
process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\n', () => process.exit(1));
`;

/**
 * Leaves a grandchild in a session of its own that holds stdout, reports it as
 * readiness and crashes once that message reached the pipe: the drain is held
 * past the child's exit while its own process group is empty.
 */
const READY_THEN_CRASH_LEAVING_STDOUT_HOLDER = `
const grandchild = require('node:child_process').spawn(
  process.execPath,
  ['-e', 'setTimeout(() => {}, 20000)'],
  { stdio: ['ignore', 'inherit', 'ignore'], detached: true },
);
grandchild.unref();
process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\n', () => process.exit(1));
`;

/**
 * Leaves a grandchild in its process group that holds stdout, then exits with
 * code 1 at once, before writing any readiness message.
 */
const EXIT_EARLY_LEAVING_STDOUT_HOLDER = `
require('node:child_process').spawn(
  process.execPath,
  ['-e', 'setTimeout(() => {}, 20000)'],
  { stdio: ['ignore', 'inherit', 'ignore'] },
).unref();
process.exit(1);
`;

/**
 * First run (no marker file yet): writes the marker, ignores SIGTERM and only
 * writes a non-object line once its handler is installed, so it never becomes
 * ready and outlives a stop's grace. Every later run becomes ready at once.
 */
const STUBBORN_FIRST_RUN_THEN_READY = `
const fs = require('node:fs');
const marker = process.env.MAKAIO_RUN_MARKER;
if (fs.existsSync(marker)) {
  process.stdout.write('{"ready":true}\\n');
} else {
  fs.writeFileSync(marker, 'first');
  process.on('SIGTERM', () => {});
  process.stdout.write('"booted"\\n');
}
setInterval(() => {}, 1000);
`;

/**
 * Ignores SIGTERM and answers it with a readiness message; before that it only
 * writes a non-object line, once its handler is installed.
 */
const READY_ONLY_ON_SIGTERM = `
process.on('SIGTERM', () => process.stdout.write('{"ready":true}\\n'));
process.stdout.write('"booted"\\n');
setInterval(() => {}, 1000);
`;

/** Lifecycles and stray processes a test created; cleaned up after each test. */
const handles = new Set<ProcessLifecycleHandle>();
const strayPids = new Set<number>();

/**
 * Spawn options for a `node -e` child.
 * @param script - Script source for `node -e`.
 * @param extra - Further spawn options.
 * @returns Spawn options.
 */
function nodeChild(script: string, extra: Partial<SubprocessSpawnOptions> = {}): SubprocessSpawnOptions {
  return { command: process.execPath, args: ['-e', script], cwd: process.cwd(), ...extra };
}

/**
 * Create a lifecycle that the suite stops after the test, recording its
 * states and run outcomes.
 * @param options - Lifecycle options; `onStateChange` and `onExit` are recorded as well.
 * @returns The handle with its recorded states and outcomes.
 */
function track(options: ProcessLifecycleOptions): {
  handle: ProcessLifecycleHandle;
  states: ProcessState[];
  outcomes: ProcessRunOutcome[];
} {
  const states: ProcessState[] = [];
  const outcomes: ProcessRunOutcome[] = [];
  const handle = createProcessLifecycle({
    healthTimeoutMs: READY_HEALTH_TIMEOUT_MS,
    ...options,
    onStateChange: (state) => {
      states.push(state);
      options.onStateChange?.(state);
    },
    onExit: (outcome) => {
      outcomes.push(outcome);
      options.onExit?.(outcome);
    },
  });
  handles.add(handle);
  return { handle, states, outcomes };
}

/**
 * Wait at most `ms` milliseconds for a condition to become true.
 * @param condition - Predicate to poll until it returns true.
 * @param ms - Maximum wait duration in milliseconds.
 * @returns Promise that resolves when the condition is met.
 */
function waitFor(condition: () => boolean, ms: number = WAIT_FOR_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Condition not met within ${ms}ms`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/**
 * Wait a fixed time.
 * @param ms - Milliseconds to wait.
 * @returns Promise that resolves after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start a lifecycle and capture the first message of the run it spawns. The
 * transport exists as soon as `start()` returned its promise.
 * @param handle - Lifecycle in a state that allows `start()`.
 * @returns The start promise and the first message of the new run.
 */
function startCapturingFirstMessage(handle: ProcessLifecycleHandle): {
  started: Promise<void>;
  first: Promise<Record<string, unknown>>;
} {
  const started = handle.start();
  const transport = handle.transport;
  if (transport === undefined) throw new Error('start() did not create a transport');
  const first = new Promise<Record<string, unknown>>((resolve) => {
    const unsubscribe = transport.onMessage((message) => {
      unsubscribe();
      resolve(message as Record<string, unknown>);
    });
  });
  return { started, first };
}

/**
 * Record every message the current run of a lifecycle delivers.
 * @param handle - Lifecycle right after `start()`, while its run is current.
 * @returns The messages received so far; the array grows as more arrive.
 */
function recordMessages(handle: ProcessLifecycleHandle): unknown[] {
  const transport = handle.transport;
  if (transport === undefined) throw new Error('the lifecycle has no current run');
  const messages: unknown[] = [];
  transport.onMessage((message) => messages.push(message));
  return messages;
}

/**
 * Start a lifecycle whose child reports its PID as readiness message, and
 * register that PID for cleanup.
 * @param handle - Lifecycle spawning {@link READY_WITH_PID_AND_STAY} or a script with the same first line.
 * @returns The child's PID once the lifecycle is running.
 */
async function startReportingPid(handle: ProcessLifecycleHandle): Promise<number> {
  const { started, first } = startCapturingFirstMessage(handle);
  const pid = (await first).pid as number;
  strayPids.add(pid);
  await started;
  return pid;
}

describe('createProcessLifecycle', { timeout: PROCESS_TEST_TIMEOUT_MS }, () => {
  afterEach(async () => {
    await Promise.all([...handles].map((handle) => handle.stop()));
    handles.clear();
    for (const pid of strayPids) killQuietly(pid);
    strayPids.clear();
    vi.restoreAllMocks();
  });

  describe('idle', () => {
    it('starts in idle state without a transport or generation', () => {
      const { handle } = track({ spawn: nodeChild('') });

      expect(handle.state).toBe('idle');
      expect(handle.transport).toBeUndefined();
      expect(handle.generation).toBe(0);
    });

    it('stop() is a no-op', async () => {
      const { handle, states } = track({ spawn: nodeChild('') });

      await expect(handle.stop()).resolves.toBeUndefined();
      expect(handle.state).toBe('idle');
      expect(states).toEqual([]);
    });
  });

  describe('starting', () => {
    it('moves idle → starting → running on the first object message and reports readiness once', async () => {
      let readyCalls = 0;
      const { handle, states } = track({
        spawn: nodeChild(READY_AND_STAY, { processName: 'test-ready' }),
        onReady: () => {
          readyCalls += 1;
        },
      });

      const started = handle.start();
      expect(handle.state).toBe('starting');
      expect(handle.transport).toBeDefined();
      expect(handle.generation).toBe(1);
      await started;

      expect(states).toEqual(['starting', 'running']);
      expect(readyCalls).toBe(1);
    });

    it('rejects a start() while a run is starting or running', async () => {
      const { handle } = track({ spawn: nodeChild(READY_AND_STAY) });

      const started = handle.start();
      await expect(handle.start()).rejects.toThrow('Invalid state transition: starting → starting');
      await started;
      await expect(handle.start()).rejects.toThrow('Invalid state transition: running → starting');
      expect(handle.generation).toBe(1);
    });

    it('rejects start() as soon as the spawn fails, not at the health timeout', async () => {
      const { handle, outcomes } = track({
        spawn: { command: '/nonexistent/makaio-lifecycle-missing-binary', cwd: process.cwd(), processName: 'missing' },
        healthTimeoutMs: 20_000,
      });
      const startedAt = Date.now();

      await expect(handle.start()).rejects.toThrow('missing failed to start: could not be spawned (ENOENT)');

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(handle.state).toBe('crashed');
      expect(handle.transport).toBeUndefined();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ generation: 1, readiness: 'not-reached', restart: { kind: 'none' } });
      expect(outcomes[0]!.end.cause).toBe('spawn-failed');
    });

    it('rejects start() when the child exits with code 0 before readiness', async () => {
      const { handle, outcomes } = track({ spawn: nodeChild('process.exit(0)', { processName: 'early-exit' }) });

      await expect(handle.start()).rejects.toThrow(
        'early-exit ended unexpectedly: exited with code 0 before signalling readiness',
      );

      expect(handle.state).toBe('crashed');
      expect(outcomes[0]!.readiness).toBe('not-reached');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 0, signal: null });
    });

    it('does not count a message that is not a JSON object as readiness', async () => {
      let readyCalls = 0;
      // Long enough for a cold `node -e` start to write every line first, also on a loaded host.
      const { handle } = track({
        spawn: nodeChild(`process.stdout.write('[1]\\n42\\n"ready"\\nnull\\ntrue\\n'); setInterval(() => {}, 1000);`, {
          processName: 'non-object',
        }),
        healthTimeoutMs: 2_000,
        onReady: () => {
          readyCalls += 1;
        },
      });

      const started = handle.start();
      const messages = recordMessages(handle);
      await expect(started).rejects.toThrow('Process health timeout after 2000ms: non-object');

      // Every candidate reached the lifecycle before the timeout, so the shape check rejected them.
      expect(messages).toEqual([[1], 42, 'ready', null, true]);
      expect(readyCalls).toBe(0);
      expect(handle.state).toBe('crashed');
    });

    it('lets an observed exit, not the health timeout, decide a start whose drain is held', async () => {
      const { handle, outcomes } = track({
        spawn: nodeChild(EXIT_EARLY_LEAVING_STDOUT_HOLDER, { processName: 'early-exit-held' }),
        healthTimeoutMs: 300,
        stopTiming: { drainTimeoutMs: 1_000 },
      });
      const startedAt = Date.now();

      // The drain outlasts the health timeout, but the exit was observed first.
      await expect(handle.start()).rejects.toThrow(
        'early-exit-held ended unexpectedly: exited with code 1; stdout truncated at the drain deadline',
      );

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
      expect(handle.state).toBe('crashed');
      expect(outcomes[0]).toMatchObject({ generation: 1, readiness: 'not-reached' });
      expect(outcomes[0]!.end.cause).toBe('unexpected');
    });

    it('lets the health timeout win for good: a later object message does not restore readiness', async () => {
      let readyCalls = 0;
      // Long enough for a cold `node -e` start to install its SIGTERM handler
      // and write `booted` first, also on a loaded host.
      const { handle, states, outcomes } = track({
        spawn: nodeChild(READY_ONLY_ON_SIGTERM),
        healthTimeoutMs: 2_000,
        stopTiming: { killGraceMs: 500 },
        onReady: () => {
          readyCalls += 1;
        },
      });
      const { started, first } = startCapturingFirstMessage(handle);
      const messages = recordMessages(handle);
      // The child has installed its SIGTERM handler once it wrote this line.
      await expect(first).resolves.toBe('booted');

      await expect(started).rejects.toThrow('health timeout');
      expect(handle.state).toBe('crashed');

      // The timeout stops the run; the child answers SIGTERM with an object
      // message and is killed after the grace period.
      await waitFor(() => outcomes.length === 1);
      expect(messages).toContainEqual({ ready: true });
      expect(readyCalls).toBe(0);
      expect(states).toEqual(['starting', 'crashed']);
      expect(outcomes[0]).toMatchObject({ generation: 1, readiness: 'health-timeout', restart: { kind: 'none' } });
      expect(outcomes[0]!.end.cause).toBe('requested');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
      expect(handle.state).toBe('crashed');
      expect(handle.transport).toBeUndefined();
    });

    it('stop() aborts readiness, removes its subscriptions and ends stopped', async () => {
      let readyCalls = 0;
      const healthTimeoutMs = 2_000;
      const { handle, states, outcomes } = track({
        spawn: nodeChild(READY_ONLY_ON_SIGTERM, { processName: 'aborted' }),
        healthTimeoutMs,
        stopTiming: { killGraceMs: 300 },
        onReady: () => {
          readyCalls += 1;
        },
      });
      const startedAt = Date.now();
      const { started, first } = startCapturingFirstMessage(handle);
      const messages = recordMessages(handle);
      await expect(first).resolves.toBe('booted');

      const stopped = handle.stop();
      await expect(started).rejects.toThrow('Process start aborted by stop(): aborted');
      await stopped;

      // The child's answer to SIGTERM is an object message; it arrived after
      // the abort and did not make the run ready.
      expect(messages).toContainEqual({ ready: true });
      expect(readyCalls).toBe(0);
      expect(states).toEqual(['starting', 'stopping', 'stopped']);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ readiness: 'aborted' });
      expect(outcomes[0]!.end.cause).toBe('requested');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });

      // The health timer was cleared with the abort: its deadline passes without effect.
      await sleep(Math.max(0, startedAt + healthTimeoutMs + 200 - Date.now()));
      expect(handle.state).toBe('stopped');
      expect(states).toEqual(['starting', 'stopping', 'stopped']);
    });
  });

  describe('running', () => {
    it('ends stopped without a restart when the child exits with code 0 under the none policy', async () => {
      const { handle, states, outcomes } = track({
        spawn: nodeChild(`process.stdout.write('{"ready":true}\\n', () => setTimeout(() => process.exit(0), 50));`),
      });

      await handle.start();
      await waitFor(() => outcomes.length === 1);

      expect(handle.state).toBe('stopped');
      expect(states).toEqual(['starting', 'running', 'stopped']);
      expect(outcomes[0]).toMatchObject({ generation: 1, readiness: 'ready', restart: { kind: 'none' } });
      expect(outcomes[0]!.end.cause).toBe('unexpected');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 0, signal: null });
    });

    it('restarts after an exit with code 0 under the always policy', async () => {
      const restartDir = mkdtempSync(join(tmpdir(), 'makaio-process-lifecycle-'));
      try {
        const { handle, states, outcomes } = track({
          spawn: nodeChild(
            `
const fs = require('node:fs');
const marker = process.env.MAKAIO_RESTART_MARKER;
process.stdout.write('{"ready":true}\\n');
if (fs.existsSync(marker)) {
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(marker, 'done');
  setTimeout(() => process.exit(0), 50);
}
`,
            { env: { MAKAIO_RESTART_MARKER: join(restartDir, 'first-run-complete') } },
          ),
          restartPolicy: 'always',
          restartBudget: { initialDelayMs: 10 },
        });

        await handle.start();
        await waitFor(() => handle.generation === 2 && handle.state === 'running');

        expect(states).toEqual(['starting', 'running', 'stopped', 'starting', 'running']);
        expect(outcomes[0]).toMatchObject({ generation: 1, restart: { kind: 'scheduled', delayMs: 10 } });
      } finally {
        rmSync(restartDir, { recursive: true, force: true });
      }
    });

    it('ends crashed without a restart when the child exits with code 1 under the none policy', async () => {
      const { handle, states, outcomes } = track({ spawn: nodeChild(READY_THEN_CRASH) });

      await handle.start();
      await waitFor(() => outcomes.length === 1);

      expect(handle.state).toBe('crashed');
      expect(states).toEqual(['starting', 'running', 'crashed']);
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 1, signal: null });
      expect(outcomes[0]!.restart).toEqual({ kind: 'none' });
      expect(handle.transport).toBeUndefined();
    });

    it('restarts after an exit with code 1 under the on-crash policy', async () => {
      const restartDir = mkdtempSync(join(tmpdir(), 'makaio-process-lifecycle-'));
      try {
        const { handle, states, outcomes } = track({
          spawn: nodeChild(
            `
const fs = require('node:fs');
const marker = process.env.MAKAIO_RESTART_MARKER;
process.stdout.write('{"ready":true}\\n');
if (fs.existsSync(marker)) {
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(marker, 'done');
  setTimeout(() => process.exit(1), 50);
}
`,
            { env: { MAKAIO_RESTART_MARKER: join(restartDir, 'first-run-complete') } },
          ),
          restartPolicy: 'on-crash',
          restartBudget: { initialDelayMs: 10 },
        });

        await handle.start();
        await waitFor(() => handle.generation === 2 && handle.state === 'running');

        expect(states).toEqual(['starting', 'running', 'crashed', 'starting', 'running']);
        expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 1, signal: null });
        expect(outcomes[0]!.restart).toEqual({ kind: 'scheduled', delayMs: 10 });
      } finally {
        rmSync(restartDir, { recursive: true, force: true });
      }
    });

    it('ends stopped without a restart when the child exits with code 0 under the on-crash policy', async () => {
      const { handle, states, outcomes } = track({
        spawn: nodeChild(READY_THEN_CLEAN_EXIT),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 10 },
      });

      await handle.start();
      await waitFor(() => outcomes.length === 1);
      await sleep(200);

      expect(handle.state).toBe('stopped');
      expect(handle.generation).toBe(1);
      expect(states).toEqual(['starting', 'running', 'stopped']);
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 0, signal: null });
      expect(outcomes[0]!.restart).toEqual({ kind: 'none' });
    });

    it('restarts a run ended by an external signal under the on-crash policy', async () => {
      const { handle, outcomes } = track({
        spawn: nodeChild(READY_WITH_PID_AND_STAY),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 10 },
      });
      const pid = await startReportingPid(handle);

      process.kill(pid, 'SIGTERM');
      await waitFor(() => handle.generation === 2 && handle.state === 'running');

      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
      expect(outcomes[0]!.restart).toEqual({ kind: 'scheduled', delayMs: 10 });
    });

    it.skipIf(ON_WINDOWS)(
      'withholds the restart when a member of the crashed run outlives it in its process group',
      async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { handle, outcomes } = track({
          spawn: nodeChild(READY_THEN_CRASH_LEAVING_GRANDCHILD, { processName: 'leaves-grandchild' }),
          restartPolicy: 'on-crash',
          restartBudget: { initialDelayMs: 10 },
        });
        const { started, first } = startCapturingFirstMessage(handle);
        strayPids.add((await first).grandchild as number);
        await started;

        await waitFor(() => outcomes.length === 1);
        await sleep(200);

        expect(handle.state).toBe('crashed');
        expect(handle.generation).toBe(1);
        expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 1, signal: null });
        expect(outcomes[0]!.end.tree).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
        expect(outcomes[0]!.restart).toEqual({ kind: 'withheld', reason: 'descendants-may-run' });
        expect(warnSpy.mock.calls.flat().join('\n')).toContain(
          '[ProcessLifecycle:leaves-grandchild] generation 1 may have left processes running',
        );
      },
    );

    it('withholds the restart when a process outside the group holds stdout past the drain deadline', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { handle, outcomes } = track({
        spawn: nodeChild(READY_THEN_CRASH_LEAVING_STDOUT_HOLDER),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 10 },
        stopTiming: { drainTimeoutMs: 300 },
      });
      const { started, first } = startCapturingFirstMessage(handle);
      strayPids.add((await first).grandchild as number);
      await started;

      await waitFor(() => outcomes.length === 1);
      await sleep(200);

      expect(handle.state).toBe('crashed');
      expect(handle.generation).toBe(1);
      expect(outcomes[0]!.end.drain).toMatchObject({ kind: 'timed-out', stdoutComplete: false });
      // The holder left the group, so only the drain shows that it outlived the child.
      expect(outcomes[0]!.end.tree).toEqual(
        ON_WINDOWS ? { kind: 'unproven', reason: 'no-termination' } : { kind: 'quiescent' },
      );
      expect(outcomes[0]!.restart).toEqual({ kind: 'withheld', reason: 'descendants-may-run' });
    });

    // Simulated through the `stopHost` seam: no `taskkill` ever runs for a crash,
    // so a Windows tree stays unproven and must be treated as possibly alive.
    it('withholds the restart of a crash on Windows, where no tree proof exists, and still allows start()', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { handle, outcomes } = track({
        spawn: nodeChild(READY_THEN_CRASH, { processName: 'windows-crash' }),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 10 },
        stopHost: {
          platform: 'win32',
          terminateWindowsTree: () => Promise.reject(new Error('no stop was requested')),
        },
      });

      await handle.start();
      await waitFor(() => outcomes.length === 1);
      await sleep(200);

      expect(handle.state).toBe('crashed');
      expect(handle.generation).toBe(1);
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 1, signal: null });
      expect(outcomes[0]!.end.tree).toEqual({ kind: 'unproven', reason: 'no-termination' });
      expect(outcomes[0]!.restart).toEqual({ kind: 'withheld', reason: 'descendants-may-run' });
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        '[ProcessLifecycle:windows-crash] generation 1 may have left processes running',
      );

      // An explicit start() is the owner's decision and stays allowed.
      await handle.start();
      expect(handle.generation).toBe(2);
    });

    it('classifies an external SIGTERM as a crash through the explicit signal', async () => {
      const { handle, outcomes } = track({ spawn: nodeChild(READY_WITH_PID_AND_STAY) });
      const pid = await startReportingPid(handle);

      process.kill(pid, 'SIGTERM');
      await waitFor(() => outcomes.length === 1);

      expect(handle.state).toBe('crashed');
      expect(outcomes[0]!.end.cause).toBe('unexpected');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
    });

    it('keeps running when stdout closes while the child lives on, and stops it later', async () => {
      const drainTimeoutMs = 200;
      const { handle, outcomes } = track({
        spawn: nodeChild(
          `process.stdout.write('{"ready":true}\\n', () => require('node:fs').closeSync(1)); setInterval(() => {}, 1000);`,
        ),
        stopTiming: { drainTimeoutMs },
      });

      await handle.start();
      // Well past the drain window, after which a `terminal` stdout policy
      // would have ended the run.
      await sleep(drainTimeoutMs * 5);
      expect(handle.state).toBe('running');
      expect(outcomes).toEqual([]);

      await handle.stop();
      expect(handle.state).toBe('stopped');
      expect(outcomes[0]!.end.cause).toBe('requested');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
    });

    it('ends stopped without a restart when the run is closed through its transport', async () => {
      const { handle, states, outcomes } = track({ spawn: nodeChild(READY_AND_STAY), restartPolicy: 'always' });
      await handle.start();

      await handle.transport!.close();
      await waitFor(() => outcomes.length === 1);

      expect(handle.state).toBe('stopped');
      expect(states).toEqual(['starting', 'running', 'stopped']);
      expect(outcomes[0]!.end.cause).toBe('requested');
      expect(outcomes[0]!.restart).toEqual({ kind: 'none' });
    });

    it('delivers a message written just before a crash before onExit', async () => {
      const order: string[] = [];
      const { handle } = track({
        spawn: nodeChild(
          `process.stdout.write('{"ready":true}\\n'); setTimeout(() => process.stdout.write('{"last":true}\\n', () => process.exit(1)), 50);`,
        ),
        onExit: () => order.push('exit'),
      });

      const started = handle.start();
      handle.transport!.onMessage((message) => {
        if ((message as { last?: boolean }).last === true) order.push('last message');
      });
      await started;
      await waitFor(() => order.includes('exit'));

      expect(order).toEqual(['last message', 'exit']);
    });
  });

  describe('stop', () => {
    it('follows idle → starting → running → stopping → stopped and reports a requested end', async () => {
      const { handle, states, outcomes } = track({ spawn: nodeChild(READY_AND_STAY) });

      await handle.start();
      await handle.stop();

      expect(handle.state).toBe('stopped');
      expect(handle.transport).toBeUndefined();
      expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ generation: 1, readiness: 'ready', restart: { kind: 'none' } });
      expect(outcomes[0]!.end.cause).toBe('requested');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
    });

    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
      const { handle, outcomes } = track({
        spawn: nodeChild(IGNORE_SIGTERM_AND_STAY),
        stopTiming: { killGraceMs: 300 },
      });
      await handle.start();
      const stopAt = Date.now();

      await handle.stop();

      expect(Date.now() - stopAt).toBeGreaterThanOrEqual(250);
      expect(handle.state).toBe('stopped');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
    });

    it.skipIf(ON_WINDOWS)('stops the grandchild together with the child', async () => {
      const { handle, outcomes } = track({ spawn: nodeChild(GRANDCHILD_AND_STAY) });
      const { started, first } = startCapturingFirstMessage(handle);
      const grandchild = (await first).grandchild as number;
      strayPids.add(grandchild);
      await started;

      await handle.stop();

      // A quiescent group may still list the grandchild as an unreaped zombie,
      // which a signal probe counts as alive until it is reaped.
      await waitFor(() => !isAlive(grandchild));
      expect(outcomes[0]!.end.tree).toEqual({ kind: 'quiescent' });
    });

    it.runIf(ON_WINDOWS)(
      'stops the grandchild together with the child through the process tree on Windows',
      async () => {
        const { handle, outcomes } = track({ spawn: nodeChild(GRANDCHILD_AND_STAY) });
        const { started, first } = startCapturingFirstMessage(handle);
        const grandchild = (await first).grandchild as number;
        strayPids.add(grandchild);
        await started;

        await handle.stop();

        await waitFor(() => !isAlive(grandchild));
        expect(outcomes[0]!.end.tree).toEqual({ kind: 'quiescent' });
      },
    );

    it.skipIf(ON_WINDOWS)('reports, rather than stops, a group member that outlives the child on stop()', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { handle, outcomes } = track({
        spawn: nodeChild(GRANDCHILD_IGNORES_SIGTERM, { processName: 'stubborn-member' }),
        stopTiming: { killGraceMs: 200, exitObservationMs: 300 },
      });
      const { started, first } = startCapturingFirstMessage(handle);
      const grandchild = (await first).grandchild as number;
      strayPids.add(grandchild);
      await started;

      await handle.stop();

      // The child died on SIGTERM; the stop ended with its observed exit, so
      // the member that ignores SIGTERM was never sent SIGKILL.
      expect(handle.state).toBe('stopped');
      expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
      expect(outcomes[0]!.end.tree).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
      expect(isAlive(grandchild)).toBe(true);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        '[ProcessLifecycle:stubborn-member] generation 1 may have left processes running (stopped on request',
      );
    });

    it('leaves the grandchild alone when the tree is opted out', async () => {
      const { handle, outcomes } = track({ spawn: nodeChild(GRANDCHILD_AND_STAY), terminateTree: false });
      const { started, first } = startCapturingFirstMessage(handle);
      const grandchild = (await first).grandchild as number;
      strayPids.add(grandchild);
      await started;

      await handle.stop();

      expect(isAlive(grandchild)).toBe(true);
      expect(outcomes[0]!.end.tree).toEqual({ kind: 'not-owned' });
    });

    // On Windows the tree stop runs taskkill, which does not go through the injected port.
    it.skipIf(ON_WINDOWS)(
      'ends stopped with a warning when the stop signals are denied and the exit stays unobserved',
      async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { handle, outcomes } = track({
          spawn: nodeChild(READY_WITH_PID_AND_STAY, { processName: 'denied-stop' }),
          stopTiming: { killGraceMs: 50 },
          signalPort: denyingPort(),
        });
        const pid = await startReportingPid(handle);

        await handle.stop();

        expect(handle.state).toBe('stopped');
        expect(outcomes[0]!.end.exit).toEqual({ kind: 'unobserved', reason: 'signal-denied' });
        expect(isAlive(pid)).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            '[ProcessLifecycle:denied-stop] generation 1 may have left processes running (stopped on request: exit not observed (signal-denied)',
          ),
        );
      },
    );

    it('returns the same stop for concurrent calls and reports the run once', async () => {
      const { handle, states, outcomes } = track({ spawn: nodeChild(READY_AND_STAY) });
      await handle.start();

      await Promise.all([handle.stop(), handle.stop()]);
      await handle.stop();

      expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
      expect(outcomes).toHaveLength(1);
    });

    it('reaches stopped from crashed', async () => {
      const { handle, states, outcomes } = track({ spawn: nodeChild(READY_THEN_CRASH) });
      await handle.start();
      await waitFor(() => handle.state === 'crashed');

      await handle.stop();

      expect(handle.state).toBe('stopped');
      expect(states).toEqual(['starting', 'running', 'crashed', 'stopping', 'stopped']);
      expect(outcomes).toHaveLength(1);
    });
  });

  describe('unobserved ends', () => {
    it.skipIf(ON_WINDOWS)(
      'never restarts automatically after an unobserved end, while an explicit start() still works',
      async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let deny = true;
        const { handle, states, outcomes } = track({
          spawn: nodeChild(
            `require('node:fs').closeSync(0); process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n'); setInterval(() => {}, 1000);`,
            { processName: 'unobserved' },
          ),
          restartPolicy: 'always',
          restartBudget: { initialDelayMs: 10 },
          stopTiming: { killGraceMs: 50 },
          signalPort: denyingPort(() => deny),
        });
        const pid = await startReportingPid(handle);

        // The child closed its stdin: the write fails, the transport stops the
        // child, and the denied signals leave its exit unobserved.
        handle.transport!.send({ ping: true });
        await waitFor(() => outcomes.length === 1);

        expect(handle.state).toBe('crashed');
        expect(outcomes[0]!.end.cause).toBe('unexpected');
        expect(outcomes[0]!.end.exit).toEqual({ kind: 'unobserved', reason: 'signal-denied' });
        expect(outcomes[0]!.restart).toEqual({ kind: 'withheld', reason: 'exit-unobserved' });
        expect(isAlive(pid)).toBe(true);
        expect(warnSpy.mock.calls.flat().join('\n')).toContain('exit not observed (signal-denied)');
        await sleep(200);
        expect(handle.generation).toBe(1);
        expect(handle.state).toBe('crashed');

        // The outcome keeps watching the old child: its exit is reported once it happens.
        const settledFirst = await Promise.race([
          outcomes[0]!.exitObserved.then(() => 'observed'),
          sleep(100).then(() => 'pending'),
        ]);
        expect(settledFirst).toBe('pending');
        process.kill(pid, 'SIGKILL');
        await expect(outcomes[0]!.exitObserved).resolves.toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });

        deny = false;
        await startReportingPid(handle);
        expect(handle.generation).toBe(2);
        expect(handle.state).toBe('running');
        expect(states).toEqual(['starting', 'running', 'crashed', 'starting', 'running']);
      },
    );
  });

  describe('restart budget', () => {
    it('backs off and stays crashed once a restart storm used up the budget', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { handle, outcomes } = track({
        spawn: nodeChild(READY_THEN_CRASH, { processName: 'storm' }),
        restartPolicy: 'on-crash',
        restartBudget: { maxRestarts: 2, windowMs: 60_000, initialDelayMs: 20, maxDelayMs: 1_000 },
      });

      await handle.start();
      await waitFor(() => outcomes.length === 3);
      await sleep(200);

      expect(handle.state).toBe('crashed');
      expect(handle.generation).toBe(3);
      expect(outcomes.map((outcome) => outcome.restart)).toEqual([
        { kind: 'scheduled', delayMs: 20 },
        { kind: 'scheduled', delayMs: 40 },
        { kind: 'withheld', reason: 'budget-exhausted' },
      ]);
      expect(outcomes.map((outcome) => outcome.generation)).toEqual([1, 2, 3]);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        '[ProcessLifecycle:storm] restart budget exhausted (2 restarts within 60000ms); staying crashed',
      );
    });

    it('drops a pending restart when stop() arrives first', async () => {
      const { handle, states, outcomes } = track({
        spawn: nodeChild(READY_THEN_CRASH),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 400 },
      });
      await handle.start();
      await waitFor(() => outcomes.length === 1);
      expect(outcomes[0]!.restart).toEqual({ kind: 'scheduled', delayMs: 400 });

      await handle.stop();
      await sleep(600);

      expect(handle.state).toBe('stopped');
      expect(handle.generation).toBe(1);
      expect(states).toEqual(['starting', 'running', 'crashed', 'stopping', 'stopped']);
    });

    it('lets an explicit start() replace a pending restart', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // One restart in the budget: the second crash schedules nothing, so no
      // legitimate restart can race the check that the replaced one never fires.
      const { handle, outcomes } = track({
        spawn: nodeChild(READY_THEN_CRASH),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 300, maxRestarts: 1 },
      });
      await handle.start();
      await waitFor(() => outcomes.length === 1);
      const firstCrashAt = Date.now();

      await handle.start();
      expect(handle.generation).toBe(2);
      await waitFor(() => outcomes.length === 2);
      // The replaced restart was due 300 ms after the first crash.
      await sleep(Math.max(0, firstCrashAt + 500 - Date.now()));

      expect(handle.generation).toBe(2);
      expect(outcomes.map((outcome) => outcome.restart)).toEqual([
        { kind: 'scheduled', delayMs: 300 },
        { kind: 'withheld', reason: 'budget-exhausted' },
      ]);
      // A stale timer that fired into a starting or running generation would have logged a failed restart.
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('runs', () => {
    /**
     * A lifecycle whose first run a health timeout left stopping: it ignores
     * SIGTERM and so outlives a stop until the kill grace has passed.
     * @param markerDir - Directory for the marker that tells the first run from later ones.
     * @param onExit - Observer of every run's outcome.
     * @returns The tracked lifecycle, in `crashed` after the health timeout.
     */
    async function afterHealthTimeout(markerDir: string, onExit?: (outcome: ProcessRunOutcome) => void) {
      const tracked = track({
        spawn: nodeChild(STUBBORN_FIRST_RUN_THEN_READY, {
          env: { MAKAIO_RUN_MARKER: join(markerDir, 'first-run') },
        }),
        healthTimeoutMs: 1_500,
        stopTiming: { killGraceMs: 800 },
        onExit,
      });
      const { started, first } = startCapturingFirstMessage(tracked.handle);
      await expect(first).resolves.toBe('booted');
      await expect(started).rejects.toThrow('health timeout');
      expect(tracked.handle.state).toBe('crashed');
      return tracked;
    }

    it('starts the next run only after the run a health timeout left stopping has ended', async () => {
      const markerDir = mkdtempSync(join(tmpdir(), 'makaio-process-lifecycle-'));
      try {
        let handleRef: ProcessLifecycleHandle | undefined;
        const generationsAtOutcome: number[] = [];
        const { handle, outcomes } = await afterHealthTimeout(markerDir, () =>
          generationsAtOutcome.push(handleRef!.generation),
        );
        handleRef = handle;

        // Run 1 ignores SIGTERM and is still inside its kill grace.
        const restarting = handle.start();
        await sleep(300);
        expect(handle.generation).toBe(1);
        expect(handle.state).toBe('crashed');
        expect(outcomes).toHaveLength(0);

        await restarting;

        // Run 1's end was reported before run 2 existed, so it can never drive run 2.
        expect(generationsAtOutcome).toEqual([1]);
        expect(outcomes[0]).toMatchObject({ generation: 1, readiness: 'health-timeout', restart: { kind: 'none' } });
        expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
        expect(handle.generation).toBe(2);
        expect(handle.state).toBe('running');
        expect(handle.transport?.status).toBe('writable');
      } finally {
        rmSync(markerDir, { recursive: true, force: true });
      }
    });

    it('never resolves stop() while a run that a health timeout left stopping is still ending', async () => {
      const markerDir = mkdtempSync(join(tmpdir(), 'makaio-process-lifecycle-'));
      try {
        const { handle, outcomes } = await afterHealthTimeout(markerDir);

        const restarting = handle.start();
        const stopped = handle.stop();

        // The overtaken start spawns nothing.
        await expect(restarting).rejects.toThrow('aborted');
        await stopped;
        expect(outcomes.map((outcome) => outcome.generation)).toEqual([1]);
        expect(handle.generation).toBe(1);
        expect(handle.state).toBe('stopped');
      } finally {
        rmSync(markerDir, { recursive: true, force: true });
      }
    });

    it('lets only the first of two start() calls that wait for the previous run spawn', async () => {
      const markerDir = mkdtempSync(join(tmpdir(), 'makaio-process-lifecycle-'));
      try {
        const { handle } = await afterHealthTimeout(markerDir);

        const first = handle.start();
        const second = handle.start();

        await expect(second).rejects.toThrow('aborted');
        await first;
        expect(handle.generation).toBe(2);
        expect(handle.state).toBe('running');
      } finally {
        rmSync(markerDir, { recursive: true, force: true });
      }
    });
  });

  describe('observers', () => {
    it('lets a stop() from the crashed notification suppress the restart decided in the same step', async () => {
      let handleRef: ProcessLifecycleHandle | undefined;
      const { handle, states, outcomes } = track({
        spawn: nodeChild(READY_THEN_CRASH),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 20 },
        onStateChange: (state) => {
          if (state === 'crashed') void handleRef?.stop();
        },
      });
      handleRef = handle;

      await handle.start();
      await waitFor(() => outcomes.length === 1);
      await sleep(300);

      expect(handle.state).toBe('stopped');
      expect(handle.generation).toBe(1);
      expect(states).toEqual(['starting', 'running', 'crashed', 'stopping', 'stopped']);
    });

    it('lets a start() from the crashed notification replace the restart decided in the same step', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let handleRef: ProcessLifecycleHandle | undefined;
      let restarted = false;
      const { handle } = track({
        spawn: nodeChild(READY_WITH_PID_AND_STAY),
        restartPolicy: 'on-crash',
        restartBudget: { initialDelayMs: 20 },
        onStateChange: (state) => {
          if (state !== 'crashed' || restarted) return;
          restarted = true;
          handleRef?.start().catch(() => {});
        },
      });
      handleRef = handle;
      const pid = await startReportingPid(handle);

      process.kill(pid, 'SIGKILL');
      await waitFor(() => handle.generation === 2 && handle.state === 'running');
      await sleep(200);

      expect(handle.generation).toBe(2);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('settles start() and keeps going when an observer throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let readyCalls = 0;
      const { handle, states } = track({
        spawn: nodeChild(READY_AND_STAY, { processName: 'throwing-observer' }),
        onStateChange: () => {
          throw new Error('observer failed');
        },
        onReady: () => {
          readyCalls += 1;
        },
      });

      await handle.start();
      await handle.stop();

      expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
      expect(readyCalls).toBe(1);
      expect(handle.state).toBe('stopped');
      expect(errorSpy).toHaveBeenCalledWith('[ProcessLifecycle:throwing-observer] observer threw', expect.any(Error));
    });

    it('hands a stop() from the stopping notification the stop in progress', async () => {
      let handleRef: ProcessLifecycleHandle | undefined;
      let nested: Promise<void> | undefined;
      const { handle } = track({
        spawn: nodeChild(READY_AND_STAY),
        onStateChange: (state) => {
          if (state === 'stopping') nested = handleRef?.stop();
        },
      });
      handleRef = handle;
      await handle.start();
      const transport = handle.transport!;

      const outer = handle.stop();
      expect(nested).toBe(outer);
      await nested;

      expect(handle.state).toBe('stopped');
      expect(transport.status).toBe('ended');
    });

    it('binds the completion of a stop to its own run when an observer starts and stops the next one', async () => {
      let handleRef: ProcessLifecycleHandle | undefined;
      let second: IJsonlTransport | undefined;
      const secondStatusAtStopped: string[] = [];
      let stoppedCount = 0;
      const { handle, states } = track({
        spawn: nodeChild(READY_AND_STAY),
        onStateChange: (state) => {
          if (state !== 'stopped') return;
          stoppedCount += 1;
          if (stoppedCount === 1) {
            handleRef?.start().catch(() => {});
            second = handleRef?.transport;
            void handleRef?.stop();
          } else if (second !== undefined) {
            secondStatusAtStopped.push(second.status);
          }
        },
      });
      handleRef = handle;
      await handle.start();

      await handle.stop();
      await waitFor(() => stoppedCount === 2);

      expect(states).toEqual(['starting', 'running', 'stopping', 'stopped', 'starting', 'stopping', 'stopped']);
      // The second run reached `stopped` only through its own end.
      expect(secondStatusAtStopped).toEqual(['ended']);
      expect(handle.generation).toBe(2);
    });
  });
});
