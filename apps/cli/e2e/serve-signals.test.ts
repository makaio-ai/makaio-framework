/**
 * E2E tests for the signal handling of `makaio serve`.
 *
 * Every test runs the real `serve` command in an isolated child process and
 * delivers real OS signals to it. The fixture extensions (see
 * `harness/serve-signal-entry.ts`) start a detached child through the shared
 * JSONL transport, which is the owner that stops it, and let the test slow
 * down or block the host's teardown. A test passes only when the host ended the
 * way the policy says and every child it started is gone; the harness kills
 * whatever a failing test leaves behind.
 */
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { processStopBudgetMs } from '@makaio/subprocess';
import { outerBoundMs } from '@makaio/utils';
import { isAlive, waitUntil } from '../../../e2e/shared/process-probe.js';
import {
  BOOT_HANG_ENV,
  DESTROY_DELAY_ENV,
  DESTROY_FAIL_ENV,
  DETACHED_NEVER_READY_HEALTH_ENV,
  SECOND_CHILD_ENV,
  SECOND_DESTROY_HANG_ENV,
  SECOND_STOP_BUDGET_ENV,
  SLOW_START_ENV,
  SLOW_START_FAIL_ENV,
  STUBBORN_KILL_GRACE_ENV,
} from './harness/serve-signal-env.js';
import { startSignalServe, type SignalServeHost, type SignalServeOptions } from './harness/signal-serve-process.js';

/** Time a host may take to boot. */
const BOOT_TIMEOUT_MS = 45_000;
/** Time the slowed teardown of the child extension takes. */
const SLOW_CLEANUP_MS = 3_000;
/** Pause that lets a second signal land while a slowed teardown is still running. */
const SIGNAL_GAP_MS = 500;

const hosts: SignalServeHost[] = [];

/**
 * Start a host, track it for cleanup, and wait until it reached a point in its output.
 * @param options - Host options.
 * @param until - Output that marks the point; defaults to the port announcement of a booted host.
 * @returns The host and the PID of the child its fixture extension started.
 */
async function bootHost(
  options: SignalServeOptions = {},
  until = 'MAKAIO_PORT=',
): Promise<{ host: SignalServeHost; childPid: number }> {
  const host = startSignalServe(options);
  hosts.push(host);
  await host.waitForOutput(until, BOOT_TIMEOUT_MS);
  const childPid = await host.waitForChildPid(5_000);
  expect(isAlive(childPid)).toBe(true);
  return { host, childPid };
}

/**
 * Read the port the host announced.
 * @param host - Booted host.
 * @returns The announced TCP port.
 */
