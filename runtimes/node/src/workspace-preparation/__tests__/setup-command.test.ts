import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSetupCommand } from '../setup-command.js';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));

const PROCESS_STATUS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,uid=,stat='] as const;
const PROCESS_STATUS_TIMEOUT_MS = 1_000;

interface ChildIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
}

interface ProcessGroupWitness {
  readonly groupPid: number;
  readonly rows: readonly {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly uid: number;
    readonly stat: string;
  }[];
  readonly errorCode?: string;
}

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: childProcessMocks.execFile,
  spawn: childProcessMocks.spawn,
}));

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-command-'));
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  childProcessMocks.execFile.mockImplementation(actual.execFile);
  childProcessMocks.spawn.mockImplementation(actual.spawn);
});

afterEach(async () => {
  childProcessMocks.execFile.mockReset();
  childProcessMocks.spawn.mockReset();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/**
 * Build a harmless node command for real process tests.
 * @param source - Node inline program.
 * @param timeoutMs - Command deadline.
 * @returns Local setup command options.
 */
function command(source: string, timeoutMs = 5_000) {
  return { workspaceRoot, recipe: { command: process.execPath, args: ['-e', source], env: {}, timeoutMs } };
}

/**
 * Capture a group witness after a failed signal without delaying that signal.
 * @param execFile - Unmocked child-process launcher for this test-only observation.
 * @param groupPid - Process-group identifier to select.
 * @returns A bounded snapshot after the actual signal call has returned.
 */
function witnessProcessGroupAfterSignalError(
  execFile: typeof import('node:child_process').execFile,
  groupPid: number,
): Promise<ProcessGroupWitness> {
  return new Promise((resolve) => {
    try {
      execFile('ps', PROCESS_STATUS_ARGS, { encoding: 'utf8', timeout: PROCESS_STATUS_TIMEOUT_MS }, (error, stdout) => {
        if (error !== null) {
          resolve({ groupPid, rows: [], errorCode: (error as NodeJS.ErrnoException).code ?? 'PS_FAILED' });
          return;
        }
        const rows = String(stdout)
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .flatMap(([pid, ppid, pgid, uid, stat, extra]) =>
            extra !== undefined ||
            !/^\d+$/.test(pid ?? '') ||
            !/^\d+$/.test(ppid ?? '') ||
            !/^\d+$/.test(pgid ?? '') ||
            !/^\d+$/.test(uid ?? '') ||
            stat === undefined
              ? []
              : [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), stat }],
          );
        resolve({ groupPid, rows: rows.filter((row) => row.pgid === groupPid).slice(0, 5) });
      });
    } catch (error) {
      resolve({ groupPid, rows: [], errorCode: (error as NodeJS.ErrnoException).code ?? 'PS_FAILED' });
    }
  });
}

/**
 * Keep the first two group probes observable so ps fallback tests cannot pass
 * by declaring the first successful kill(group, 0) probe safe.
 * @returns Probe count and restoration for the real process kill function.
 */
function holdTwoGroupProbes(): { readonly probes: () => number; readonly restore: () => void } {
  const kill = process.kill.bind(process);
  let probes = 0;
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (typeof pid === 'number' && pid < 0 && signal === 0 && probes < 2) {
      probes += 1;
      return true;
    }
    return kill(pid, signal);
  });
  return { probes: () => probes, restore: () => spy.mockRestore() };
}

