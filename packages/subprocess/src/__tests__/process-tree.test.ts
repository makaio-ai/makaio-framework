import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  proveProcessGroupQuiescence,
  signalOwnedProcesses,
  spawnOptionsForOwnership,
  terminateWindowsProcessTree,
} from '../process-tree.js';
import type { ProcessSignalPort } from '../process-tree.js';

const isPosix = process.platform !== 'win32';

/** Process groups started by a test; any survivor is killed after it. */
const startedGroups: number[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of startedGroups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group already ended, which is what every passing test leaves behind.
    }
  }
});

/**
 * Spawn a Node program as the leader of its own process group, with stdout piped
 * so the program can report process IDs.
 * @param source - Inline Node program for the group leader.
 * @returns The spawned leader.
 */
function spawnGroupLeader(source: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', source], {
    ...spawnOptionsForOwnership('process-group'),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (child.pid !== undefined) startedGroups.push(child.pid);
  return child;
}

/**
 * Read the first stdout line of a child as a process ID.
 * @param child - Child that writes a process ID as its first line.
 * @returns The reported process ID.
 */
async function firstReportedPid(child: ChildProcess): Promise<number> {
  if (child.stdout === null) throw new Error('child has no stdout pipe');
  const lines = createInterface({ input: child.stdout });
  const [line] = (await once(lines, 'line')) as [string];
  lines.close();
  return Number(line);
}

/**
 * Read the process group of a process from the host process table.
 * @param pid - Process to look up.
 * @returns Its process-group ID.
 */
function processGroupOf(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

/**
 * Whether a process still runs. A zombie has ended and only waits to be reaped.
 * @param pid - Process to look up.
 * @returns True while the process exists and is not a zombie.
 */
function isRunning(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state !== '' && !state.startsWith('Z');
  } catch {
    // ps exits non-zero when the process does not exist at all.
    return false;
  }
}

/**
 * A signal port that answers every signal with the given errno error.
 * @param code - Errno code to throw.
 * @returns The port and the calls it received.
 */
function failingPort(code: string): { readonly port: ProcessSignalPort; readonly calls: [number, string | 0][] } {
  const calls: [number, string | 0][] = [];
  return {
    calls,
    port: {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        throw Object.assign(new Error(`kill failed with ${code}`), { code });
      },
    },
  };
}

/** A leader whose grandchild ignores SIGTERM and reports its PID through the inherited stdout. */
const LEADER_WITH_STUBBORN_GRANDCHILD = `
const grandchild = ${JSON.stringify("process.on('SIGTERM',()=>{});process.stdout.write(process.pid+'\\n');setInterval(()=>{},100)")};
require('child_process').spawn(process.execPath, ['-e', grandchild], { stdio: ['ignore', 'inherit', 'ignore'] });
setInterval(() => {}, 100);
`;

describe('spawnOptionsForOwnership', () => {
  it('keeps a directly owned child in the host process group', () => {
    expect(spawnOptionsForOwnership('direct-child')).toEqual({ detached: false });
  });

  it('isolates an owned process group on POSIX only', () => {
    // Windows addresses a tree through parent links; `detached` there would only add a console.
    expect(spawnOptionsForOwnership('process-group')).toEqual({ detached: isPosix });
  });
});

