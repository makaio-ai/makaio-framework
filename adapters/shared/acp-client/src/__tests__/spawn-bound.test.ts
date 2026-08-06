/**
 * The spawn wait is bounded, asserted on elapsed time.
 *
 * An error message proves nothing about a bound: a call that blocked for thirty
 * seconds produces the same message as one that blocked for a tenth of a second.
 * Only the clock catches a re-introduced unbounded await, so the clock is what
 * is asserted.
 */

import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { waitForSpawn } from '../proc-utils.js';

describe('waitForSpawn', () => {
  it('resolves once a real child has started', async () => {
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      await expect(waitForSpawn(proc, { timeoutMs: 10_000 })).resolves.toBeUndefined();
    } finally {
      proc.kill();
    }
  });

  it('rejects at its budget for a child that will never announce a start', async () => {
    // A genuine ChildProcess whose `spawn` event has already been delivered: a
    // later waiter receives neither `spawn` nor `error`, which is exactly the
    // "never announces itself" case and needs no stand-in to construct.
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    await waitForSpawn(proc, { timeoutMs: 10_000 });

    const budgetMs = 250;
    const startedAt = Date.now();
    try {
      await expect(waitForSpawn(proc, { timeoutMs: budgetMs })).rejects.toThrow(/did not start within/);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(budgetMs * 0.5);
      expect(elapsedMs).toBeLessThan(budgetMs * 4);
    } finally {
      proc.kill();
    }
  });

  it('rejects immediately when the wait is already abandoned', async () => {
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    await waitForSpawn(proc, { timeoutMs: 10_000 });

    try {
      await expect(waitForSpawn(proc, { timeoutMs: 10_000, signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
    } finally {
      proc.kill();
    }
  });

  it('rejects when the wait is abandoned while it is running', async () => {
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    await waitForSpawn(proc, { timeoutMs: 10_000 });
    const controller = new AbortController();

    try {
      const waiting = waitForSpawn(proc, { timeoutMs: 10_000, signal: controller.signal });
      controller.abort();
      await expect(waiting).rejects.toThrow(/aborted/);
    } finally {
      proc.kill();
    }
  });

  it('still rejects with the child own failure when it cannot be spawned', async () => {
    const proc = spawn('/definitely/missing/binary-for-spawn-bound-test', [], { stdio: 'ignore' });

    // The budget must not swallow the real cause: a spawn that fails outright is
    // more informative than a timeout, and it is the answer callers already act on.
    await expect(waitForSpawn(proc, { timeoutMs: 10_000 })).rejects.toThrow(/ENOENT/);
  });
});
