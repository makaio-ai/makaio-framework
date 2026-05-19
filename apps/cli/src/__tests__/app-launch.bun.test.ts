/**
 * Unit tests for {@link launchAppAndWaitForBus}.
 *
 * All I/O is mocked: no real processes are spawned, no filesystem is accessed,
 * and no network connections are made. Timer behaviour is tested with bun
 * fake timers so tests complete in milliseconds.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { advanceTimersByTimeAsync } from '@makaio/test-utils';

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const childProcessMocks = {
  spawn: mock<(command: string, args: string[], options: object) => unknown>(),
};

const fsMocks = {
  existsSync: mock<(path: string) => boolean>(),
};

const busClientMocks = {
  probeHealth: mock<(url: string) => Promise<unknown>>(),
};

const openCommandMocks = {
  resolveLaunchTarget: mock<(platform: NodeJS.Platform) => string | null>(),
  shouldUseMacOpen: mock<(platform: NodeJS.Platform, candidate: string) => boolean>(),
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module('node:child_process', () => childProcessMocks);
mock.module('node:fs', () => fsMocks);
mock.module('../bus-client.js', () => busClientMocks);
mock.module('../open-command.js', () => openCommandMocks);

// ---------------------------------------------------------------------------
// Subject under test (imported after mocks are installed)
// ---------------------------------------------------------------------------

import { launchAppAndWaitForBus } from '../app-launch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal spawn return value that satisfies the usage inside app-launch.ts
 * (only `child.unref()` is called there).
 */
function makeMockChild() {
  return { unref: mock(), once: mock() };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('launchAppAndWaitForBus', () => {
  beforeEach(() => {
    mock.clearAllMocks();

    // Silence spinner writes to stderr for all tests by default.
    spyOn(process.stderr, 'write').mockReturnValue(true);

    // Default spawn mock — returns a valid child stub.
    childProcessMocks.spawn.mockReturnValue(makeMockChild());
  });

  afterEach(() => {
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // Early-exit: no launch target
  // -------------------------------------------------------------------------

  it('returns { health: null, launched: false } when resolveLaunchTarget returns null', async () => {
    openCommandMocks.resolveLaunchTarget.mockReturnValue(null);

    const result = await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(result).toEqual({ health: null, launched: false });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Early-exit: path does not exist on disk
  // -------------------------------------------------------------------------

  it('returns { health: null, launched: false } when the resolved path does not exist on disk', async () => {
    openCommandMocks.resolveLaunchTarget.mockReturnValue('/Applications/Makaio.app');
    fsMocks.existsSync.mockReturnValue(false);

    const result = await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(result).toEqual({ health: null, launched: false });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // macOS .app bundle launch
  // -------------------------------------------------------------------------

  it('spawns `open` with [appPath, --args, --background] for a macOS .app bundle', async () => {
    const appPath = '/Applications/Makaio.app';
    openCommandMocks.resolveLaunchTarget.mockReturnValue(appPath);
    fsMocks.existsSync.mockReturnValue(true);
    openCommandMocks.shouldUseMacOpen.mockReturnValue(true);
    // Resolve on first poll so the function exits quickly.
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });

    await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith('open', [appPath, '--args', '--background'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('unrefs the spawned child after a macOS .app launch', async () => {
    const child = makeMockChild();
    openCommandMocks.resolveLaunchTarget.mockReturnValue('/Applications/Makaio.app');
    fsMocks.existsSync.mockReturnValue(true);
    openCommandMocks.shouldUseMacOpen.mockReturnValue(true);
    childProcessMocks.spawn.mockReturnValue(child);
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });

    await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Non-macOS / direct executable launch
  // -------------------------------------------------------------------------

  it('spawns the appPath directly with [--background] for a non-macOS target', async () => {
    const appPath = '/usr/bin/makaio';
    openCommandMocks.resolveLaunchTarget.mockReturnValue(appPath);
    fsMocks.existsSync.mockReturnValue(true);
    openCommandMocks.shouldUseMacOpen.mockReturnValue(false);
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });

    await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(appPath, ['--background'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('unrefs the spawned child after a direct executable launch', async () => {
    const child = makeMockChild();
    openCommandMocks.resolveLaunchTarget.mockReturnValue('/usr/bin/makaio');
    fsMocks.existsSync.mockReturnValue(true);
    openCommandMocks.shouldUseMacOpen.mockReturnValue(false);
    childProcessMocks.spawn.mockReturnValue(child);
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });

    await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Health polling — success
  // -------------------------------------------------------------------------

  it('returns the health result from probeHealth when the bus becomes ready', async () => {
    openCommandMocks.resolveLaunchTarget.mockReturnValue('/usr/bin/makaio');
    fsMocks.existsSync.mockReturnValue(true);
    openCommandMocks.shouldUseMacOpen.mockReturnValue(false);
    busClientMocks.probeHealth.mockResolvedValue({ auth: true });

    const result = await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(result).toEqual({ health: { auth: true }, launched: true });
  });

  it('retries probeHealth until it returns a non-null result', async () => {
    openCommandMocks.resolveLaunchTarget.mockReturnValue('/usr/bin/makaio');
    fsMocks.existsSync.mockReturnValue(true);
    openCommandMocks.shouldUseMacOpen.mockReturnValue(false);
    // Fail twice, then succeed on the third call.
    busClientMocks.probeHealth
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ auth: false });

    const result = await launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

    expect(result).toEqual({ health: { auth: false }, launched: true });
    expect(busClientMocks.probeHealth).toHaveBeenCalledTimes(3);
  });

  it('passes the busUrl argument to probeHealth', async () => {
    const busUrl = 'ws://127.0.0.1:9999/bus';
    openCommandMocks.resolveLaunchTarget.mockReturnValue('/usr/bin/makaio');
    fsMocks.existsSync.mockReturnValue(true);
    openCommandMocks.shouldUseMacOpen.mockReturnValue(false);
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });

    await launchAppAndWaitForBus(busUrl);

    expect(busClientMocks.probeHealth).toHaveBeenCalledWith(busUrl);
  });

  // -------------------------------------------------------------------------
  // Timeout — bus never becomes ready
  // -------------------------------------------------------------------------

  it('returns { health: null, launched: true } when the bus does not become ready within the timeout', async () => {
    jest.useFakeTimers();
    try {
      openCommandMocks.resolveLaunchTarget.mockReturnValue('/usr/bin/makaio');
      fsMocks.existsSync.mockReturnValue(true);
      openCommandMocks.shouldUseMacOpen.mockReturnValue(false);
      // probeHealth never succeeds.
      busClientMocks.probeHealth.mockResolvedValue(null);

      const promise = launchAppAndWaitForBus('ws://127.0.0.1:6252/bus');

      // Advance past the 15-second launch timeout.  advanceTimersByTimeAsync
      // fires pending timer callbacks (the poll-interval setTimeouts and the
      // spinner setInterval) and flushes microtasks between each tick, allowing
      // the while-loop to drain naturally.
      await advanceTimersByTimeAsync(15_001);

      const result = await promise;
      expect(result).toEqual({ health: null, launched: true });
    } finally {
      jest.useRealTimers();
    }
  });
});
