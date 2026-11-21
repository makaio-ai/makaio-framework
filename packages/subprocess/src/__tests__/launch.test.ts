import * as buffer from 'node:buffer';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launch, type LaunchOptions, type LaunchedProcess } from '../launch.js';
import { WindowsTreeTerminationError, type ProcessSignalPort } from '../process-tree.js';
import type { StopHost } from '../stop-escalation.js';
import { isAlive, killQuietly } from './fixtures/jsonl-children.js';

/**
 * These cases start real processes. The outcomes a real host cannot produce on
 * demand (a denied signal, the Windows ordering on a POSIX host) go through the
 * injectable `signalPort` and `stopHost`; a missing `ps` is produced for real with an
 * empty `PATH`. Whether nothing was spawned is proven by a marker file the
 * command would have written.
 */

const isPosix = process.platform !== 'win32';

/** Working directory of a test; holds its marker files. */
let workspaceRoot: string;
/** Groups a test started; any survivor is killed after it. */
const startedGroups: number[] = [];
/** Processes a test left behind on purpose; killed after it. */
const strays: number[] = [];

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of startedGroups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      killQuietly(pid);
    }
  }
  for (const pid of strays.splice(0)) killQuietly(pid);
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/**
 * Launch an inline node program with short bounds; the group is cleaned up after the test.
 * @param source - Node inline program.
 * @param overrides - Options that replace the defaults.
 * @returns The launched process.
 */
function run(source: string, overrides: Partial<LaunchOptions> = {}): LaunchedProcess {
  const launched = launch({
    command: process.execPath,
    args: ['-e', source],
    cwd: workspaceRoot,
    envMode: 'merge',
    timeoutMs: 10_000,
    output: { kind: 'ignore' },
    killGraceMs: 200,
    exitObservationMs: 1_000,
    quiescenceProofTimeoutMs: 1_000,
    ...overrides,
  });
  if (launched.pid !== undefined) startedGroups.push(launched.pid);
  return launched;
}

/**
 * Wait until a marker file exists and return its content.
 * @param name - File name inside the test directory.
 * @returns The file's content.
 */
async function markerContent(name: string): Promise<string> {
  await expect
    .poll(() => fs.readFile(path.join(workspaceRoot, name), 'utf8').catch(() => ''), { timeout: 5_000 })
    .not.toBe('');
  return fs.readFile(path.join(workspaceRoot, name), 'utf8');
}

/**
 * Prove that a command never ran: the marker it would have written is absent.
 * @param name - Marker file name.
 */
async function expectNoMarker(name: string): Promise<void> {
  await expect(fs.stat(path.join(workspaceRoot, name))).rejects.toMatchObject({ code: 'ENOENT' });
}

/**
 * Source of a command that writes a marker proving it ran.
 * @param name - Marker file name.
 * @returns Node inline program.
 */
function WRITE_MARKER(name: string): string {
  return `require('fs').writeFileSync(${JSON.stringify(name)},'ran')`;
}

/**
 * A leader that spawns a grandchild in its group and then runs `leaderTail`.
 * @param childProgram - Program of the grandchild.
 * @param leaderTail - What the leader does after the spawn.
 * @returns Source of the leader.
 */
function leaderWithGrandchild(childProgram: string, leaderTail: string): string {
  return `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore'});${leaderTail}`;
}

/** A grandchild that records its PID and runs until killed. */
const SURVIVOR = "require('fs').writeFileSync('survivor-pid',String(process.pid));setInterval(()=>{},100)";

/**
 * Record every group signal that is more than a probe, and forward all to the real host.
 * @returns The port and the recorded signal names.
 */
function recordingPort(): { readonly port: ProcessSignalPort; readonly signals: string[] } {
  const signals: string[] = [];
  return {
    signals,
    port: {
      kill: (pid, signal) => {
        if (pid < 0 && signal !== 0) signals.push(String(signal));
        process.kill(pid, signal);
      },
    },
  };
}

/**
 * Point `PATH` at an empty directory so that no `ps` can be started.
 * @returns Removal of the directory.
 */