describe('bounded setup commands', () => {
  it('supports the maximum Node timer duration without premature timeout', async () => {
    const options = command("require('fs').writeFileSync('maximum-timeout','ran')", 2_147_483_647);
    expect(await runSetupCommand(options)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
    expect(await fs.readFile(path.join(workspaceRoot, 'maximum-timeout'), 'utf8')).toBe('ran');
  });

  it.each([
    2_147_483_648,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
  ])('rejects invalid timeout %s before spawning a command', async (timeoutMs) => {
    expect(await runSetupCommand(command("require('fs').writeFileSync('never','ran')", timeoutMs))).toEqual({
      status: 'spawn-failed',
      exitCode: null,
      message: 'Setup timeout must be an integer between 1 and 2147483647 milliseconds',
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(workspaceRoot, 'never'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves cancellation precedence over an invalid timeout', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await runSetupCommand({ ...command('', 2_147_483_648), signal: abort.signal })).toEqual({
      status: 'cancelled',
      exitCode: null,
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('uses workspace cwd, explicit arguments and locally merged environment', async () => {
    const options = command("require('fs').writeFileSync('marker',process.argv[1]+process.env.SETUP_TEST_VALUE)");
    options.recipe.args.push('literal;not-a-shell');
    expect(await runSetupCommand({ ...options, env: { SETUP_TEST_VALUE: '-injected' } })).toEqual({
      status: 'completed',
      exitCode: 0,
    });
    expect(await fs.readFile(path.join(workspaceRoot, 'marker'), 'utf8')).toBe('literal;not-a-shell-injected');
  });

  it('classifies non-zero exit and missing executable', async () => {
    expect(await runSetupCommand(command('process.exit(4)'))).toEqual({ status: 'failed', exitCode: 4 });
    const missing = command('');
    missing.recipe.command = path.join(workspaceRoot, 'missing-executable');
    expect(await runSetupCommand(missing)).toMatchObject({ status: 'spawn-failed' });
    missing.recipe.command = 'invalid\0command';
    expect(await runSetupCommand(missing)).toMatchObject({ status: 'spawn-failed' });
  });

  it('does not start an already-cancelled command', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(
      await runSetupCommand({ ...command("require('fs').writeFileSync('never','ran')"), signal: abort.signal }),
    ).toEqual({ status: 'cancelled', exitCode: null });
    await expect(fs.stat(path.join(workspaceRoot, 'never'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('times out an ordinary command and waits for it to exit', async () => {
    expect(await runSetupCommand(command('setInterval(()=>{},100)', 100))).toMatchObject({ status: 'timed-out' });
  });

  it('escalates when a command ignores SIGTERM', async () => {
    const abort = new AbortController();
    const running = runSetupCommand({
      ...command("process.on('SIGTERM',()=>{});require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)"),
      signal: abort.signal,
    });
    await expect.poll(async () => fs.readFile(path.join(workspaceRoot, 'ready'), 'utf8')).toBe('yes');
    abort.abort();
    expect(await running).toMatchObject({ status: 'cancelled' });
  });

  it('stops a real child with a delayed write before cancellation returns', async () => {
    const startedAt = performance.now();
    const diagnostics: {
      groupPids: number[];
      killCalls: Array<{
        pid: number;
        signal: string;
        elapsedMs: number;
        success: boolean;
        errorCode: string | undefined;
      }>;
      ps: Array<{
        durationMs: number;
        errorCode: string | undefined;
        errorSignal: string | undefined;
        targetRows: Array<{ pgid: string; stat: string | undefined }>;
        rejectedRows: Array<{ pgid: string; stat: string | undefined }>;
      }>;
      childIdentity?: ChildIdentity;
      afterKillError?: ProcessGroupWitness;
    } = { groupPids: [], killCalls: [], ps: [] };
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    childProcessMocks.execFile.mockImplementation((file, args, options, callback) => {
      const startedAt = Date.now();
      return actual.execFile(file, args, options, (error, stdout, stderr) => {
        if (file === 'ps') {
          const rows = String(stdout)
            .trim()
            .split('\n')
            .map((line) => line.trim().split(/\s+/));
          const targetRows = rows
            .filter(([pgid]) => diagnostics.groupPids.includes(Number(pgid)))
            .map(([pgid, stat]) => ({ pgid, stat }));
          const rejectedRows = rows
            .filter(
              ([pgid, stat, extra]) => pgid === '' || stat === undefined || extra !== undefined || !/^\d+$/.test(pgid),
            )
            .slice(0, 5)
            .map(([pgid, stat]) => ({ pgid, stat }));
          const nodeError = error as NodeJS.ErrnoException | null;
          diagnostics.ps.push({
            durationMs: Date.now() - startedAt,
            errorCode: nodeError?.code,
            errorSignal: error?.signal ?? undefined,
            targetRows,
            rejectedRows,
          });
        }
        callback(error, stdout, stderr);
      });
    });
    const kill = process.kill.bind(process);
    let postKillErrorWitness: Promise<ProcessGroupWitness> | undefined;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (!(typeof pid === 'number' && pid < 0)) return kill(pid, signal);
      const groupPid = -pid;
      const signalName = signal === 0 ? '0' : String(signal ?? 'default');
      diagnostics.groupPids.push(groupPid);
      try {
        const result = kill(pid, signal);
        diagnostics.killCalls.push({
          pid: groupPid,
          signal: signalName,
          elapsedMs: Math.round(performance.now() - startedAt),
          success: true,
          errorCode: undefined,
        });
        return result;
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        diagnostics.killCalls.push({
          pid: groupPid,
          signal: signalName,
          elapsedMs: Math.round(performance.now() - startedAt),
          success: false,
          errorCode,
        });
        if (signalName === 'SIGKILL' && errorCode === 'EPERM' && postKillErrorWitness === undefined) {
          postKillErrorWitness = witnessProcessGroupAfterSignalError(actual.execFile, groupPid);
        }
        throw error;
      }
    });
    const abort = new AbortController();
    const childProgram =
      "require('fs').writeFileSync('child-ready',[process.pid,process.ppid,process.getuid()].join(':'));setTimeout(()=>require('fs').writeFileSync('too-late','bad'),500)";
    const parentProgram = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore'});setInterval(()=>{},100)`;
    try {
      const running = runSetupCommand({ ...command(parentProgram), signal: abort.signal });
      let childIdentity: ChildIdentity | undefined;
      await expect
        .poll(async () => {
          const [pid, ppid, uid, extra] = (await fs.readFile(path.join(workspaceRoot, 'child-ready'), 'utf8'))
            .trim()
            .split(':');
          if (
            extra !== undefined ||
            !/^\d+$/.test(pid ?? '') ||
            !/^\d+$/.test(ppid ?? '') ||
            !/^\d+$/.test(uid ?? '')
          ) {
            return false;
          }
          childIdentity = { pid: Number(pid), ppid: Number(ppid), uid: Number(uid) };
          return true;
        })
        .toBe(true);
      if (childIdentity === undefined) throw new Error('child did not report its identity');
      diagnostics.childIdentity = childIdentity;
      abort.abort();
      const result = await running;
      if (postKillErrorWitness !== undefined) {
        diagnostics.afterKillError = await postKillErrorWitness;
      }
      expect(result, JSON.stringify(diagnostics)).toMatchObject({ status: 'cancelled' });
      // A dead child can remain a zombie until its adopting parent reaps it.
      // Verify absence of live work, not absence of a still-allocated PID.
      const processes = execFileSync('ps', ['-A', '-o', 'pid=,stat='], { encoding: 'utf8', timeout: 1_000 });
      const childState = processes
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([pid]) => Number(pid) === childIdentity?.pid)?.[1];
      expect(childState === undefined || childState.startsWith('Z')).toBe(true);
      await delay(600);
      await expect(fs.stat(path.join(workspaceRoot, 'too-late'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('waits conservatively for ESRCH when ps is unavailable after a group close', async () => {
    let psQueries = 0;
    childProcessMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      psQueries += 1;
      callback(new Error('ps unavailable'), '', '');
      return undefined;
    });
    const childProgram = 'setInterval(()=>{},100)';
    const parentProgram = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore'});process.exit(0)`;
    const probes = holdTwoGroupProbes();

    try {
      expect(await runSetupCommand(command(parentProgram))).toEqual({ status: 'completed', exitCode: 0 });
      expect(probes.probes()).toBe(2);
      expect(psQueries).toBeGreaterThanOrEqual(2);
    } finally {
      probes.restore();
    }
  });

  it.each([
    ['zombie-only', 'cancelled'],
    ['disappeared', 'cancelled'],
    ['live', 'stop-failed'],
    ['unavailable', 'stop-failed'],
    ['malformed', 'stop-failed'],
    ['empty', 'stop-failed'],
    ['unmatched zombie', 'stop-failed'],
  ] as const)('requires quiescence proof after EPERM with %s group evidence', async (evidence, status) => {
    const kill = process.kill.bind(process);
    let groupPid = 0;
    let deniedSignals = 0;
    let deniedProbes = 0;
    let psQueries = 0;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (typeof pid !== 'number' || pid >= 0 || signal === 'SIGTERM') return kill(pid, signal);
      groupPid = -pid;
      if (signal === 0 && evidence === 'disappeared' && psQueries > 0) return kill(pid, signal);
      if (signal === 0) deniedProbes++;
      else deniedSignals++;
      throw Object.assign(new Error('group signal denied'), { code: 'EPERM' });
    });
    childProcessMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      psQueries++;
      const rows = {
        'zombie-only': `${groupPid} Z\n`,
        disappeared: '',
        live: `${groupPid} S\n`,
        unavailable: '',
        malformed: 'not-a-process-row\n',
        empty: '',
        'unmatched zombie': `${groupPid + 1} Z\n`,
      };
      callback(evidence === 'unavailable' ? new Error('ps unavailable') : null, rows[evidence], '');
      return undefined;
    });
    const abort = new AbortController();
    try {
      // A real process receives SIGTERM; only final cleanup and its host
      // observations inject the denied-signal interleaving.
      const running = runSetupCommand({
        ...command("require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)"),
        signal: abort.signal,
      });
      await expect.poll(async () => fs.readFile(path.join(workspaceRoot, 'ready'), 'utf8')).toBe('yes');
      abort.abort();
      expect(await running).toMatchObject({ status });
      expect(deniedSignals).toBe(1);
      expect(deniedProbes).toBeGreaterThan(0);
      expect(psQueries).toBeGreaterThan(0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it.each([
    ['term', 'cancelled', false],
    ['term', 'timed-out', false],
    ['escalation', 'cancelled', false],
    ['escalation', 'timed-out', false],
    ['term', 'cancelled', true],
    ['escalation', 'cancelled', true],
  ] as const)('verifies cleanup after %s EPERM for %s (unverifiable: %s)', async (phase, reason, unverifiable) => {
    const kill = process.kill.bind(process);
    let groupPid = 0;
    let termSignals = 0;
    let killSignals = 0;
    let deniedSignals = 0;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (typeof pid !== 'number' || pid >= 0) return kill(pid, signal);
      groupPid = -pid;
      if (signal === 'SIGTERM') termSignals++;
      if (signal === 'SIGKILL') killSignals++;
      if (signal === 'SIGTERM' && phase === 'term') {
        deniedSignals++;
        throw Object.assign(new Error('TERM denied'), { code: 'EPERM' });
      }
      // The deadline case must reach escalation even if Node has not yet
      // installed its SIGTERM handler when the short command deadline expires.
      if (signal === 'SIGTERM' && reason === 'timed-out') return true;
      if (signal === 'SIGKILL' && killSignals === 1 && phase === 'escalation') {
        // Termination proceeds, but the host reports EPERM before close and
        // the independent final verification, as in the exiting-group race.
        kill(pid, signal);
        deniedSignals++;
        throw Object.assign(new Error('escalation denied'), { code: 'EPERM' });
      }
      if (signal === 0 && unverifiable) throw Object.assign(new Error('probe denied'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    if (unverifiable) {
      childProcessMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
        callback(new Error('ps unavailable'), '', '');
        return undefined;
      });
    }
    const abort = new AbortController();
    let cleanupError: unknown;
    try {
      const running = runSetupCommand({
        ...command(
          "process.on('SIGTERM',()=>{});require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)",
          reason === 'timed-out' ? 100 : 5_000,
        ),
        signal: abort.signal,
      });
      if (reason === 'cancelled') {
        await expect.poll(async () => fs.readFile(path.join(workspaceRoot, 'ready'), 'utf8')).toBe('yes');
        abort.abort();
      }
      expect(await running).toMatchObject({ status: unverifiable ? 'stop-failed' : reason });
      expect(termSignals).toBe(1);
      expect(killSignals).toBe(2);
      expect(deniedSignals).toBe(1);
    } finally {
      killSpy.mockRestore();
      if (groupPid !== 0) {
        try {
          kill(-groupPid, 'SIGKILL');
        } catch (error) {
          if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) cleanupError = error;
        }
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  });

  it.each([
    ['malformed', 'not-a-process-row\n'],
    ['empty', ''],
    ['unmatched zombie', '999999 Z\n'],
  ])('treats %s ps output as live until the group disappears', async (_name, stdout) => {
    let psQueries = 0;
    childProcessMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      psQueries += 1;
      callback(null, stdout, '');
      return undefined;
    });
    const childProgram = 'setInterval(()=>{},100)';
    const parentProgram = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore'});process.exit(0)`;
    const probes = holdTwoGroupProbes();

    try {
      expect(await runSetupCommand(command(parentProgram))).toEqual({ status: 'completed', exitCode: 0 });
      expect(probes.probes()).toBe(2);
      expect(psQueries).toBeGreaterThanOrEqual(2);
    } finally {
      probes.restore();
    }
  });
});
