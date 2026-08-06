import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { createAcpConnection } from '../connection.js';

/**
 * Build a fake spawned process for connection setup tests.
 * @returns Fake child process plus spies for teardown assertions
 */
function makeSpawnedProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as ReturnType<typeof mockSpawn> & EventEmitter;
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    proc.emit('exit', signal === 'SIGTERM' ? null : 0);
    return true;
  });

  Object.assign(proc, { stdin, stdout, stderr, kill });

  return {
    proc,
    kill,
    destroyStdin: vi.spyOn(stdin, 'destroy'),
    destroyStdout: vi.spyOn(stdout, 'destroy'),
    destroyStderr: vi.spyOn(stderr, 'destroy'),
  };
}

/**
 * Start a connection over the faked spawn.
 * @param options - Spawn options under test, merged over the defaults.
 * @returns The pending connection.
 */
function connect(options: { spawnTimeoutMs?: number; signal?: AbortSignal } = {}) {
  return createAcpConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    }),
    {
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      spawnTimeoutMs: options.spawnTimeoutMs ?? 10_000,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

describe('createAcpConnection cleanup', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // The spawn-wait failure paths: on both of them the child is *already spawning*
  // and nothing else can reach it. `waitForSpawn` has removed its own listeners and
  // the caller never receives a handle — so a process that starts after the wait
  // gave up would run with nobody holding anything to kill it, and no later
  // teardown could book or report it.
  it('kills the spawned process when the start budget expires', async () => {
    const spawned = makeSpawnedProcess();
    // A child that never announces a start: no `spawn`, no `error`, just silence.
    mockSpawn.mockImplementation(() => spawned.proc);

    await expect(connect({ spawnTimeoutMs: 25 })).rejects.toThrow(/did not start within/);

    expect(spawned.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawned.destroyStdin).toHaveBeenCalled();
  });

  it('kills the spawned process when the start is abandoned before its budget', async () => {
    const spawned = makeSpawnedProcess();
    mockSpawn.mockImplementation(() => spawned.proc);
    const controller = new AbortController();

    const connecting = connect({ signal: controller.signal });
    controller.abort();

    await expect(connecting).rejects.toThrow(/aborted/);
    expect(spawned.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // Not a cleanup arm, but the same harness answers the question no real child can
  // ask: whether the exit observation is installed *before* the spawn wait or merely
  // happens to be installed in the same turn as it. A real process always dies at
  // least one event-loop iteration after announcing its start, so the ordering is
  // invisible to it; a child that delivers both events in one turn makes the
  // difference decisive — and that is exactly the guarantee a retirement awaiting
  // this promise depends on, rather than one it inherits from scheduling.
  it('settles the exit observation for a child whose exit arrives in the spawn turn', async () => {
    const spawned = makeSpawnedProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        spawned.proc.emit('spawn');
        spawned.proc.emit('exit', 7);
      });
      return spawned.proc;
    });

    const handle = await connect();

    await expect(handle.exited).resolves.toBe(7);
  });

  it('kills the spawned process when stream bridging fails after spawn', async () => {
    const spawned = makeSpawnedProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => spawned.proc.emit('spawn'));
      return spawned.proc;
    });
    const toWebSpy = vi.spyOn(Readable, 'toWeb').mockImplementation(() => {
      throw new Error('bridge failed');
    });

    await expect(connect()).rejects.toThrow('bridge failed');

    expect(spawned.destroyStdin).toHaveBeenCalled();
    expect(spawned.destroyStdout).toHaveBeenCalled();
    expect(spawned.destroyStderr).toHaveBeenCalled();
    expect(spawned.kill).toHaveBeenCalledWith('SIGTERM');

    toWebSpy.mockRestore();
  });
});