describe('signalOwnedProcesses', () => {
  it.each([0, 1, -5, 1.5, Number.NaN])('refuses %s, which would address the host itself or every process', (pid) => {
    const { port, calls } = failingPort('ESRCH');
    expect(() => signalOwnedProcesses('process-group', pid, 'SIGKILL', port)).toThrow(RangeError);
    expect(() => signalOwnedProcesses('direct-child', pid, 'SIGKILL', port)).toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it('classifies ESRCH as absent and EPERM as denied, and throws any other error', () => {
    expect(signalOwnedProcesses('direct-child', 4242, 'SIGTERM', failingPort('ESRCH').port)).toBe('absent');
    expect(signalOwnedProcesses('direct-child', 4242, 'SIGTERM', failingPort('EPERM').port)).toBe('denied');
    expect(() => signalOwnedProcesses('direct-child', 4242, 'SIGTERM', failingPort('EINVAL').port)).toThrow(
      'kill failed with EINVAL',
    );
  });

  it.runIf(isPosix)('addresses the group through the negated leader PID and the child through its own PID', () => {
    const group = failingPort('ESRCH');
    const direct = failingPort('EPERM');
    expect(signalOwnedProcesses('process-group', 4242, 'SIGTERM', group.port)).toBe('absent');
    expect(signalOwnedProcesses('direct-child', 4242, 'SIGKILL', direct.port)).toBe('denied');
    expect(group.calls).toEqual([[-4242, 'SIGTERM']]);
    expect(direct.calls).toEqual([[4242, 'SIGKILL']]);
  });

  it.runIf(isPosix)('spawns an owned child as the leader of its own process group', async () => {
    const child = spawnGroupLeader("process.stdout.write(process.pid+'\\n');setInterval(()=>{},100)");
    const pid = await firstReportedPid(child);
    expect(pid).toBe(child.pid);
    expect(processGroupOf(pid)).toBe(pid);
    expect(processGroupOf(pid)).not.toBe(processGroupOf(process.pid));
  });

  it.runIf(isPosix)('delivers a signal to a live group', async () => {
    const child = spawnGroupLeader("process.stdout.write(process.pid+'\\n');setInterval(()=>{},100)");
    await firstReportedPid(child);
    const exited = once(child, 'exit');
    expect(signalOwnedProcesses('process-group', child.pid!, 'SIGTERM')).toBe('delivered');
    expect(await exited).toEqual([null, 'SIGTERM']);
  });

  it.runIf(isPosix)('reports a group that is already gone as absent', async () => {
    const child = spawnGroupLeader('process.exit(0)');
    // `exit` is emitted once the child was reaped, so no member of its group remains.
    await once(child, 'exit');
    expect(signalOwnedProcesses('process-group', child.pid!, 'SIGKILL')).toBe('absent');
    expect(signalOwnedProcesses('direct-child', child.pid!, 'SIGKILL')).toBe('absent');
  });

  it.runIf(isPosix)('reports a denied signal through an injected port while the real group keeps running', async () => {
    const child = spawnGroupLeader("process.stdout.write(process.pid+'\\n');setInterval(()=>{},100)");
    const pid = await firstReportedPid(child);
    const denied = failingPort('EPERM');
    expect(signalOwnedProcesses('process-group', pid, 'SIGKILL', denied.port)).toBe('denied');
    expect(denied.calls).toEqual([[-pid, 'SIGKILL']]);
    expect(isRunning(pid)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('refuses process-group signals on Windows', () => {
    expect(() => signalOwnedProcesses('process-group', 4242, 'SIGTERM')).toThrow('POSIX');
  });
});

describe('proveProcessGroupQuiescence', () => {
  it.runIf(isPosix)('proves a group quiescent once SIGKILL reached a grandchild that ignores SIGTERM', async () => {
    const leader = spawnGroupLeader(LEADER_WITH_STUBBORN_GRANDCHILD);
    const grandchild = await firstReportedPid(leader);
    expect(processGroupOf(grandchild)).toBe(leader.pid);

    const leaderExited = once(leader, 'exit');
    expect(signalOwnedProcesses('process-group', leader.pid!, 'SIGTERM')).toBe('delivered');
    expect(await leaderExited).toEqual([null, 'SIGTERM']);
    await delay(100);
    // The leader is gone, yet its group lives on in the grandchild: a child exit proves no quiescence.
    expect(isRunning(grandchild)).toBe(true);
    expect(await proveProcessGroupQuiescence(leader.pid!, { timeoutMs: 150 })).toEqual({
      kind: 'unproven',
      reason: 'poll-timeout',
    });

    expect(signalOwnedProcesses('process-group', leader.pid!, 'SIGKILL')).toBe('delivered');
    expect(await proveProcessGroupQuiescence(leader.pid!, { timeoutMs: 2_000 })).toEqual({ kind: 'quiescent' });
    expect(isRunning(grandchild)).toBe(false);
  });

  it.runIf(isPosix)('proves a group quiescent at once when no member is left', async () => {
    const child = spawnGroupLeader('process.exit(0)');
    await once(child, 'exit');
    expect(await proveProcessGroupQuiescence(child.pid!, { timeoutMs: 1_000 })).toEqual({ kind: 'quiescent' });
  });

  it.runIf(isPosix)('counts a group whose only members are zombies as quiescent', async () => {
    // Real zombies need a parent that never reaps them. The leader forks a
    // keeper, the keeper forks a child that exits at once and is never reaped,
    // then the keeper moves to a group of its own and the leader exits. Group
    // `leader` is then left with that one zombie.
    const script = [
      'my $keeper = fork();',
      'if ($keeper == 0) {',
      '  my $zombie = fork();',
      '  if ($zombie == 0) { exit 0; }',
      '  setpgrp(0, 0);',
      '  print "$zombie $$\\n";',
      '  close STDOUT;',
      '  sleep 30;',
      '  exit 0;',
      '}',
      'exit 0;',
    ].join('\n');
    const leader = spawn('perl', ['-e', script], {
      ...spawnOptionsForOwnership('process-group'),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const leaderExited = once(leader, 'exit');
    if (leader.stdout === null) throw new Error('perl has no stdout pipe');
    const lines = createInterface({ input: leader.stdout });
    const [line] = (await once(lines, 'line')) as [string];
    lines.close();
    const [zombie, keeper] = line.split(' ').map(Number) as [number, number];
    startedGroups.push(keeper);
    await leaderExited;

    const zombieState = execFileSync('ps', ['-o', 'pgid=,stat=', '-p', String(zombie)], { encoding: 'utf8' });
    expect(zombieState.trim().split(/\s+/)).toEqual([String(leader.pid), expect.stringMatching(/^Z/)]);
    expect(await proveProcessGroupQuiescence(leader.pid!, { timeoutMs: 1_000 })).toEqual({ kind: 'quiescent' });
  });

  it.runIf(isPosix)('stays unproven with ps-unavailable when no ps is on the PATH', async () => {
    const child = spawnGroupLeader("process.stdout.write(process.pid+'\\n');setInterval(()=>{},100)");
    const pid = await firstReportedPid(child);
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'no-ps-'));
    try {
      vi.stubEnv('PATH', emptyPath);
      expect(await proveProcessGroupQuiescence(pid, { timeoutMs: 300 })).toEqual({
        kind: 'unproven',
        reason: 'ps-unavailable',
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(emptyPath, { recursive: true, force: true });
    }
    expect(isRunning(pid)).toBe(true);
  });

  it.runIf(isPosix)('ends early when its signal aborts, and still probes once', async () => {
    const child = spawnGroupLeader("process.stdout.write(process.pid+'\\n');setInterval(()=>{},100)");
    const pid = await firstReportedPid(child);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);

    const startedAt = Date.now();
    const proof = await proveProcessGroupQuiescence(pid, { timeoutMs: 10_000, signal: abort.signal });

    expect(proof).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const gone = spawnGroupLeader('process.exit(0)');
    await once(gone, 'exit');
    expect(await proveProcessGroupQuiescence(gone.pid!, { timeoutMs: 10_000, signal: AbortSignal.abort() })).toEqual({
      kind: 'quiescent',
    });
  });

  it.runIf(isPosix)('stays unproven with signal-error when the group probe fails unexpectedly', async () => {
    expect(await proveProcessGroupQuiescence(4242, { timeoutMs: 300, port: failingPort('EINVAL').port })).toEqual({
      kind: 'unproven',
      reason: 'signal-error',
    });
  });

  it.runIf(process.platform === 'win32')('refuses a group proof on Windows', async () => {
    await expect(proveProcessGroupQuiescence(4242, { timeoutMs: 100 })).rejects.toThrow('POSIX');
  });
});

describe('terminateWindowsProcessTree', () => {
  it.runIf(isPosix)('refuses to run on a POSIX host', async () => {
    await expect(terminateWindowsProcessTree(4242, { timeoutMs: 1_000 })).rejects.toThrow('Windows');
  });

  it.runIf(process.platform === 'win32')('terminates a child together with its grandchild', async () => {
    const grandchild = "process.stdout.write(process.pid+'\\n');setInterval(()=>{},100)";
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','ignore']});setInterval(()=>{},100)`,
      ],
      { ...spawnOptionsForOwnership('process-group'), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    const grandchildPid = await firstReportedPid(child);
    const exited = once(child, 'exit');
    expect(await terminateWindowsProcessTree(child.pid!, { timeoutMs: 10_000 })).toBe('delivered');
    await exited;
    await expect
      .poll(() => {
        try {
          process.kill(grandchildPid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(await terminateWindowsProcessTree(child.pid!, { timeoutMs: 10_000 })).toBe('absent');
  });
});
