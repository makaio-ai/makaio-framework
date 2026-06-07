/**
 * Integration tests for TmuxBackend — spawns real tmux sessions.
 *
 * These tests require `tmux` to be installed and available on `PATH`. They are
 * automatically skipped when tmux is absent so CI environments without tmux
 * are unaffected.
 *
 * Each test suite uses a unique server socket name derived from a random UUID
 * to avoid conflicts with other running test runs or user tmux servers.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IPtyProcess } from '../types.js';
import { isTmuxAvailable, TmuxBackend } from '../tmux-backend.js';

// ---------------------------------------------------------------------------
// Availability guard
// ---------------------------------------------------------------------------

const describeWithTmux = isTmuxAvailable() ? describe : describe.skip;
const REAL_TMUX_TEST_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique tmux server name for one test run.
 * @returns A string like `'makaio-test-a1b2c3d4'`.
 */
function uniqueServerName(): string {
  return `makaio-test-${randomBytes(4).toString('hex')}`;
}

/**
 * Kill a tmux server by name, ignoring failures if it no longer exists.
 * @param serverName - The tmux socket name to kill.
 */
function killServer(serverName: string): void {
  try {
    execFileSync('tmux', ['-L', serverName, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // Already gone — no-op.
  }
}

/**
 * Run a tmux command on the test server.
 * @param serverName - The tmux socket name.
 * @param args - tmux subcommand arguments.
 * @returns Trimmed stdout from tmux.
 */
function tmuxExec(serverName: string, args: string[]): string {
  return execFileSync('tmux', ['-L', serverName, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Create a managed tmux session fixture with explicit owner metadata.
 * @param serverName - The tmux socket name.
 * @param sessionName - Session name to create.
 * @param ownerPid - Owner PID to record.
 */
function createManagedSessionFixture(serverName: string, sessionName: string, ownerPid: number): void {
  execFileSync(
    'tmux',
    [
      '-L',
      serverName,
      'new-session',
      '-d',
      '-s',
      sessionName,
      '/bin/cat',
      ';',
      'set-option',
      '-t',
      sessionName,
      '@makaio-managed',
      '1',
      ';',
      'set-option',
      '-t',
      sessionName,
      '@makaio-owner-pid',
      String(ownerPid),
    ],
    { stdio: 'ignore' },
  );
}

/**
 * List session names currently present on the test server.
 * @param serverName - The tmux socket name.
 * @returns Session names, or an empty array when the server is absent.
 */
function listSessionNames(serverName: string): string[] {
  try {
    const output = tmuxExec(serverName, ['list-sessions', '-F', '#{session_name}']);
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithTmux('TmuxBackend — real tmux integration', { timeout: REAL_TMUX_TEST_TIMEOUT_MS }, () => {
  let serverName: string;
  let backend: TmuxBackend;
  let spawned: IPtyProcess[];

  beforeEach(() => {
    serverName = uniqueServerName();
    backend = new TmuxBackend({ serverName, pollIntervalMs: 50 });
    spawned = [];
  });

  afterEach(async () => {
    for (const proc of spawned) {
      try {
        proc.kill();
      } catch {
        // Already exited — ignore.
      }
    }
    spawned = [];
    await backend.dispose();
    // Belt-and-suspenders: ensure the server is gone even if dispose() threw.
    killServer(serverName);
  });

  // ── spawn ──────────────────────────────────────────────────────────────────

  it('spawn creates a tmux session and returns a valid IPtyProcess', async () => {
    const proc = await backend.spawn('/bin/echo', ['hello'], { cols: 80, rows: 24 });
    spawned.push(proc);

    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.process).toBe('/bin/echo');
    expect(proc.cols).toBe(80);
    expect(proc.rows).toBe(24);
  });

  it('spawn marks tmux sessions with Makaio owner metadata', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    const metadata = tmuxExec(serverName, [
      'list-sessions',
      '-F',
      '#{session_name}\t#{@makaio-managed}\t#{@makaio-owner-pid}',
    ]);

    expect(metadata).toContain('\t1\t');
    expect(metadata).toContain(`\t${process.pid}`);
  });

  it('constructor removes stale Makaio-owned sessions only', async () => {
    await backend.dispose();

    const staleSession = `makaio-stale-${randomBytes(3).toString('hex')}`;
    const liveSession = `makaio-live-${randomBytes(3).toString('hex')}`;
    const unmarkedSession = `makaio-unmarked-${randomBytes(3).toString('hex')}`;

    createManagedSessionFixture(serverName, staleSession, 1_000_000_000);
    createManagedSessionFixture(serverName, liveSession, process.pid);
    execFileSync('tmux', ['-L', serverName, 'new-session', '-d', '-s', unmarkedSession, '/bin/cat'], {
      stdio: 'ignore',
    });

    backend = new TmuxBackend({ serverName, pollIntervalMs: 50 });

    const sessions = listSessionNames(serverName);
    expect(sessions).not.toContain(staleSession);
    expect(sessions).toContain(liveSession);
    expect(sessions).toContain(unmarkedSession);
  });

  // ── write ──────────────────────────────────────────────────────────────────

  it('write() sends text that appears in capture-pane output', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    const chunks: string[] = [];
    proc.onData((data) => chunks.push(data));

    proc.write('hello-from-write\r');

    await vi.waitFor(
      () => {
        expect(chunks.join('')).toContain('hello-from-write');
      },
      { timeout: 10_000 },
    );
  });

  // ── onData ─────────────────────────────────────────────────────────────────

  it('onData() receives output from commands', async () => {
    const proc = await backend.spawn('/bin/echo', ['tmux-output-test'], { cols: 80, rows: 24 });
    spawned.push(proc);

    const chunks: string[] = [];
    const disposable = proc.onData((data) => chunks.push(data));

    await vi.waitFor(
      () => {
        expect(chunks.join('')).toContain('tmux-output-test');
      },
      { timeout: 10_000 },
    );

    disposable.dispose();
  });

  it('onData() disposable stops delivering events after dispose()', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    const beforeDispose: string[] = [];
    const disposable = proc.onData((data) => beforeDispose.push(data));

    proc.write('first\r');

    await vi.waitFor(
      () => {
        expect(beforeDispose.join('')).toContain('first');
      },
      { timeout: 10_000 },
    );

    disposable.dispose();
    const capturedAfterDispose = beforeDispose.length;

    proc.write('second\r');

    // Allow time for potential spurious delivery.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Listener was disposed — second write must not deliver new chunks to it.
    expect(beforeDispose.length).toBe(capturedAfterDispose);
  });

  // ── onExit ─────────────────────────────────────────────────────────────────

  it('onExit() fires when the session process exits', async () => {
    const proc = await backend.spawn('/bin/echo', ['exit-test'], { cols: 80, rows: 24 });
    spawned.push(proc);

    let exitEvent: { exitCode: number; signal?: number } | undefined;
    const disposable = proc.onExit((e) => {
      exitEvent = e;
    });

    await vi.waitFor(
      () => {
        expect(exitEvent).toBeDefined();
      },
      { timeout: 15_000 },
    );

    // /bin/echo exits cleanly with code 0.
    expect(exitEvent!.exitCode).toBe(0);

    disposable.dispose();
  });

  // ── kill ───────────────────────────────────────────────────────────────────

  it('kill() terminates the session and triggers onExit', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    let exitEvent: { exitCode: number; signal?: number } | undefined;
    const disposable = proc.onExit((e) => {
      exitEvent = e;
    });

    proc.kill();

    await vi.waitFor(
      () => {
        expect(exitEvent).toBeDefined();
      },
      { timeout: 10_000 },
    );

    disposable.dispose();
  });

  it('kill() is idempotent — calling it twice does not throw', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    proc.kill();
    expect(() => proc.kill()).not.toThrow();
  });

  // ── resize ─────────────────────────────────────────────────────────────────

  it('resize() changes pane dimensions and reflects them in cols/rows', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    expect(proc.cols).toBe(80);
    expect(proc.rows).toBe(24);

    proc.resize(120, 40);

    expect(proc.cols).toBe(120);
    expect(proc.rows).toBe(40);

    proc.kill();
  });

  // ── dispose ────────────────────────────────────────────────────────────────

  it('dispose() kills all owned sessions and makes them inert', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    // Do NOT push to spawned — afterEach would call kill() on a dead session.

    await backend.dispose();

    // After disposal all write/resize/kill calls must silently no-op.
    expect(() => proc.write('anything')).not.toThrow();
    expect(() => proc.resize(100, 30)).not.toThrow();
    expect(() => proc.kill()).not.toThrow();
  });

  // ── exit code propagation ──────────────────────────────────────────────────

  it('onExit() reports a non-zero exit code', async () => {
    const proc = await backend.spawn('/bin/sh', ['-c', 'exit 42'], { cols: 80, rows: 24 });
    spawned.push(proc);

    let exitEvent: { exitCode: number; signal?: number } | undefined;
    proc.onExit((e) => {
      exitEvent = e;
    });

    await vi.waitFor(
      () => {
        expect(exitEvent).toBeDefined();
        expect(exitEvent!.exitCode).toBe(42);
      },
      { timeout: 15_000 },
    );
  });

  it('late onExit() registration receives the actual exit code', async () => {
    const proc = await backend.spawn('/bin/sh', ['-c', 'exit 7'], { cols: 80, rows: 24 });
    spawned.push(proc);

    // Wait until the process has fully exited by observing it via a primary listener.
    let primaryFired = false;
    proc.onExit(() => {
      primaryFired = true;
    });

    await vi.waitFor(
      () => {
        expect(primaryFired).toBe(true);
      },
      { timeout: 15_000 },
    );

    // Register a second listener after the process has already exited.
    let lateEvent: { exitCode: number; signal?: number } | undefined;
    proc.onExit((e) => {
      lateEvent = e;
    });

    // The late listener must have been called synchronously with the real exit code.
    expect(lateEvent).toBeDefined();
    expect(lateEvent!.exitCode).toBe(7);
  });

  // ── dispose guard ──────────────────────────────────────────────────────────

  it('spawn() after dispose() throws', async () => {
    await backend.dispose();

    await expect(backend.spawn('/bin/echo', ['hello'], { cols: 80, rows: 24 })).rejects.toThrow(
      'TmuxBackend has been disposed',
    );
  });

  // ── cwd ────────────────────────────────────────────────────────────────────

  it('spawn respects the cwd option', async () => {
    const proc = await backend.spawn('/bin/pwd', [], { cols: 80, rows: 24, cwd: '/tmp' });
    spawned.push(proc);

    const chunks: string[] = [];
    const disposable = proc.onData((data) => chunks.push(data));

    await vi.waitFor(
      () => {
        expect(chunks.join('')).toContain('/tmp');
      },
      { timeout: 10_000 },
    );

    disposable.dispose();
  });
});
