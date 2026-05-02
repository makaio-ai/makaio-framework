import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { TerminalManager } from '../terminal-manager.js';

/**
 * Create a fake child process that fails before spawn completes.
 * @returns Fake process plus teardown spies
 */
function makeFailedSpawnProcess() {
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

describe('TerminalManager cleanup', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('kills the child process when startup fails before spawn completes', async () => {
    const spawned = makeFailedSpawnProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => spawned.proc.emit('error', new Error('spawn failed')));
      return spawned.proc;
    });

    const manager = new TerminalManager();

    await expect(
      manager.createTerminal({
        command: 'node',
        args: ['-e', 'setInterval(() => {}, 1_000)'],
        outputByteLimit: 1024,
        env: [],
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('spawn failed');

    expect(spawned.destroyStdin).toHaveBeenCalled();
    expect(spawned.destroyStdout).toHaveBeenCalled();
    expect(spawned.destroyStderr).toHaveBeenCalled();
    expect(spawned.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
