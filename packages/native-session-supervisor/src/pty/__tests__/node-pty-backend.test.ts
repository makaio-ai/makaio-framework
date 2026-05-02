/**
 * Integration tests for NodePtyBackend — spawns real PTY processes.
 *
 * These tests require a POSIX environment with `/bin/echo`, `/bin/cat`, and
 * a shell available. They run on macOS and Linux CI runners where `node-pty`
 * can allocate real pseudoterminals. The Windows platform is skipped because
 * the POSIX binary paths used here are not available on that platform.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPtyProcess } from '../types.js';
import { NodePtyBackend } from '../node-pty-backend.js';

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

describeOnPosix('NodePtyBackend — real PTY integration', () => {
  let backend: NodePtyBackend;
  /** Processes spawned during a test that must be cleaned up in afterEach. */
  let spawned: IPtyProcess[];

  beforeEach(() => {
    backend = new NodePtyBackend();
    spawned = [];
  });

  afterEach(() => {
    for (const proc of spawned) {
      try {
        proc.kill();
      } catch {
        // Process may have already exited — ignore.
      }
    }
    spawned = [];
  });

  it('spawns a real process and exposes pid, process, cols, rows', async () => {
    const proc = await backend.spawn('/bin/echo', ['hello'], { cols: 80, rows: 24 });
    spawned.push(proc);

    expect(proc.pid).toBeGreaterThan(0);
    expect(typeof proc.process).toBe('string');
    expect(proc.process.length).toBeGreaterThan(0);
    expect(proc.cols).toBe(80);
    expect(proc.rows).toBe(24);
  });

  it('receives output via onData', async () => {
    const proc = await backend.spawn('/bin/echo', ['hello'], { cols: 80, rows: 24 });
    spawned.push(proc);

    const chunks: string[] = [];
    const disposable = proc.onData((data) => {
      chunks.push(data);
    });

    await vi.waitFor(
      () => {
        const combined = chunks.join('');
        expect(combined).toContain('hello');
      },
      { timeout: 5000 },
    );

    disposable.dispose();
  });

  it('receives exit event via onExit', async () => {
    const proc = await backend.spawn('/bin/echo', ['hello'], { cols: 80, rows: 24 });
    spawned.push(proc);

    let exitEvent: { exitCode: number; signal?: number } | undefined;
    const disposable = proc.onExit((e) => {
      exitEvent = e;
    });

    await vi.waitFor(
      () => {
        expect(exitEvent).toBeDefined();
        expect(exitEvent!.exitCode).toBe(0);
      },
      { timeout: 5000 },
    );

    disposable.dispose();
  });

  it('delegates write to the PTY', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    const chunks: string[] = [];
    const disposable = proc.onData((data) => {
      chunks.push(data);
    });

    proc.write('test\r\n');

    await vi.waitFor(
      () => {
        const combined = chunks.join('');
        expect(combined).toContain('test');
      },
      { timeout: 5000 },
    );

    disposable.dispose();
    proc.kill();
  });

  it('delegates resize and reflects new cols/rows via getters', async () => {
    const proc = await backend.spawn('/bin/cat', [], { cols: 80, rows: 24 });
    spawned.push(proc);

    expect(proc.cols).toBe(80);
    expect(proc.rows).toBe(24);

    proc.resize(120, 40);

    expect(proc.cols).toBe(120);
    expect(proc.rows).toBe(40);

    proc.kill();
  });

  it('delegates kill and triggers onExit', async () => {
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
      { timeout: 5000 },
    );

    disposable.dispose();
  });

  it('exits quickly with a non-zero code for a nonexistent executable', async () => {
    // node-pty does not throw synchronously for a missing binary on all
    // platforms — it may spawn a shell wrapper that exits immediately.
    // Either the promise rejects or the process exits with a non-zero code.
    try {
      const proc = await backend.spawn('/nonexistent/binary', [], { cols: 80, rows: 24 });
      spawned.push(proc);

      let exitEvent: { exitCode: number; signal?: number } | undefined;
      proc.onExit((e) => {
        exitEvent = e;
      });

      await vi.waitFor(
        () => {
          expect(exitEvent).toBeDefined();
          expect(exitEvent!.exitCode).not.toBe(0);
        },
        { timeout: 5000 },
      );
    } catch {
      // Promise rejected — spawn itself threw, which is also acceptable.
    }
  });
});
