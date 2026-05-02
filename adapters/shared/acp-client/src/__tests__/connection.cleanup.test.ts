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

describe('createAcpConnection cleanup', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
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

    await expect(
      createAcpConnection(
        () => ({
          sessionUpdate: async () => {},
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        }),
        {
          command: 'node',
          args: ['-e', 'setInterval(() => {}, 1_000)'],
          cwd: process.cwd(),
          env: { ...process.env } as Record<string, string>,
        },
      ),
    ).rejects.toThrow('bridge failed');

    expect(spawned.destroyStdin).toHaveBeenCalled();
    expect(spawned.destroyStdout).toHaveBeenCalled();
    expect(spawned.destroyStderr).toHaveBeenCalled();
    expect(spawned.kill).toHaveBeenCalledWith('SIGTERM');

    toWebSpy.mockRestore();
  });
});
