/**
 * E2E tests for the signal handling of CLI commands that boot a runtime of
 * their own (`provideBus`, as `makaio workflow ...` does).
 *
 * Every test runs the real CLI router in an isolated child process
 * (`harness/command-signal-entry.ts`) with a fixture command whose embedded
 * runtime is the real provider of the workflow extension, and delivers real OS
 * signals to it. A test passes only when the command ended the way the policy
 * says (the conventional signal exit code, or status 1 when a bound ended it)
 * and every child the runtime started is gone.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { processStopBudgetMs } from '@makaio/subprocess';
import { outerBoundMs } from '@makaio/utils';
import { isAlive } from '../../../e2e/shared/process-probe.js';
import {
  BOOT_HANG_ENV,
  COMMAND_IGNORES_ABORT_ENV,
  DESTROY_DELAY_ENV,
  SLOW_START_ENV,
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
 * Start the fixture command, track it for cleanup, and wait until it reached a point in its output.
 * @param options - Host options.
 * @param until - Output that marks the point; defaults to the handler running.
 * @returns The host and the PID of the child its runtime started.
 */
async function startCommand(
  options: SignalServeOptions = {},
  until: string | RegExp = '[fixture] command running',
): Promise<{ host: SignalServeHost; childPid: number }> {
  const host = startSignalServe({ ...options, kind: 'command' });
  hosts.push(host);
  await host.waitForOutput(until, BOOT_TIMEOUT_MS);
  const childPid = await host.waitForChildPid(5_000);
  expect(isAlive(childPid)).toBe(true);
  return { host, childPid };
}

describe('CLI command signal handling', () => {
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  });

  it('aborts the handler, disposes the embedded runtime and exits with the signal exit code', async () => {
    const { host, childPid } = await startCommand();

    host.signal('SIGINT');

    await expectEndWithoutChild(host, childPid, { code: 130, signal: null });
    expect(host.output()).toContain('[fixture] command observed abort: SIGINT');
    expect(host.output()).not.toContain('Command failed');
  });

  it('keeps shutting down through a second signal while the runtime is still being disposed', async () => {
    const { host, childPid } = await startCommand({ env: { [DESTROY_DELAY_ENV]: String(SLOW_CLEANUP_MS) } });

    host.signal('SIGINT');
    await host.waitForOutput('[fixture] destroy begins', 10_000);
    host.signal('SIGINT');
    host.signal('SIGTERM');
    await delay(SIGNAL_GAP_MS);

    // Before, the first signal gave the default action back: this one would have ended the command mid-dispose.
    expect(host.hasExited()).toBe(false);
    expect(isAlive(childPid)).toBe(true);
    await expectEndWithoutChild(host, childPid, { code: 130, signal: null });
    expect(host.output()).toContain('SIGINT received; shutdown already in progress');
  });

  it('stops on SIGHUP like on the other signals', async () => {
    const { host, childPid } = await startCommand();

    host.signal('SIGHUP');

    await expectEndWithoutChild(host, childPid, { code: 129, signal: null });
  });

  it('cancels the runtime boot a signal interrupts and stops the child it already started', async () => {
    const { host, childPid } = await startCommand({ env: { [SLOW_START_ENV]: '4000' } }, '[fixture] slow start begins');

    host.signal('SIGTERM');

    await expectEndWithoutChild(host, childPid, { code: 143, signal: null });
    expect(host.output()).toContain('[boot] Startup cancelled');
    expect(host.output()).not.toContain('[fixture] command running');
    expect(host.output()).not.toContain('Command failed');
  });

  it('ends a command whose boot never reaches a checkpoint with status 1 inside the boot bound, naming the runtime', async () => {
    const host = startSignalServe({ kind: 'command', env: { [BOOT_HANG_ENV]: '1' } });
    hosts.push(host);
    await host.waitForOutput('[fixture] boot phase begins', BOOT_TIMEOUT_MS);
    const signalledAt = Date.now();

    host.signal('SIGTERM');
    await host.waitForOutput('SIGTERM received, shutting down', 10_000);
    host.signal('SIGTERM');

    await expect(host.exited).resolves.toEqual({ code: 1, signal: null });
    // Nothing is registered yet when the phase hangs, so the bound is the grace for the phase in flight.
    const graceMs = processStopBudgetMs();
    expect(host.output()).toContain(`embedded runtime (did not settle within ${outerBoundMs(graceMs)} ms)`);
    // No handler had started, so there was none to wind down.
    expect(host.output()).not.toContain('command (did not settle');
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(graceMs - 500);
  }, 90_000);

  it('ends a command whose handler ignores the abort inside the wind-down window, and still stops its runtime', async () => {
    const { host, childPid } = await startCommand({ env: { [COMMAND_IGNORES_ABORT_ENV]: '1' } });
    const signalledAt = Date.now();

    host.signal('SIGINT');
    await host.waitForOutput('SIGINT received, shutting down', 10_000);
    host.signal('SIGINT');
    await delay(SIGNAL_GAP_MS);
    // A further Ctrl-C joins the shutdown; only the wind-down window ends the command.
    expect(host.hasExited()).toBe(false);

    await expectEndWithoutChild(host, childPid, { code: 1, signal: null });
    const windowMs = outerBoundMs(processStopBudgetMs());
    expect(host.output()).toContain(`command (did not settle within ${windowMs} ms)`);
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(windowMs - 500);
    // The runtime was stopped by the shutdown itself: the handler never returned to dispose it.
    expect(host.output()).toContain('[fixture] destroy begins');
    expect(host.output()).not.toContain('[fixture] command observed abort');
  }, 90_000);
});
