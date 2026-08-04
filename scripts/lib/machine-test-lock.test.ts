/**
 * Contract tests for the machine-wide test lock.
 *
 * All tests operate on real lock directories under the OS temp dir; only the
 * process-liveness probe is injected so abandoned-lock scenarios are
 * reproducible.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isMachineTestLockEnabled, withMachineTestLock } from './machine-test-lock.js';

const scratchDirs: string[] = [];

/**
 * Create a scratch directory holding a lock path for one test.
 * @returns Absolute path to a not-yet-existing lock directory.
 */
function freshLockDir(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'machine-lock-test-'));
  scratchDirs.push(scratch);
  return join(scratch, 'lock');
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('isMachineTestLockEnabled', () => {
  it('is enabled for plain local environments only', () => {
    expect(isMachineTestLockEnabled({})).toBe(true);
    expect(isMachineTestLockEnabled({ CI: 'true' })).toBe(false);
    expect(isMachineTestLockEnabled({ MAKAIO_TEST_NO_MACHINE_LOCK: '1' })).toBe(false);
  });
});

describe('withMachineTestLock', () => {
  it('serializes concurrent holders and interleaves their batches', async () => {
    const lockDir = freshLockDir();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const holder = (label: string) =>
      withMachineTestLock(
        label,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(label);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active -= 1;
        },
        { lockDir, pollIntervalMs: 5, log: () => {} },
      );

    await Promise.all([holder('a'), holder('b'), holder('c')]);

    expect(maxActive).toBe(1);
    expect(order).toHaveLength(3);
  });

  it('steals a lock whose owner process is gone', async () => {
    const lockDir = freshLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 99999, acquiredAt: Date.now(), label: 'dead' }));

    const result = await withMachineTestLock('steal', async () => 'ran', {
      lockDir,
      pollIntervalMs: 5,
      isPidAlive: () => false,
      log: () => {},
    });

    expect(result).toBe('ran');
  });

  it('steals a lock with unreadable owner metadata once it exceeds the stale age', async () => {
    const lockDir = freshLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), 'not json');
    const past = (Date.now() - 60_000) / 1_000;
    utimesSync(lockDir, past, past);

    const result = await withMachineTestLock('steal-corrupt', async () => 'ran', {
      lockDir,
      pollIntervalMs: 5,
      staleAfterMs: 1_000,
      isPidAlive: () => true,
      log: () => {},
    });

    expect(result).toBe('ran');
  });

  it('steals a lock whose live owner has held it past the stale age', async () => {
    // The remaining branch of the staleness decision: owner metadata is
    // readable and the pid is alive, so only the recorded acquisition time can
    // condemn the lock. Without this branch a wedged-but-running holder would
    // block the machine indefinitely.
    const lockDir = freshLockDir();
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 60_000, label: 'wedged' }),
    );

    const result = await withMachineTestLock('steal-expired', async () => 'ran', {
      lockDir,
      pollIntervalMs: 5,
      staleAfterMs: 1_000,
      isPidAlive: () => true,
      log: () => {},
    });

    expect(result).toBe('ran');
  });

  it('releases the lock when the work fails', async () => {
    const lockDir = freshLockDir();

    await expect(
      withMachineTestLock('failing', () => Promise.reject(new Error('boom')), { lockDir, log: () => {} }),
    ).rejects.toThrow('boom');

    const result = await withMachineTestLock('after-failure', async () => 'ran', {
      lockDir,
      pollIntervalMs: 5,
      log: () => {},
    });
    expect(result).toBe('ran');
  });
});
