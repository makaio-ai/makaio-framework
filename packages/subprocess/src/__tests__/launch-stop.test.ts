import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { launch, type LaunchOptions } from '../launch.js';
import type { ProcessSignalPort } from '../process-tree.js';
import { denyingPort, IGNORE_SIGTERM_AND_STAY, isAlive } from './fixtures/jsonl-children.js';

/**
 * The bounded stop of `launch`, driven with small explicit timings against real
 * child processes. The signal port is injected only to refuse signals (a real
 * host cannot be made to on demand) or to record them.
 */

const isPosix = process.platform !== 'win32';
const FIXTURE = fileURLToPath(new URL('./fixtures/launch-unobserved-exit.fixture.ts', import.meta.url));
const STAY = 'setInterval(() => {}, 1000)';

/** Leaders left behind by a test; their groups are removed afterwards. */
const leftovers: number[] = [];

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

/**
 * Options of a command with small stop timings.
 * @param script - Source the child runs with `node -e`.
 * @param extra - Options that override the defaults.
 * @returns The options.
 */
function options(script: string, extra: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    envMode: 'merge',
    timeoutMs: 10_000,
    killGraceMs: 100,
    exitObservationMs: 100,
    quiescenceProofTimeoutMs: 300,
    output: { kind: 'ignore' },
    ...extra,
  };
}

/** A port that forwards to the host and records every call. */
function recordingPort(): ProcessSignalPort & { readonly calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> } {
  const calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  return {
    calls,
    kill: (pid, signal) => {
      calls.push({ pid, signal });
      process.kill(pid, signal);
    },
  };
}

describe.runIf(isPosix)('launch stop phases', () => {
  it('never counts a denied signal as delivered and ends as stop-failed with an unobserved exit', async () => {
    const launched = launch(options(STAY, { timeoutMs: 100, signalPort: denyingPort() }));
    if (launched.pid !== undefined) leftovers.push(launched.pid);

    const result = await launched.result;

    expect(result.status).toBe('stop-failed');
    expect(result.exit).toEqual({ kind: 'unobserved', reason: 'signal-denied' });
    expect(result.group?.signalDelivered).toBe(false);
    expect(result.group?.tree.kind).toBe('unproven');
    expect(launched.pid !== undefined && isAlive(launched.pid)).toBe(true);
  });

  it('sends no signal once the leader has closed, and only probes the group afterwards', async () => {
    const port = recordingPort();
    // The leader exits 0 and leaves a member in its group, so the proof keeps probing after the close.
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(STAY)}], { stdio: 'ignore' }).unref();`;

    const launched = launch(options(script, { signalPort: port }));
    if (launched.pid !== undefined) leftovers.push(launched.pid);
    const result = await launched.result;

    expect(result.status).toBe('stop-failed');
    expect(result.exit).toMatchObject({ kind: 'exited', code: 0 });
    expect(result.group?.tree.kind).toBe('unproven');
    expect(result.group?.signalDelivered).toBe(false);
    expect(port.calls.length).toBeGreaterThan(0);
    expect(port.calls.every((call) => call.signal === 0)).toBe(true);
  });

  it('sends no signal after a run that ended on its own', async () => {
    const port = recordingPort();
    const controller = new AbortController();

    const result = await launch(options('process.exit(0)', { signalPort: port, signal: controller.signal })).result;
    controller.abort();

    expect(result.status).toBe('completed');
    expect(port.calls.filter((call) => call.signal !== 0)).toEqual([]);
  });

  it('reports the abort when it came first and the timeout fires during the stop', async () => {
    const controller = new AbortController();
    const launched = launch(
      options(IGNORE_SIGTERM_AND_STAY, { signal: controller.signal, timeoutMs: 300, killGraceMs: 800 }),
    );
    if (launched.pid !== undefined) leftovers.push(launched.pid);
    setTimeout(() => controller.abort(), 100);

    const result = await launched.result;

    expect(result.status).toBe('cancelled');
    expect(result.group?.tree.kind).toBe('quiescent');
  });

  it('reports the timeout when it came first and the abort comes during the stop', async () => {
    const controller = new AbortController();
    const launched = launch(
      options(IGNORE_SIGTERM_AND_STAY, { signal: controller.signal, timeoutMs: 100, killGraceMs: 800 }),
    );
    if (launched.pid !== undefined) leftovers.push(launched.pid);
    setTimeout(() => controller.abort(), 300);

    const result = await launched.result;

    expect(result.status).toBe('timed-out');
    expect(result.group?.tree.kind).toBe('quiescent');
  });

  it('does not keep the host process alive after an unobserved exit', async () => {
    const host = spawn(process.execPath, ['--import', 'tsx', FIXTURE], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const hostEnded = once(host, 'exit');
    const bound = setTimeout(() => host.kill('SIGKILL'), 15_000);

    const [code, signal] = await hostEnded;
    clearTimeout(bound);

    const report = JSON.parse(stdout.trim()) as { status: string; exitKind: string; pid: number };
    leftovers.push(report.pid);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(report.status).toBe('stop-failed');
    expect(report.exitKind).toBe('unobserved');
    expect(isAlive(report.pid)).toBe(true);
  }, 20_000);
});
