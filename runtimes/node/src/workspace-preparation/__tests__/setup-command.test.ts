import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSetupCommand } from '../setup-command.js';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: childProcessMocks.execFile,
}));

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-command-'));
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  childProcessMocks.execFile.mockImplementation(actual.execFile);
});

afterEach(async () => {
  childProcessMocks.execFile.mockReset();
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
        diagnostics.killCalls.push({
          pid: groupPid,
          signal: signalName,
          elapsedMs: Math.round(performance.now() - startedAt),
          success: false,
          errorCode: (error as NodeJS.ErrnoException).code,
        });
        throw error;
      }
    });
    const abort = new AbortController();
    const childProgram =
      "require('fs').writeFileSync('child-ready',String(process.pid));setTimeout(()=>require('fs').writeFileSync('too-late','bad'),500)";
    const parentProgram = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore'});setInterval(()=>{},100)`;
    try {
      const running = runSetupCommand({ ...command(parentProgram), signal: abort.signal });
      let childPid = 0;
      await expect
        .poll(async () => {
          childPid = Number(await fs.readFile(path.join(workspaceRoot, 'child-ready'), 'utf8'));
          return childPid > 0;
        })
        .toBe(true);
      abort.abort();
      const result = await running;
      expect(result, JSON.stringify(diagnostics)).toMatchObject({ status: 'cancelled' });
      // A dead child can remain a zombie until its adopting parent reaps it.
      // Verify absence of live work, not absence of a still-allocated PID.
      const processes = execFileSync('ps', ['-A', '-o', 'pid=,stat='], { encoding: 'utf8', timeout: 1_000 });
      const childState = processes
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([pid]) => Number(pid) === childPid)?.[1];
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
