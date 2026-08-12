/**
 * The tmux backend's exit-evidence contract.
 *
 * An exit event from this backend is a claim that a session ended. These tests
 * pin the rules that make the claim worth anything: it is published only when a
 * tmux server said the session is gone or the pane's own PID is held by nobody,
 * never because a kill call returned and never because a command failed to reach
 * anybody.
 *
 * Most arms drive a real `tmux`. The rest need a tmux that fails in a specific
 * way — an unrelated error, a vanished server, an unresponsive binary — which a
 * real one cannot be asked to do on demand. Those use a stub executable placed
 * on `PATH`. The stub is the *counterparty*, not the seam under test: the backend
 * still runs its own `execFileSync`, its own timeout and its own outcome
 * classification against a real child process.
 *
 * The PID probe is wrapped in a spy for the same reason and with the same
 * discipline. Its default implementation is the real one, so every arm but the
 * permission arm queries the real kernel about the real pane PID; the spy exists
 * to count calls (the fallback must not become the primary source) and, for the
 * one outcome no test can arrange on its own pane, to point the *real* probe at a
 * PID this runtime genuinely may not signal.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IPtyProcess } from '../types.js';
import type { ProcessProbeOutcome } from '../process-probe.js';
import { isTmuxAvailable, TmuxBackend } from '../tmux-backend.js';

const describeWithTmux = isTmuxAvailable() ? describe : describe.skip;
const REAL_TMUX_TEST_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// PID-probe spy over the real implementation
// ---------------------------------------------------------------------------

const { probeSpy } = vi.hoisted(() => ({ probeSpy: vi.fn<(pid: number) => ProcessProbeOutcome>() }));

vi.mock('../process-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../process-probe.js')>();
  return { ...actual, probeProcessPresence: probeSpy };
});

const realProbe = await vi.importActual<typeof import('../process-probe.js')>('../process-probe.js');

/**
 * A PID that exists and that an unprivileged runtime may not signal.
 *
 * PID 1 is the init process on every platform this backend runs on. Under a
 * privileged runtime it *is* signalable, which is why the arm that needs an
 * `EPERM` checks first instead of manufacturing one: a hand-made error would
 * stub the classification, which is the seam under test.
 */
const UNSIGNALABLE_PID = 1;
const EPERM_IS_OBSERVABLE = realProbe.probeProcessPresence(UNSIGNALABLE_PID) === 'indeterminate';

beforeEach(() => {
  probeSpy.mockReset();
  probeSpy.mockImplementation(realProbe.probeProcessPresence);
});

/**
 * Generate a unique tmux server name for one test run.
 * @returns A socket name unlikely to collide with any other run.
 */
function uniqueServerName(): string {
  return `makaio-evidence-${randomBytes(4).toString('hex')}`;
}

/**
 * Kill a tmux server by name, ignoring failures if it no longer exists.
 * @param serverName - Socket name to kill.
 */
