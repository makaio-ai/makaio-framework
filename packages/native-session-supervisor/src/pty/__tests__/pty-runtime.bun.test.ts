/**
 * Tests for PtyRuntime — spawn, buffering, subscriber tracking,
 * and disconnect-based orphan cleanup.
 */

import { describe, expect, it, mock, jest } from 'bun:test';
import type { IPtyBackend, IPtyProcess, PtyExitEvent, PtyOutputEvent } from '../types.js';
import { PtyRuntime } from '../pty-runtime.js';

// ---------------------------------------------------------------------------
// Fake PTY process factory
// ---------------------------------------------------------------------------

interface FakePtyProcess extends IPtyProcess {
  /** Simulate the PTY emitting output. */
  emitData(data: string): void;
  /** Simulate the PTY process exiting. */
  emitExit(exitCode: number, signal?: number): void;
}

function createFakePty(pid = 42, processName = '/bin/bash'): FakePtyProcess {
  let _cols = 80;
  let _rows = 24;

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();

  return {
    get pid() {
      return pid;
    },
    get process() {
      return processName;
    },
    get cols() {
      return _cols;
    },
    get rows() {
      return _rows;
    },
    write: mock(),
    resize: mock((_c: number, _r: number) => {
      _cols = _c;
      _rows = _r;
    }),
    kill: mock(),
    onData: (listener) => {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    emitData(data: string) {
      for (const l of dataListeners) l(data);
    },
    emitExit(exitCode: number, signal?: number) {
      for (const l of exitListeners) l({ exitCode, signal });
    },
  };
}

// ---------------------------------------------------------------------------
// Fake backend factory
// ---------------------------------------------------------------------------

function createFakeBackend(fakePty: FakePtyProcess): IPtyBackend {
  return {
    spawn: mock().mockResolvedValue(fakePty),
    dispose: mock().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sup_test_abc';

function makeRuntime(
  backend: IPtyBackend,
  onOutput: (evt: PtyOutputEvent) => void = mock(),
  onExit: (evt: PtyExitEvent) => void = mock(),
): PtyRuntime {
  return new PtyRuntime(backend, { onOutput, onExit });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PtyRuntime', () => {
  describe('spawn', () => {
    it('delegates to the backend and returns pid and processName', async () => {
      const fakePty = createFakePty(99, '/bin/zsh');
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      const result = await runtime.spawn({
        supervisorSessionId: SESSION_ID,
        file: '/bin/zsh',
        args: [],
        options: { cwd: '/home/user', cols: 80, rows: 24 },
      });

      expect(result.pid).toBe(99);
      expect(result.processName).toBe('/bin/zsh');
      expect(backend.spawn).toHaveBeenCalledWith('/bin/zsh', [], {
        cwd: '/home/user',
        cols: 80,
        rows: 24,
      });

      await runtime.destroy();
    });

    it('throws when called before init()', async () => {
      const backend = createFakeBackend(createFakePty());
      const runtime = makeRuntime(backend);

      await expect(
        runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} }),
      ).rejects.toThrow('PtyRuntime.spawn called before init()');
    });

    it('wraps backend errors with context', async () => {
      const backend: IPtyBackend = {
        spawn: mock().mockRejectedValue(new Error('native PTY unavailable')),
      };
      const runtime = makeRuntime(backend);
      runtime.init();

      await expect(
        runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} }),
      ).rejects.toThrow('Failed to spawn PTY (file=/bin/bash): native PTY unavailable');

      await runtime.destroy();
    });

    it('replaces a pre-existing session with the same supervisorSessionId', async () => {
      const fakePty1 = createFakePty(1, '/bin/bash');
      const fakePty2 = createFakePty(2, '/bin/zsh');
      const backend: IPtyBackend = {
        spawn: mock().mockResolvedValueOnce(fakePty1).mockResolvedValueOnce(fakePty2),
      };
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      expect(fakePty1.kill).not.toHaveBeenCalled();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/zsh', args: [], options: {} });
      expect(fakePty1.kill).toHaveBeenCalledOnce();

      const status = runtime.getSessionStatus(SESSION_ID);
      expect(status?.pid).toBe(2);

      await runtime.destroy();
    });
  });

  describe('output buffering', () => {
    it('buffers output data and reports it via getSessionStatus', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      fakePty.emitData('line-1\nline-2\n');

      const status = runtime.getSessionStatus(SESSION_ID);
      expect(status?.bufferedOutput).toBe('line-1\nline-2\n');
      expect(status?.lastSeq).toBe(1);

      await runtime.destroy();
    });

    it('increments sequence numbers per output chunk', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      fakePty.emitData('chunk-a');
      fakePty.emitData('chunk-b');

      const status = runtime.getSessionStatus(SESSION_ID);
      expect(status?.lastSeq).toBe(2);

      await runtime.destroy();
    });

    it('calls onOutput handler when subscribers are active', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const onOutput = mock();
      const runtime = makeRuntime(backend, onOutput);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      runtime.connect(SESSION_ID, null); // activate a subscriber before emitting
      fakePty.emitData('hello world');

      expect(onOutput).toHaveBeenCalledOnce();
      expect(onOutput).toHaveBeenCalledWith({
        supervisorSessionId: SESSION_ID,
        seq: 1,
        data: 'hello world',
      });

      await runtime.destroy();
    });

    it('suppresses onOutput when there are no active subscribers', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const onOutput = mock();
      const runtime = makeRuntime(backend, onOutput);
      runtime.init();

      // Sessions start with zero subscribers — no connect() call needed.
      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });

      fakePty.emitData('buffered');

      expect(onOutput).not.toHaveBeenCalled();

      const status = runtime.getSessionStatus(SESSION_ID);
      expect(status?.bufferedOutput).toBe('buffered'); // still buffered

      await runtime.destroy();
    });
  });

  describe('connect / disconnect', () => {
    it('connect returns buffered output since sinceSeq', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      fakePty.emitData('first\n');
      fakePty.emitData('second\n');

      runtime.disconnect(SESSION_ID);

      const result = runtime.connect(SESSION_ID, 1); // already seen seq=1

      expect(result).not.toBeNull();
      expect(result?.bufferedOutput).toBe('second\n');
      expect(result?.lastSeq).toBe(2);

      await runtime.destroy();
    });

    it('connect returns null for unknown session', () => {
      const runtime = makeRuntime(createFakeBackend(createFakePty()));
      runtime.init();

      expect(runtime.connect('nonexistent', null)).toBeNull();

      runtime.destroy();
    });

    it('connect clears disconnectedAt and disconnect re-sets it when count reaches zero', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      // Sessions start orphaned (disconnectedAt is set) — no subscriber yet.
      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      expect(runtime.getSessionStatus(SESSION_ID)?.disconnectedAt).not.toBeNull();

      // connect() clears the disconnect timestamp.
      runtime.connect(SESSION_ID, null);
      expect(runtime.getSessionStatus(SESSION_ID)?.disconnectedAt).toBeNull();

      // disconnect() re-sets it when the count drops to zero.
      runtime.disconnect(SESSION_ID);
      expect(runtime.getSessionStatus(SESSION_ID)?.disconnectedAt).not.toBeNull();

      await runtime.destroy();
    });

    it('disconnect never drives subscriber count below zero', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      runtime.disconnect(SESSION_ID);
      runtime.disconnect(SESSION_ID); // second call — should not crash

      expect(runtime.getSessionStatus(SESSION_ID)?.activeSubscriptions).toBe(0);

      await runtime.destroy();
    });
  });

  describe('exit events', () => {
    it('removes the session from registry on exit and calls onExit handler', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const onExit = mock();
      const runtime = makeRuntime(backend, mock(), onExit);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      fakePty.emitExit(0);

      expect(runtime.getSessionStatus(SESSION_ID)).toBeNull();
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({ supervisorSessionId: SESSION_ID, exitCode: 0, signal: undefined });

      await runtime.destroy();
    });
  });

  describe('write / resize / kill', () => {
    it('forwards write to the underlying PTY', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      const result = runtime.write(SESSION_ID, 'ls -la\n');

      expect(result).toBe(true);
      expect(fakePty.write).toHaveBeenCalledWith('ls -la\n');

      await runtime.destroy();
    });

    it('write returns false for unknown session', () => {
      const runtime = makeRuntime(createFakeBackend(createFakePty()));
      runtime.init();

      expect(runtime.write('nonexistent', 'hello')).toBe(false);

      runtime.destroy();
    });

    it('forwards resize to the underlying PTY', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      const result = runtime.resize(SESSION_ID, 120, 40);

      expect(result).toBe(true);
      expect(fakePty.resize).toHaveBeenCalledWith(120, 40);

      await runtime.destroy();
    });

    it('forwards kill to the underlying PTY', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      const result = runtime.kill(SESSION_ID, 'SIGTERM');

      expect(result).toBe(true);
      expect(fakePty.kill).toHaveBeenCalledWith('SIGTERM');

      await runtime.destroy();
    });
  });

  describe('orphan cleanup', () => {
    it('kills sessions that have been disconnected past the timeout', async () => {
      jest.useFakeTimers();

      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const onExit = mock();
      const runtime = makeRuntime(backend, mock(), onExit);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      runtime.disconnect(SESSION_ID);

      // Advance past the 5-minute orphan timeout plus one cleanup interval tick.
      jest.advanceTimersByTime(6 * 60 * 1000);

      expect(runtime.getSessionStatus(SESSION_ID)).toBeNull();
      expect(fakePty.kill).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({ supervisorSessionId: SESSION_ID, exitCode: 1 });

      jest.useRealTimers();
      await runtime.destroy();
    });

    it('does not clean up sessions that are still within the timeout window', async () => {
      jest.useFakeTimers();

      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      runtime.disconnect(SESSION_ID);

      // Advance by only 2 minutes — well within the 5-minute timeout.
      jest.advanceTimersByTime(2 * 60 * 1000);

      expect(runtime.getSessionStatus(SESSION_ID)).not.toBeNull();
      expect(fakePty.kill).not.toHaveBeenCalled();

      jest.useRealTimers();
      await runtime.destroy();
    });

    it('TOCTOU re-check: session re-connected just before cleanup fires is not deleted', async () => {
      // Invariant exercised: cleanupOrphans() uses a collect-then-delete
      // pattern. The deletion phase re-reads the live session state from the
      // Map (not the snapshot captured during the collect phase) to close the
      // TOCTOU window where connect() could have re-subscribed a session between
      // collection and deletion.
      //
      // Test mechanics:
      //   1. Spawn a session — it starts orphaned (disconnectedAt = spawn time).
      //   2. Advance time past the orphan timeout threshold but stop just before
      //      the next cleanup interval tick.
      //   3. Call connect() — this sets disconnectedAt = null and
      //      activeSubscriptions = 1.
      //   4. Advance time to fire the cleanup tick.
      //   5. The collect phase evaluates shouldCleanupSession() with the CURRENT
      //      live state: disconnectedAt = null → the session is NOT added to
      //      toCleanup → the deletion phase never sees it.
      //   6. Verify the session is still alive.
      //
      // Timing: cleanup fires every CLEANUP_INTERVAL_MS (30 s). The orphan
      // threshold is ORPHAN_CLEANUP_TIMEOUT_MS (300 s = 5 min). The first
      // cleanup tick that sees the session past the threshold fires at T+300 s
      // (shouldCleanupSession uses >=). We advance to T+299_999 ms, reconnect,
      // then advance 1 ms to fire the T+300 s tick and verify no deletion.
      jest.useFakeTimers();

      const fakePty = createFakePty(43, '/bin/zsh');
      const backend = createFakeBackend(fakePty);
      const onExit = mock();
      const TOCTOU_ID = 'sup_toctou';
      const runtime = makeRuntime(backend, mock(), onExit);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: TOCTOU_ID, file: '/bin/zsh', args: [], options: {} });

      // Advance to 1 ms before the first cleanup tick that would reap the
      // session (T+300 s, which is the 10th 30-second interval). The session
      // should still be present because no tick has crossed the threshold yet.
      jest.advanceTimersByTime(300_000 - 1);

      // Session is still present.
      expect(runtime.getSessionStatus(TOCTOU_ID)).not.toBeNull();

      // Re-subscribe before the T+300 s cleanup tick fires. connect() sets
      // disconnectedAt = null and activeSubscriptions = 1. The subsequent
      // cleanup tick's collect phase will see disconnectedAt === null and
      // skip the session before it even reaches the deletion-phase re-check.
      // This is the observable equivalent of the TOCTOU re-check invariant:
      // the deletion loop's re-read of the live Map state always wins over the
      // snapshot taken during collection.
      runtime.connect(TOCTOU_ID, null);

      // Fire the T+300 s cleanup tick.
      jest.advanceTimersByTime(1);

      expect(runtime.getSessionStatus(TOCTOU_ID)).not.toBeNull();
      expect(fakePty.kill).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();

      // Verify symmetry: after disconnect + full timeout the session IS reaped.
      runtime.disconnect(TOCTOU_ID);
      jest.advanceTimersByTime(6 * 60 * 1000);

      expect(runtime.getSessionStatus(TOCTOU_ID)).toBeNull();
      expect(fakePty.kill).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({ supervisorSessionId: TOCTOU_ID, exitCode: 1 });

      jest.useRealTimers();
      await runtime.destroy();
    });
  });

  describe('getScrollback', () => {
    it('returns paginated output from the buffer', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      fakePty.emitData('alpha\nbeta\ngamma\ndelta');

      const page = runtime.getScrollback(SESSION_ID, null, 0, 6);

      expect(page?.content).toBe('alpha\n');
      expect(page?.totalSize).toBe('alpha\nbeta\ngamma\ndelta'.length);
      expect(page?.hasMore).toBe(true);
      expect(page?.processName).toBe('/bin/bash');

      await runtime.destroy();
    });

    it('returns null for unknown session', () => {
      const runtime = makeRuntime(createFakeBackend(createFakePty()));
      runtime.init();

      expect(runtime.getScrollback('nonexistent', null, 0, 100)).toBeNull();

      runtime.destroy();
    });
  });

  describe('destroy', () => {
    it('kills all active sessions and releases backend resources', async () => {
      const fakePty = createFakePty();
      const backend = createFakeBackend(fakePty);
      const runtime = makeRuntime(backend);
      runtime.init();

      await runtime.spawn({ supervisorSessionId: SESSION_ID, file: '/bin/bash', args: [], options: {} });
      await runtime.destroy();

      expect(fakePty.kill).toHaveBeenCalledOnce();
      expect(backend.dispose).toHaveBeenCalledOnce();
      expect(runtime.getSessionStatus(SESSION_ID)).toBeNull();
    });

    it('is idempotent when called before init()', async () => {
      const backend = createFakeBackend(createFakePty());
      const runtime = makeRuntime(backend);

      await expect(runtime.destroy()).resolves.toBeUndefined();
    });
  });
});