async function withoutPs(): Promise<() => Promise<void>> {
  const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-no-ps-'));
  vi.stubEnv('PATH', emptyPath);
  return async () => {
    vi.unstubAllEnvs();
    await fs.rm(emptyPath, { recursive: true, force: true });
  };
}

/**
 * Error a denied signal raises.
 * @param code - errno code.
 * @returns The error.
 */
function errno(code: string): Error {
  return Object.assign(new Error(`signal failed (${code})`), { code });
}

describe('launch', () => {
  describe('natural ends', () => {
    it('reports exit 0 as completed with a quiescent group and no signal', async () => {
      const launched = run('process.exit(0)');
      expect(launched.pid).toBeGreaterThan(0);
      const result = await launched.result;
      expect(result).toMatchObject({
        status: 'completed',
        exit: { kind: 'exited', code: 0, signal: null },
        group: { pid: launched.pid, tree: { kind: 'quiescent' }, signalDelivered: false },
      });
      expect(result.group?.observedAt).toBeInstanceOf(Date);
      expect(result.refusal).toBeUndefined();
      expect(result.message).toBeUndefined();
      expect(result.output).toBeUndefined();
    });

    it('reports a non-zero exit as failed', async () => {
      expect(await run('process.exit(4)').result).toMatchObject({
        status: 'failed',
        exit: { kind: 'exited', code: 4 },
        group: { tree: { kind: 'quiescent' }, signalDelivered: false },
      });
    });

    it.runIf(isPosix)('reports an end by a signal nobody here sent as failed', async () => {
      expect(await run("process.kill(process.pid,'SIGKILL')").result).toMatchObject({
        status: 'failed',
        exit: { kind: 'exited', code: null, signal: 'SIGKILL' },
        group: { signalDelivered: false },
      });
    });

    it('supports the maximum Node timer duration without a premature timeout', async () => {
      expect(await run(WRITE_MARKER('maximum-timeout'), { timeoutMs: 2_147_483_647 }).result).toMatchObject({
        status: 'completed',
      });
      expect(await markerContent('maximum-timeout')).toBe('ran');
    });

    it('settles once, with one value, and never rejects', async () => {
      const launched = run('process.exit(0)');
      const first = await launched.result;
      expect(await launched.result).toBe(first);
      const [settled] = await Promise.allSettled([launched.result]);
      expect(settled.status).toBe('fulfilled');
    });

    it('does not throw for a command the host rejects synchronously', async () => {
      let launched: LaunchedProcess | undefined;
      expect(() => {
        launched = run('', { command: 'invalid\0command' });
      }).not.toThrow();
      expect(await launched?.result).toMatchObject({ status: 'spawn-failed', refusal: 'spawn-error' });
      expect(launched?.pid).toBeUndefined();
    });

    it.runIf(isPosix)(
      'captures what a descendant writes after the leader exited, whatever the exit observation time',
      async () => {
        // The grandchild holds the leader's stdout. The leader exits only once the grandchild reported that it
        // runs, so the grandchild's start-up time is not part of the drain. The grandchild writes only once
        // this test released it. The release is decided in the launcher's own process. On POSIX an exited
        // leader answers the probe until this runtime reaped it, and the runtime emits the exit to the
        // launcher in the same callback, so a timer that finds the PID gone runs after the launcher observed
        // the exit. The release follows 50 ms later: a drain timer armed with the exit observation time of 0
        // has fired by then.
        const grandchild =
          "const probe=setInterval(()=>{if(require('fs').existsSync('release')){clearInterval(probe);process.stdout.write('late')}},20);process.send('ready')";
        const leader = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','ignore','ipc']});child.once('message',()=>{child.disconnect();child.unref();process.stdout.write('early')})`;
        const launched = run(leader, { exitObservationMs: 0, output: { kind: 'capture', limitBytes: 1024 } });
        const leaderPid = launched.pid;
        if (leaderPid === undefined) throw new Error('the leader was not spawned');
        let release: NodeJS.Timeout | undefined;
        const probe = setInterval(() => {
          if (isAlive(leaderPid)) return;
          clearInterval(probe);
          release = setTimeout(() => void fs.writeFile(path.join(workspaceRoot, 'release'), 'go'), 50);
        }, 10);
        try {
          const result = await launched.result;
          expect(result.status).toBe('completed');
          expect(result.output).toMatchObject({ stdout: 'earlylate', stderr: '' });
        } finally {
          clearInterval(probe);
          clearTimeout(release);
        }
      },
    );
  });

  describe('command, working directory and environment', () => {
    it('uses the working directory, explicit arguments and no shell', async () => {
      const result = await run("require('fs').writeFileSync('marker',process.argv[1])", {
        args: ['-e', "require('fs').writeFileSync('marker',process.argv[1])", 'literal;not-a-shell'],
      }).result;
      expect(result.status).toBe('completed');
      expect(await markerContent('marker')).toBe('literal;not-a-shell');
    });

    it('merges the host environment under the given entries in merge mode', async () => {
      vi.stubEnv('LAUNCH_TEST_INHERITED', 'inherited');
      vi.stubEnv('LAUNCH_TEST_REMOVED', 'present');
      const source =
        "require('fs').writeFileSync('env',JSON.stringify([process.env.LAUNCH_TEST_INHERITED,process.env.LAUNCH_TEST_GIVEN,process.env.LAUNCH_TEST_REMOVED]))";
      const result = await run(source, {
        envMode: 'merge',
        env: { LAUNCH_TEST_GIVEN: 'given', LAUNCH_TEST_REMOVED: undefined },
      }).result;
      expect(result.status).toBe('completed');
      expect(JSON.parse(await markerContent('env'))).toEqual(['inherited', 'given', null]);
    });

    it('passes only the given entries in replace mode', async () => {
      vi.stubEnv('LAUNCH_TEST_INHERITED', 'inherited');
      const source =
        "require('fs').writeFileSync('env',JSON.stringify([process.env.LAUNCH_TEST_INHERITED??null,process.env.LAUNCH_TEST_GIVEN]))";
      const result = await run(source, { envMode: 'replace', env: { LAUNCH_TEST_GIVEN: 'given' } }).result;
      expect(result.status).toBe('completed');
      expect(JSON.parse(await markerContent('env'))).toEqual([null, 'given']);
    });
  });

  describe('commands that did not run', () => {
    it.each([
      2_147_483_648,
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
    ])('refuses the invalid timeout %s without spawning', async (timeoutMs) => {
      const launched = run(WRITE_MARKER('never'), { timeoutMs });
      expect(launched.pid).toBeUndefined();
      const result = await launched.result;
      expect(result).toEqual({
        status: 'spawn-failed',
        refusal: 'invalid-timeout',
        message: 'Launch timeout must be an integer between 1 and 2147483647 milliseconds',
      });
      expect(result.exit).toBeUndefined();
      expect(result.group).toBeUndefined();
      await expectNoMarker('never');
    });

    describe.each([
      'killGraceMs',
      'exitObservationMs',
      'quiescenceProofTimeoutMs',
    ] as const)('stop timing %s', (option) => {
      it.each([Infinity, NaN, -1, 2_147_483_648, 1.5])('refuses %s without spawning', async (value) => {
        const launched = run(WRITE_MARKER('never'), { [option]: value });
        expect(launched.pid).toBeUndefined();
        const result = await launched.result;
        expect(result).toMatchObject({ status: 'spawn-failed', refusal: 'invalid-stop-timing' });
        expect(result.message).toBeTypeOf('string');
        expect(result.exit).toBeUndefined();
        expect(result.group).toBeUndefined();
        await expectNoMarker('never');
      });
    });

    it('refuses a quiescence proof timeout of 0 without spawning', async () => {
      const launched = run(WRITE_MARKER('never'), { quiescenceProofTimeoutMs: 0 });
      expect(launched.pid).toBeUndefined();
      expect(await launched.result).toMatchObject({ status: 'spawn-failed', refusal: 'invalid-stop-timing' });
      await expectNoMarker('never');
    });

    it.each(['killGraceMs', 'exitObservationMs'] as const)('accepts %s of 0 and runs the command', async (option) => {
      const launched = run(WRITE_MARKER('ran'), { [option]: 0 });
      expect(launched.pid).toBeTypeOf('number');
      expect((await launched.result).status).toBe('completed');
      expect(await markerContent('ran')).toBeTypeOf('string');
    });

    it.each([
      NaN,
      Infinity,
      -1,
      1.5,
      buffer.constants.MAX_STRING_LENGTH + 1,
    ])('refuses the invalid capture limit %s without spawning', async (limitBytes) => {
      const launched = run(WRITE_MARKER('never'), { output: { kind: 'capture', limitBytes } });
      expect(launched.pid).toBeUndefined();
      const result = await launched.result;
      expect(result).toMatchObject({ status: 'spawn-failed', refusal: 'invalid-output-limit' });
      expect(result.message).toBeTypeOf('string');
      expect(result.exit).toBeUndefined();
      expect(result.group).toBeUndefined();
      expect(result.output).toBeUndefined();
      await expectNoMarker('never');
    });

    it('reports an already aborted signal as cancelled without exit and group, and does not start the command', async () => {
      const abort = new AbortController();
      abort.abort();
      const launched = run(WRITE_MARKER('never'), { signal: abort.signal });
      expect(launched.pid).toBeUndefined();
      expect(await launched.result).toEqual({ status: 'cancelled' });
      await expectNoMarker('never');
    });

    it('lets cancellation win over an invalid timeout', async () => {
      const abort = new AbortController();
      abort.abort();
      expect(await run(WRITE_MARKER('never'), { signal: abort.signal, timeoutMs: 2_147_483_648 }).result).toEqual({
        status: 'cancelled',
      });
      await expectNoMarker('never');
    });

    it('reports a missing executable as command-not-found, without exit and group, and without naming it', async () => {
      const missing = path.join(workspaceRoot, 'missing-executable-name');
      const launched = run('', { command: missing, args: [] });
      const result = await launched.result;
      expect(result).toMatchObject({ status: 'spawn-failed', refusal: 'command-not-found' });
      expect(result.exit).toBeUndefined();
      expect(result.group).toBeUndefined();
      expect(result.message).toBeTypeOf('string');
      expect(result.message).not.toContain('missing-executable-name');
      expect(result.message).not.toContain(workspaceRoot);
      expect(launched.pid).toBeUndefined();
    });

    it('reports a missing working directory as spawn-error, not command-not-found, without naming it', async () => {
      const missing = path.join(workspaceRoot, 'missing-directory-name');
      const launched = run('0', { cwd: missing });
      const result = await launched.result;
      expect(result).toMatchObject({ status: 'spawn-failed', refusal: 'spawn-error' });
      expect(result.message).not.toContain('missing-directory-name');
      expect(result.message).not.toContain(workspaceRoot);
      expect(launched.pid).toBeUndefined();
    });
  });

  describe.runIf(isPosix)('stops on a POSIX host', () => {
    it('cancels when the signal aborts after the first check and before the listener is registered', async () => {
      const abort = new AbortController();
      // Built directly: a spread would evaluate the getter before `launch` runs its first check.
      const launched = launch({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},100)'],
        cwd: workspaceRoot,
        envMode: 'merge',
        output: { kind: 'ignore' },
        signal: abort.signal,
        killGraceMs: 200,
        exitObservationMs: 1_000,
        quiescenceProofTimeoutMs: 1_000,
        get timeoutMs() {
          abort.abort();
          return 3_000;
        },
      });
      if (launched.pid !== undefined) startedGroups.push(launched.pid);
      const started = Date.now();
      expect(await launched.result).toMatchObject({ status: 'cancelled', group: { signalDelivered: true } });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('times out an ordinary command and waits for its exit', async () => {
      const result = await run('setInterval(()=>{},100)', { timeoutMs: 100 }).result;
      expect(result).toMatchObject({
        status: 'timed-out',
        exit: { kind: 'exited' },
        group: { tree: { kind: 'quiescent' }, signalDelivered: true },
      });
    });

    it('cancels a running command and reports the delivered signal', async () => {
      const abort = new AbortController();
      const running = run("require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)", {
        signal: abort.signal,
      });
      await markerContent('ready');
      abort.abort();
      expect(await running.result).toMatchObject({
        status: 'cancelled',
        exit: { kind: 'exited', signal: 'SIGTERM' },
        group: { tree: { kind: 'quiescent' }, signalDelivered: true },
      });
    });

    it('escalates when a command ignores SIGTERM and reports the stop reason within grace plus observation', async () => {
      const abort = new AbortController();
      const running = run(
        "process.on('SIGTERM',()=>{});require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)",
        { signal: abort.signal, killGraceMs: 200, exitObservationMs: 2_000 },
      );
      await markerContent('ready');
      const abortedAt = Date.now();
      abort.abort();
      const result = await running.result;
      expect(Date.now() - abortedAt).toBeLessThan(200 + 2_000 + 1_000);
      expect(result).toMatchObject({
        status: 'cancelled',
        exit: { kind: 'exited', signal: 'SIGKILL' },
        group: { tree: { kind: 'quiescent' }, signalDelivered: true },
      });
    });

    it('stops a descendant in the group before cancellation returns', async () => {
      const abort = new AbortController();
      const grandchild =
        "require('fs').writeFileSync('child-ready','yes');setTimeout(()=>require('fs').writeFileSync('too-late','bad'),500)";
      const running = run(leaderWithGrandchild(grandchild, 'setInterval(()=>{},100)'), { signal: abort.signal });
      await markerContent('child-ready');
      abort.abort();
      expect(await running.result).toMatchObject({ status: 'cancelled', group: { tree: { kind: 'quiescent' } } });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await expectNoMarker('too-late');
    });

    it('does not signal a descendant that outlives a leader that exited on its own: stop-failed, survivor alive', {
      timeout: 10_000,
    }, async () => {
      const { port, signals } = recordingPort();
      const result = await run(leaderWithGrandchild(SURVIVOR, 'setTimeout(()=>process.exit(0),400)'), {
        signalPort: port,
      }).result;
      strays.push(Number(await markerContent('survivor-pid')));
      expect(result).toMatchObject({
        status: 'stop-failed',
        exit: { kind: 'exited', code: 0 },
        group: { tree: { kind: 'unproven', reason: 'poll-timeout' }, signalDelivered: false },
      });
      expect(result.message).toBeTypeOf('string');
      expect(signals).toEqual([]);
      expect(isAlive(strays[0] ?? 0)).toBe(true);
    });

    it('does not escalate against a descendant that survives the stop once the leader exited', {
      timeout: 10_000,
    }, async () => {
      const { port, signals } = recordingPort();
      const abort = new AbortController();
      const survivor = `process.on('SIGTERM',()=>{});${SURVIVOR}`;
      const running = run(leaderWithGrandchild(survivor, 'setInterval(()=>{},100)'), {
        signalPort: port,
        signal: abort.signal,
      });
      strays.push(Number(await markerContent('survivor-pid')));
      abort.abort();
      const result = await running.result;
      expect(result).toMatchObject({
        status: 'stop-failed',
        group: { tree: { kind: 'unproven', reason: 'poll-timeout' }, signalDelivered: true },
      });
      // The leader's close ends the stop, so the forceful stage the timer held is never sent.
      expect(signals).toEqual(['SIGTERM']);
      expect(isAlive(strays[0] ?? 0)).toBe(true);
    });

    it('keeps the stop reason when the group is proven quiescent after a stop with a descendant', async () => {
      const abort = new AbortController();
      const grandchild = "require('fs').writeFileSync('gchild-ready','yes');setInterval(()=>{},100)";
      const running = run(leaderWithGrandchild(grandchild, 'setInterval(()=>{},100)'), { signal: abort.signal });
      await markerContent('gchild-ready');
      abort.abort();
      expect(await running.result).toMatchObject({
        status: 'cancelled',
        group: { pid: running.pid, tree: { kind: 'quiescent' }, signalDelivered: true },
      });
    });

    it('does not count a group signal that finds nothing left as delivered', async () => {
      const abort = new AbortController();
      const port: ProcessSignalPort = {
        kill: (pid, signal) => {
          if (pid < 0 && signal !== 0) throw errno('ESRCH');
          process.kill(pid, signal);
        },
      };
      const running = run("require('fs').writeFileSync('exit-ready','yes');setTimeout(()=>process.exit(0),700)", {
        signalPort: port,
        signal: abort.signal,
        killGraceMs: 5_000,
      });
      await markerContent('exit-ready');
      abort.abort();
      // The command keeps its own cancelled status; no signal ever reached the group.
      expect(await running.result).toMatchObject({
        status: 'cancelled',
        exit: { kind: 'exited', code: 0 },
        group: { signalDelivered: false },
      });
    });

    it.each([
      ['term', 'cancelled'],
      ['term', 'timed-out'],
      ['escalation', 'cancelled'],
      ['escalation', 'timed-out'],
    ] as const)('verifies quiescence after an EPERM at the %s stage for %s', async (phase, reason) => {
      const sent = { term: 0, kill: 0 };
      const port: ProcessSignalPort = {
        kill: (pid, signal) => {
          if (pid >= 0 || signal === 0) {
            process.kill(pid, signal);
            return;
          }
          if (signal === 'SIGTERM') {
            sent.term += 1;
            // The escalation case swallows the graceful stage so that the forceful one always follows.
            if (phase === 'term') throw errno('EPERM');
            return;
          }
          sent.kill += 1;
          process.kill(pid, signal);
          // The group ends, but the host reports EPERM, as in the exiting-group race.
          if (phase === 'escalation') throw errno('EPERM');
        },
      };
      const abort = new AbortController();
      const running = run('setInterval(()=>{},100)', {
        signalPort: port,
        signal: abort.signal,
        timeoutMs: reason === 'timed-out' ? 100 : 10_000,
      });
      if (reason === 'cancelled') abort.abort();
      const result = await running.result;
      expect(result).toMatchObject({ status: reason, group: { tree: { kind: 'quiescent' } } });
      expect(sent).toEqual({ term: 1, kill: 1 });
    });

    it('requires a proof when the probes are denied and no ps exists: stop-failed with ps-unavailable', {
      timeout: 10_000,
    }, async () => {
      const restore = await withoutPs();
      try {
        const abort = new AbortController();
        const port: ProcessSignalPort = {
          kill: (pid, signal) => {
            if (pid < 0 && signal === 0) throw errno('EPERM');
            process.kill(pid, signal);
          },
        };
        const running = run("require('fs').writeFileSync('ps-ready','yes');setInterval(()=>{},100)", {
          signalPort: port,
          signal: abort.signal,
          quiescenceProofTimeoutMs: 300,
        });
        await markerContent('ps-ready');
        abort.abort();
        expect(await running.result).toMatchObject({
          status: 'stop-failed',
          group: { tree: { kind: 'unproven', reason: 'ps-unavailable' }, signalDelivered: true },
        });
      } finally {
        await restore();
      }
    });

    it('reports no delivered signal when the stop signal is denied and quiescence cannot be proven', {
      timeout: 10_000,
    }, async () => {
      const restore = await withoutPs();
      try {
        const abort = new AbortController();
        const port: ProcessSignalPort = {
          kill: (pid, signal) => {
            if (pid < 0 && signal === 0) throw errno('EPERM');
            if (pid < 0) {
              // The leader ends through a direct kill so that it closes; the group signal itself is denied.
              process.kill(-pid, 'SIGTERM');
              throw errno('EPERM');
            }
            process.kill(pid, signal);
          },
        };
        const running = run("require('fs').writeFileSync('unsig-ready','yes');setInterval(()=>{},100)", {
          signalPort: port,
          signal: abort.signal,
          quiescenceProofTimeoutMs: 300,
        });
        await markerContent('unsig-ready');
        abort.abort();
        expect(await running.result).toMatchObject({
          status: 'stop-failed',
          group: { tree: { kind: 'unproven', reason: 'ps-unavailable' }, signalDelivered: false },
        });
      } finally {
        await restore();
      }
    });

    it('settles a stop whose signals are all denied within its bounds, while the command keeps running', {
      timeout: 15_000,
    }, async () => {
      const abort = new AbortController();
      const denying: ProcessSignalPort = {
        kill: (pid, signal) => {
          if (signal !== 0) throw errno('EPERM');
          process.kill(pid, signal);
        },
      };
      const running = run("require('fs').writeFileSync('alive-ready','yes');setInterval(()=>{},100)", {
        signalPort: denying,
        signal: abort.signal,
        killGraceMs: 100,
        exitObservationMs: 200,
        quiescenceProofTimeoutMs: 300,
      });
      await markerContent('alive-ready');
      const abortedAt = Date.now();
      abort.abort();
      const result = await running.result;
      // Grace, exit observation and the proof are each bounded.
      expect(Date.now() - abortedAt).toBeLessThan(8_000);
      expect(result).toMatchObject({
        status: 'stop-failed',
        exit: { kind: 'unobserved' },
        group: { signalDelivered: false, tree: { kind: 'unproven' } },
      });
      expect(isAlive(running.pid ?? 0)).toBe(true);
    });
  });

  describe('on a Windows host (injected)', () => {
    /**
     * A host whose tree termination is the given behaviour; never `taskkill`.
     * @param terminate - Simulated termination of the tree.
     * @returns The host.
     */
    function windows(terminate: StopHost['terminateWindowsTree']): StopHost {
      return { platform: 'win32', terminateWindowsTree: terminate };
    }
    /**
     * A termination that really ends the group, then reports delivery.
     * @param pid - Root of the tree.
     * @returns `delivered`.
     */
    const killingTermination: StopHost['terminateWindowsTree'] = async (pid) => {
      process.kill(-pid, 'SIGKILL');
      return 'delivered';
    };

    it('reports a natural exit 0 as completed without a proof of the tree', async () => {
      const result = await run('process.exit(0)', { stopHost: windows(killingTermination) }).result;
      expect(result).toMatchObject({
        status: 'completed',
        exit: { kind: 'exited', code: 0 },
        group: { tree: { kind: 'unproven', reason: 'no-termination' }, signalDelivered: false },
      });
    });

    it('reports a natural non-zero exit as failed without a proof of the tree', async () => {
      expect(await run('process.exit(3)', { stopHost: windows(killingTermination) }).result).toMatchObject({
        status: 'failed',
        group: { tree: { kind: 'unproven', reason: 'no-termination' } },
      });
    });

    it.runIf(isPosix)('keeps cancelled when the tree termination delivered', async () => {
      const abort = new AbortController();
      const running = run('setInterval(()=>{},100)', { stopHost: windows(killingTermination), signal: abort.signal });
      abort.abort();
      expect(await running.result).toMatchObject({
        status: 'cancelled',
        group: { tree: { kind: 'quiescent' }, signalDelivered: true },
      });
    });

    it.runIf(isPosix)('reports stop-failed with signal-error when the termination was refused', async () => {
      const abort = new AbortController();
      const refused = windows(async (pid) => {
        throw new WindowsTreeTerminationError('failed', '1', pid, new Error('taskkill'));
      });
      const running = run('setInterval(()=>{},100)', {
        stopHost: refused,
        signal: abort.signal,
        exitObservationMs: 200,
      });
      abort.abort();
      expect(await running.result).toMatchObject({
        status: 'stop-failed',
        exit: { kind: 'unobserved' },
        group: { tree: { kind: 'unproven', reason: 'signal-error' } },
      });
    });

    it.runIf(isPosix)(
      'reports stop-failed with no-termination when the termination found nothing after a stop began',
      async () => {
        const abort = new AbortController();
        const running = run('setInterval(()=>{},100)', {
          stopHost: windows(async () => 'absent'),
          signal: abort.signal,
          exitObservationMs: 200,
        });
        abort.abort();
        expect(await running.result).toMatchObject({
          status: 'stop-failed',
          group: { tree: { kind: 'unproven', reason: 'no-termination' } },
        });
      },
    );

    it.runIf(isPosix)('reports stop-failed with poll-timeout when the termination did not finish', async () => {
      const abort = new AbortController();
      const timedOut = windows(async (pid) => {
        throw new WindowsTreeTerminationError('timed-out', 'timeout', pid, new Error('taskkill'));
      });
      const running = run('setInterval(()=>{},100)', {
        stopHost: timedOut,
        signal: abort.signal,
        exitObservationMs: 200,
      });
      abort.abort();
      expect(await running.result).toMatchObject({
        status: 'stop-failed',
        group: { tree: { kind: 'unproven', reason: 'poll-timeout' } },
      });
    });
  });
});