function killServer(serverName: string): void {
  try {
    execFileSync('tmux', ['-L', serverName, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // Already gone — no-op.
  }
}

/**
 * Create an extra session directly on a server so the server survives having
 * the session under test killed.
 *
 * Without it, killing the only session takes the tmux server down with it and
 * every following read is unanswerable — which is a real outcome, but not the
 * one an arm about a *live* server's answer means to exercise.
 * @param serverName - Socket name to create the session on.
 * @returns Name of the keep-alive session.
 */
function createServerKeepAliveSession(serverName: string): string {
  const name = `keepalive-${randomBytes(3).toString('hex')}`;
  execFileSync('tmux', ['-L', serverName, 'new-session', '-d', '-s', name, '/bin/cat'], { stdio: 'ignore' });
  return name;
}

/**
 * Collect exit events published by a PTY process.
 * @param proc - Process to observe.
 * @returns Array that receives every exit event, in order.
 */
function recordExits(proc: IPtyProcess): Array<{ exitCode: number }> {
  const events: Array<{ exitCode: number }> = [];
  proc.onExit((event) => events.push({ exitCode: event.exitCode }));
  return events;
}

// ---------------------------------------------------------------------------
// Stub-tmux support
// ---------------------------------------------------------------------------

/**
 * Write a stub `tmux` onto a fresh directory and prepend it to `PATH`.
 *
 * The stub answers the calls a backend makes during `spawn` well enough for a
 * session handle to exist, then diverges on `kill-session` / `has-session`
 * according to `MAKAIO_TMUX_STUB_MODE`, which each test sets immediately before
 * the call it is about. Every invocation is appended to `MAKAIO_TMUX_STUB_LOG`,
 * which is how the arms about *tracking* observe what a later `dispose()` did or
 * did not issue.
 *
 * The pane PID it reports is `MAKAIO_TMUX_STUB_PANE_PID` — the test process
 * itself — because these arms are about reads that establish nothing, and a
 * fabricated PID would be absent from the process table and hand the backend a
 * proven end it was never meant to have here.
 * @returns The directory holding the stub.
 */
function installStubTmux(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-stub-'));
  const stub = join(dir, 'tmux');
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      '# Positional layout mirrors the backend: -L <server> <subcommand> ...',
      'sub="$3"',
      'if [ -n "$MAKAIO_TMUX_STUB_LOG" ]; then printf "%s\\n" "$*" >> "$MAKAIO_TMUX_STUB_LOG"; fi',
      'case "$sub" in',
      '  -V) echo "tmux 3.6a"; exit 0 ;;',
      '  new-session) echo "$MAKAIO_TMUX_STUB_PANE_PID"; exit 0 ;;',
      '  list-sessions) echo "no server running on /stub" >&2; exit 1 ;;',
      '  list-panes) echo "0:0"; exit 0 ;;',
      '  kill-session)',
      '    if [ "$MAKAIO_TMUX_STUB_MODE" = "other-error" ]; then',
      '      echo "command kill-session: server exited unexpectedly" >&2; exit 1',
      '    fi',
      '    exit 0 ;;',
      '  has-session)',
      '    if [ "$MAKAIO_TMUX_STUB_MODE" = "hang-after-kill" ]; then',
      '      while true; do sleep 1; done',
      '    fi',
      '    echo "no server running on /stub" >&2; exit 1 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
    'utf8',
  );
  chmodSync(stub, 0o755);
  return dir;
}

describe('TmuxBackend exit evidence — a tmux that fails in a chosen way', () => {
  let originalEnv: Record<string, string | undefined>;
  let stubLogPath: string;

  beforeEach(() => {
    const stubDir = installStubTmux();
    stubLogPath = join(stubDir, 'invocations.log');
    originalEnv = {
      PATH: process.env['PATH'],
      MAKAIO_TMUX_STUB_MODE: process.env['MAKAIO_TMUX_STUB_MODE'],
      MAKAIO_TMUX_STUB_PANE_PID: process.env['MAKAIO_TMUX_STUB_PANE_PID'],
      MAKAIO_TMUX_STUB_LOG: process.env['MAKAIO_TMUX_STUB_LOG'],
    };
    process.env['PATH'] = `${stubDir}:${originalEnv['PATH'] ?? ''}`;
    process.env['MAKAIO_TMUX_STUB_PANE_PID'] = String(process.pid);
    process.env['MAKAIO_TMUX_STUB_LOG'] = stubLogPath;
    writeFileSync(stubLogPath, '', 'utf8');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * Read the tmux invocations the stub has recorded so far.
   * @returns One entry per invocation, as the joined argument list.
   */
  function stubInvocations(): string[] {
    return readFileSync(stubLogPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  }

  /**
   * Spawn one session against the stub backend.
   * @param commandTimeoutMs - Command budget handed to the backend.
   * @returns The backend, the spawned process and its recorded exit events.
   */
  async function spawnStubbed(
    commandTimeoutMs: number,
  ): Promise<{ backend: TmuxBackend; proc: IPtyProcess; exits: Array<{ exitCode: number }> }> {
    const backend = new TmuxBackend({
      serverName: 'stub-server',
      cleanupStaleOwnedSessions: false,
      commandTimeoutMs,
    });
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    return { backend, proc, exits: recordExits(proc) };
  }

  // Arm (b): the command reached a server and failed for an unrelated reason.
  it('publishes no exit when the kill command answers some other error', async () => {
    const { proc, exits } = await spawnStubbed(1_000);

    process.env['MAKAIO_TMUX_STUB_MODE'] = 'other-error';
    proc.kill();

    expect(exits).toEqual([]);
  });

  // Arm (c): nothing was asked, so nothing is known. This is the arm that fails
  // an implementation which keeps reading "no output" as "session absent".
  it('publishes no exit when tmux cannot be run at all', async () => {
    const { proc, exits } = await spawnStubbed(1_000);

    // Remove the stub from PATH so the next invocation cannot resolve `tmux`.
    process.env['PATH'] = '/nonexistent-path-for-tmux-evidence-test';
    proc.kill();

    expect(exits).toEqual([]);
  });

  // Arm (e): the kill succeeded but its confirmation never reached a server, so
  // the end was not observed and must not be claimed.
  it('publishes no exit when a successful kill cannot be confirmed', async () => {
    const { proc, exits } = await spawnStubbed(1_000);

    process.env['MAKAIO_TMUX_STUB_MODE'] = 'server-vanished';
    proc.kill();

    expect(exits).toEqual([]);
  });

  // Arm (f): a successful kill whose confirming read hangs. The read is
  // synchronous, so no concurrent timer can end it — only the timeout the
  // caller wired down through the options can. Parameterised over two budgets
  // so an implementation that hard-codes a value next to `execFileSync` fails
  // the second one on timing while satisfying the first.
  it.each([500, 1_200])(
    'bounds an unconfirmable kill by the wired command budget of %ims',
    async (commandTimeoutMs) => {
      const { proc, exits } = await spawnStubbed(commandTimeoutMs);

      process.env['MAKAIO_TMUX_STUB_MODE'] = 'hang-after-kill';
      const startedAt = Date.now();
      proc.kill();
      const elapsedMs = Date.now() - startedAt;

      expect(exits).toEqual([]);
      // The bound must track the wired value: at least most of it (the read did
      // block) and not materially more (the budget, not some other clock, ended it).
      expect(elapsedMs).toBeGreaterThanOrEqual(commandTimeoutMs * 0.5);
      expect(elapsedMs).toBeLessThan(commandTimeoutMs * 3 + 500);
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  );

  // Tracking is released when the kill is committed, not when evidence arrives.
  // Asserted on the kill whose evidence is weakest — an unrelated failure — since
  // that is the one a release hanging on the exit event would keep for ever. All
  // three ways the release could have leaked into the evidence path are checked
  // here: no exit is published, no exit is recorded for a late listener (which is
  // what an exit-marking release would leave behind), and the reported evidence is
  // still the same nothing arm (b) demands.
  it('releases session tracking on a committed kill without touching the evidence', async () => {
    const { backend, proc, exits } = await spawnStubbed(1_000);

    process.env['MAKAIO_TMUX_STUB_MODE'] = 'other-error';
    proc.kill();

    expect(exits).toEqual([]);
    let lateExit: { exitCode: number } | undefined;
    proc.onExit((event) => {
      lateExit = event;
    });
    expect(lateExit).toBeUndefined();

    const killsBeforeDispose = stubInvocations().filter((call) => call.includes('kill-session')).length;
    expect(killsBeforeDispose).toBe(1);

    // A released session is no longer this backend's to kill again.
    process.env['MAKAIO_TMUX_STUB_MODE'] = '';
    await backend.dispose();

    expect(stubInvocations().filter((call) => call.includes('kill-session'))).toHaveLength(1);
  });
});

describeWithTmux('TmuxBackend exit evidence — real tmux', { timeout: REAL_TMUX_TEST_TIMEOUT_MS }, () => {
  let serverName: string;
  let backend: TmuxBackend;

  beforeEach(() => {
    serverName = uniqueServerName();
    backend = new TmuxBackend({ serverName, pollIntervalMs: 50, exitPollIntervalMs: 50 });
  });

  afterEach(async () => {
    await backend.dispose();
    killServer(serverName);
  });

  // Arm (a): the server itself reports no such session — absence proven.
  it('publishes an exit when the kill command answers "no such session"', async () => {
    createServerKeepAliveSession(serverName);
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    const exits = recordExits(proc);

    // Take the session away behind the backend's back, leaving the server up.
    const sessions = execFileSync('tmux', ['-L', serverName, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((name) => name.startsWith('makaio-'));
    expect(sessions).toHaveLength(1);
    execFileSync('tmux', ['-L', serverName, 'kill-session', '-t', sessions[0]!], { stdio: 'ignore' });

    probeSpy.mockClear();
    proc.kill();

    expect(exits).toHaveLength(1);
    // A server's own answer is the primary source: the local fallback must not
    // even be consulted, or it would quietly become the source of record.
    expect(probeSpy).not.toHaveBeenCalled();
  });

  // Arm (d): the happy path. The kill succeeds and the backend acquires its own
  // confirmation. This arm fails an implementation that merely deletes the old
  // unconditional exit write, because polling has already stopped by then and
  // nothing else would produce an exit.
  it('publishes an exit when a successful kill is confirmed absent', async () => {
    createServerKeepAliveSession(serverName);
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    const exits = recordExits(proc);

    probeSpy.mockClear();
    proc.kill();

    expect(exits).toHaveLength(1);
    expect(exits[0]!.exitCode).toBe(0);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  // ── Arm (g): the PID probe, driven through the last-session-on-server case ──
  //
  // No keep-alive session here, deliberately: killing the only session takes the
  // tmux server with it, so the confirming read answers "no server running" and
  // establishes nothing. That is the case the pane PID exists for, and the three
  // sub-arms are its three possible answers.

  // (g1) The pane process really is gone, so nobody holds its PID. This is the
  // arm that restores the happy path the server's death had turned into silence.
  it('publishes an exit when the vanished server leaves only the pane PID to ask', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    const exits = recordExits(proc);

    probeSpy.mockClear();
    proc.kill();

    expect(probeSpy).toHaveBeenCalledWith(proc.pid);
    expect(probeSpy).toHaveReturnedWith('absent');
    expect(exits).toHaveLength(1);
    expect(exits[0]!.exitCode).toBe(0);
  });

  // (g2) A live process holds the PID. Whether it is the pane process refusing to
  // die or an unrelated one that inherited a recycled PID cannot be told apart
  // from here — so nothing may be claimed. Driven by a pane process that ignores
  // the SIGHUP `kill-session` sends it, which makes the survivor real rather than
  // described.
  it('publishes no exit when a live process still holds the pane PID', async () => {
    const proc = await backend.spawn('/bin/sh', ['-c', 'trap "" HUP; exec sleep 30'], { cols: 80, rows: 24 });
    const exits = recordExits(proc);

    probeSpy.mockClear();
    try {
      proc.kill();

      expect(probeSpy).toHaveBeenCalledWith(proc.pid);
      expect(probeSpy).toHaveReturnedWith('present');
      expect(exits).toEqual([]);
    } finally {
      // The survivor outlived its tmux server; it is this test's to reap.
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // Already gone — nothing to reap.
      }
    }
  });

  // (g3) A process holds the PID and this runtime may not signal it. Same
  // conclusion as (g2), reached through a different error — and reached through
  // the *real* probe against a PID the OS really does refuse, so only the target
  // is substituted and the classification under test stays untouched.
  it.skipIf(!EPERM_IS_OBSERVABLE)('publishes no exit when the pane PID cannot be signalled', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    const exits = recordExits(proc);

    probeSpy.mockClear();
    probeSpy.mockImplementation(() => realProbe.probeProcessPresence(UNSIGNALABLE_PID));
    proc.kill();

    expect(probeSpy).toHaveReturnedWith('indeterminate');
    expect(exits).toEqual([]);
  });
});
