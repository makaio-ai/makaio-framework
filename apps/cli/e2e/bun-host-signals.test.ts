/**
 * E2E tests for the signal handling of the Bun hosts (the composition roots of
 * the product server, relay and GitHub App).
 *
 * Every test runs a Bun host (`harness/bun-host-signal-entry.ts`, composed the
 * way the product Bun apps are) in an isolated child process on Bun and delivers
 * real OS signals to it. A test passes only when the host ended the way the
 * policy says and every child it started is gone; the harness kills whatever a
 * failing test leaves behind.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { processStopBudgetMs } from '@makaio/subprocess';
import { outerBoundMs } from '@makaio/utils';
import { isAlive, waitUntil } from '../../../e2e/shared/process-probe.js';
import {
  BOOT_HANG_ENV,
  DESTROY_DELAY_ENV,
  SECOND_CHILD_ENV,
  SECOND_DESTROY_HANG_ENV,
  SECOND_STOP_BUDGET_ENV,
  SLOW_START_ENV,
  SLOW_START_FAIL_ENV,
} from './harness/serve-signal-env.js';
import {
  BOOT_TIMEOUT_MS,
  SIGNAL_GAP_MS,
  SLOW_CLEANUP_MS,
  expectEndWithoutChild,
} from './harness/signal-host-assertions.js';
import { startSignalServe, type SignalServeHost, type SignalServeOptions } from './harness/signal-serve-process.js';

const hosts: SignalServeHost[] = [];

/**
 * Start a Bun host, track it for cleanup, and wait until it reached a point in its output.
 * @param options - Host options.
 * @param until - Output that marks the point; defaults to the port announcement of a booted host.
 * @returns The host and the PID of the child its fixture extension started.
 */
async function bootHost(
  options: SignalServeOptions = {},
  until: string | RegExp = 'MAKAIO_PORT=',
): Promise<{ host: SignalServeHost; childPid: number }> {
  const host = startSignalServe({ ...options, kind: 'bun-host' });
  hosts.push(host);
  await host.waitForOutput(until, BOOT_TIMEOUT_MS);
  const childPid = await host.waitForChildPid(5_000);
  expect(isAlive(childPid)).toBe(true);
  return { host, childPid };
}

describe('Bun host signal handling', () => {
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  });

  it('keeps shutting down through a second signal while a slow cleanup runs, then exits cleanly', async () => {
    const { host, childPid } = await bootHost({ env: { [DESTROY_DELAY_ENV]: String(SLOW_CLEANUP_MS) } });

    host.signal('SIGTERM');
    await host.waitForOutput('[fixture] destroy begins', 10_000);
    host.signal('SIGTERM');
    host.signal('SIGINT');
    await delay(SIGNAL_GAP_MS);

    // The further signals must neither end the host nor the child before the cleanup is done.
    expect(host.hasExited()).toBe(false);
    expect(isAlive(childPid)).toBe(true);
    await expectEndWithoutChild(host, childPid);
    expect(host.output()).toContain('SIGTERM received; shutdown already in progress');
  });

  it('cancels a boot a signal interrupts, stops the child it already started and exits cleanly', async () => {
    const { host, childPid } = await bootHost({ env: { [SLOW_START_ENV]: '4000' } }, '[fixture] slow start begins');

    host.signal('SIGTERM');

    await expectEndWithoutChild(host, childPid);
    expect(host.output()).toContain('[boot] Startup cancelled');
    expect(host.output()).not.toContain('MAKAIO_PORT=');
  });

  it('exits with status 1, not 0, when the boot fails on its own', async () => {
    const { host, childPid } = await bootHost(
      { env: { [SLOW_START_ENV]: '500', [SLOW_START_FAIL_ENV]: '1' } },
      '[fixture] slow start begins',
    );

    await expect(host.exited).resolves.toMatchObject({ code: 1 });
    expect(host.output()).toContain('[boot] Startup failed');
    expect(host.output()).not.toContain('MAKAIO_PORT=');
    await waitUntil(() => !isAlive(childPid), 2_000, `child ${childPid} to be gone`);
  });

  it('shuts down on SIGHUP by default and stops the children', async () => {
    const { host, childPid } = await bootHost();

    host.signal('SIGHUP');

    await host.waitForOutput('SIGHUP received, shutting down', 10_000);
    await expectEndWithoutChild(host, childPid);
  });

  it('shuts down on SIGHUP when the launch ignored the hangup (nohup-style)', async () => {
    const { host, childPid } = await bootHost({ launchIgnoringHangup: true });

    host.signal('SIGHUP');

    await host.waitForOutput('SIGHUP received, shutting down', 10_000);
    await expectEndWithoutChild(host, childPid);
  });

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
    const enforcedMs = outerBoundMs(stopBudgetMs);
    expect(host.output()).toContain(
      `Extension "signal-fixture-child-two" did not finish stopping within ${enforcedMs} ms`,
    );
    await waitUntil(() => !isAlive(childPid), 2_000, `child ${childPid} to be gone`);
  }, 60_000);

  it('ends a host whose boot never reaches a checkpoint with status 1 inside the boot bound, naming the runtime', async () => {
    const host = startSignalServe({ kind: 'bun-host', env: { [BOOT_HANG_ENV]: '1' } });
    hosts.push(host);
    await host.waitForOutput('[fixture] boot phase begins', BOOT_TIMEOUT_MS);
    const signalledAt = Date.now();

    host.signal('SIGTERM');
    // A second signal joins the shutdown: only the boot's own bound can end the host.
    await host.waitForOutput('SIGTERM received, shutting down', 10_000);
    host.signal('SIGTERM');

    await expect(host.exited).resolves.toEqual({ code: 1, signal: null });
    const graceMs = processStopBudgetMs();
    expect(host.output()).toContain(`runtime (did not settle within ${outerBoundMs(graceMs)} ms)`);
    const elapsedMs = Date.now() - signalledAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(graceMs - 500);
    expect(elapsedMs).toBeLessThan(outerBoundMs(graceMs) + 30_000);
  }, 90_000);
});