function portOf(host: SignalServeHost): number {
  const match = /MAKAIO_PORT=(\d+)/.exec(host.output());
  expect(match).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

/**
 * Whether something accepts TCP connections on the loopback port.
 * @param port - Port to connect to.
 * @returns `true` when a connection was established.
 */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Assert the host ended cleanly and left no child behind.
 * @param host - Host under test.
 * @param childPid - PID of the child its fixture started.
 */
async function expectCleanEnd(host: SignalServeHost, childPid: number): Promise<void> {
  await expect(host.exited).resolves.toEqual({ code: 0, signal: null });
  await waitUntil(() => !isAlive(childPid), 2_000, `child ${childPid} to be gone`);
}

describe('serve signal handling', () => {
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  });

  it('keeps shutting down through a second SIGINT while a slow cleanup runs', async () => {
    const { host, childPid } = await bootHost({ env: { [DESTROY_DELAY_ENV]: String(SLOW_CLEANUP_MS) } });

    host.signal('SIGINT');
    await host.waitForOutput('[fixture] destroy begins', 10_000);
    host.signal('SIGINT');
    await delay(SIGNAL_GAP_MS);

    // The second Ctrl-C must neither end the host nor the child before the cleanup is done.
    expect(host.hasExited()).toBe(false);
    expect(isAlive(childPid)).toBe(true);
    await expectCleanEnd(host, childPid);
    expect(host.output()).toContain('SIGINT received; shutdown already in progress');
  });

  it('keeps shutting down when SIGTERM is followed by SIGINT and by repeats of both', async () => {
    const { host, childPid } = await bootHost({ env: { [DESTROY_DELAY_ENV]: String(SLOW_CLEANUP_MS) } });

    host.signal('SIGTERM');
    await host.waitForOutput('[fixture] destroy begins', 10_000);
    host.signal('SIGINT');
    // Each signal kind has now been delivered once; a handler that serves each
    // kind once would be gone for these.
    host.signal('SIGTERM');
    host.signal('SIGINT');
    await delay(SIGNAL_GAP_MS);

    expect(host.hasExited()).toBe(false);
    expect(isAlive(childPid)).toBe(true);
    await expectCleanEnd(host, childPid);
    expect(host.output()).toContain('SIGINT received; shutdown already in progress (requested by SIGTERM)');
  });

  it('cancels a boot that a signal interrupts and stops the children it already started', async () => {
    const { host, childPid } = await bootHost({ env: { [SLOW_START_ENV]: '4000' } }, '[fixture] slow start begins');

    host.signal('SIGTERM');

    await expectCleanEnd(host, childPid);
    expect(host.output()).toContain('[boot] Startup cancelled');
    expect(host.output()).not.toContain('MAKAIO_PORT=');
  });

  it('exits non-zero when the rollback of a cancelled boot fails', async () => {
    const { host, childPid } = await bootHost(
      { env: { [SLOW_START_ENV]: '4000', [DESTROY_FAIL_ENV]: '1' } },
      '[fixture] slow start begins',
    );

    host.signal('SIGTERM');

    await expect(host.exited).resolves.toEqual({ code: 1, signal: null });
    expect(host.output()).toContain('rolling back the started resources failed');
    expect(host.output()).toContain('fixture destroy failed');
    await waitUntil(() => !isAlive(childPid), 2_000, `child ${childPid} to be gone`);
  });

  it('keeps the signal handling until a failed boot has released the HTTP server', async () => {
    const { host } = await bootHost(
      { env: { [SLOW_START_ENV]: '1500', [SLOW_START_FAIL_ENV]: '1' } },
      '[fixture] slow start begins',
    );
    // A request that never completes keeps the HTTP server from closing, which
    // holds the cleanup of the failed boot open for as long as the test wants.
    const httpPort = /HTTP server listening on port (\d+)/.exec(host.output())?.[1];
    expect(httpPort).toBeDefined();
    const stalled = connect({ port: Number(httpPort), host: '127.0.0.1' });
    stalled.on('error', () => undefined);
    stalled.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
    await host.waitForOutput('[boot] Startup failed', 20_000);
    await delay(SIGNAL_GAP_MS);
    expect(host.hasExited()).toBe(false);

    host.signal('SIGTERM');
    await host.waitForOutput('SIGTERM received; shutdown already in progress', 10_000);
    await delay(SIGNAL_GAP_MS);
    expect(host.hasExited()).toBe(false);
    stalled.destroy();

    // The boot failure still ends the host with its own failure, not with the signal.
    await expect(host.exited).resolves.toEqual({ code: 1, signal: null });
  });

  it('shuts down on SIGHUP by default and stops the children', async () => {
    const { host, childPid } = await bootHost();

    host.signal('SIGHUP');

    await host.waitForOutput('SIGHUP received, shutting down', 10_000);
    await expectCleanEnd(host, childPid);
  });

  it('shuts down on SIGHUP by default when the launch ignored the hangup (nohup-style)', async () => {
    const { host, childPid } = await bootHost({ launchIgnoringHangup: true });

    host.signal('SIGHUP');

    await host.waitForOutput('SIGHUP received, shutting down', 10_000);
    await expectCleanEnd(host, childPid);
  });

  it('survives SIGHUP with --ignore-hangup, keeps serving and still stops cleanly on SIGTERM', async () => {
    const { host, childPid } = await bootHost({ args: ['--ignore-hangup'] });
    const port = portOf(host);

    host.signal('SIGHUP');
    await host.waitForOutput('SIGHUP received and ignored', 10_000);
    host.signal('SIGHUP');
    await delay(SIGNAL_GAP_MS);

    expect(host.hasExited()).toBe(false);
    expect(isAlive(childPid)).toBe(true);
    await expect(accepts(port)).resolves.toBe(true);
    expect(host.output()).not.toContain('shutting down');
    expect(host.output().match(/SIGHUP received and ignored/g)).toHaveLength(1);

    host.signal('SIGTERM');
    await expectCleanEnd(host, childPid);
  });

  it('survives SIGHUP with --ignore-hangup when the launch ignored the hangup too', async () => {
    const { host, childPid } = await bootHost({ args: ['--ignore-hangup'], launchIgnoringHangup: true });

    host.signal('SIGHUP');
    await host.waitForOutput('SIGHUP received and ignored', 10_000);
    await delay(SIGNAL_GAP_MS);
    expect(host.hasExited()).toBe(false);

    host.signal('SIGINT');
    await expectCleanEnd(host, childPid);
  });

  it('stops two extensions whose children ignore SIGTERM inside their own windows, without the host exiting early', async () => {
    // Each stop takes 7 s before it escalates to SIGKILL: together 14 s, which
    // is longer than the one window of a single bounded stop (12 s) but no
    // more than the two windows the extensions have between them.
    const { host, childPid } = await bootHost({
      env: { [SECOND_CHILD_ENV]: '1', [STUBBORN_KILL_GRACE_ENV]: '7000' },
    });
    await waitUntil(() => host.childPids().length === 2, 5_000, 'the second child to record its PID');
    const [, secondPid] = host.childPids();

    host.signal('SIGTERM');

    await expect(host.exited).resolves.toEqual({ code: 0, signal: null });
    expect(host.output()).not.toContain('did not finish');
    await waitUntil(() => !isAlive(childPid) && !isAlive(secondPid as number), 2_000, 'both children to be gone');
  }, 90_000);

  it('names an extension that never settles, runs out its window and still stops the extension before it', async () => {
    const stopBudgetMs = 1_500;
    const { host, childPid } = await bootHost({
      env: {
        [SECOND_CHILD_ENV]: '1',
        [SECOND_DESTROY_HANG_ENV]: '1',
        [SECOND_STOP_BUDGET_ENV]: String(stopBudgetMs),
      },
    });
    const startedAt = Date.now();

    host.signal('SIGTERM');

    // The stuck extension leaves its child running, so the host cannot end by itself: it ends itself.
    await expect(host.exited).resolves.toEqual({ code: 1, signal: null });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(stopBudgetMs - 500);
    // The coordinator holds the stop to the declared window plus the headroom of an outer bound.
    const enforcedMs = outerBoundMs(stopBudgetMs);
    expect(host.output()).toContain(
      `Extension "signal-fixture-child-two" did not finish stopping within ${enforcedMs} ms`,
    );
    expect(host.output()).toContain(`signal-fixture-child-two (not stopped within ${enforcedMs} ms)`);
    // The extension that stops after it was still reached.
    await waitUntil(() => !isAlive(childPid), 2_000, `child ${childPid} to be gone`);
  }, 60_000);

  it('aborts a detached extension start that is waiting for readiness, stops its child and exits well inside the health timeout', async () => {
    const healthTimeoutMs = 40_000;
    const host = startSignalServe({ env: { [DETACHED_NEVER_READY_HEALTH_ENV]: String(healthTimeoutMs) } });
    hosts.push(host);
    // The first child belongs to the extension that started before; the second is the detached one, whose start now waits.
    await waitUntil(() => host.childPids().length === 2, BOOT_TIMEOUT_MS, 'the detached child to record its PID');
    const pids = host.childPids();
    expect(pids.every(isAlive)).toBe(true);
    const signalledAt = Date.now();

    host.signal('SIGTERM');

    await expect(host.exited).resolves.toEqual({ code: 0, signal: null });
    // Without the cancellation the boot would have to run out the health timeout first.
    expect(Date.now() - signalledAt).toBeLessThan(15_000);
    expect(host.output()).toContain('[boot] Startup cancelled');
    expect(host.output()).not.toContain('MAKAIO_PORT=');
    await waitUntil(() => pids.every((pid) => !isAlive(pid)), 2_000, 'every child to be gone');
  }, 60_000);

  it('ends a host whose boot never reaches a checkpoint with status 1 inside the boot bound, naming the boot', async () => {
    const host = startSignalServe({ env: { [BOOT_HANG_ENV]: '1' } });
    hosts.push(host);
    await host.waitForOutput('[fixture] boot phase begins', BOOT_TIMEOUT_MS);
    const signalledAt = Date.now();

    host.signal('SIGTERM');
    // A second signal joins the shutdown: only the boot's own bound can end the host.
    await host.waitForOutput('SIGTERM received, shutting down', 10_000);
    host.signal('SIGTERM');

    await expect(host.exited).resolves.toEqual({ code: 1, signal: null });
    // Nothing is registered yet when the phase hangs, so the bound is the grace for the phase in flight.
    const graceMs = processStopBudgetMs();
    expect(host.output()).toContain(`runtime (did not settle within ${outerBoundMs(graceMs)} ms)`);
    const elapsedMs = Date.now() - signalledAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(graceMs - 500);
    expect(elapsedMs).toBeLessThan(outerBoundMs(graceMs) + 30_000);
    expect(host.output()).not.toContain('MAKAIO_PORT=');
  }, 90_000);
});
