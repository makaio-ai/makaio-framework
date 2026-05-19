/**
 * Tests for {@link atomicModifyFile}.
 *
 * Uses real filesystem I/O under a per-test temporary directory so the
 * atomicity and serialization invariants are exercised end-to-end without any
 * fs module mocking.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { atomicModifyFile } from '../atomic-modify-file.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-modify-file-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Returns a Map instance shared across a single test's calls. */
function makeMutex(): Map<string, Promise<void>> {
  return new Map();
}

/**
 * Parse a test JSON object.
 * @param raw - Raw JSON value loaded by the helper
 * @returns Parsed object record
 */
function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected object JSON');
  }
  return raw as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('atomicModifyFile', () => {
  // -------------------------------------------------------------------------
  // ENOENT default path
  // -------------------------------------------------------------------------

  it('passes defaultContent to the modifier when the file does not exist', async () => {
    const filePath = path.join(tmpDir, 'missing.json');
    const defaultContent = { value: 0 };
    const receivedValues: Array<{ value: number }> = [];

    await atomicModifyFile(filePath, defaultContent, makeMutex(), parseObject, (current) => {
      receivedValues.push(current as { value: number });
      return { content: current, changed: false, result: undefined };
    });

    expect(receivedValues).toHaveLength(1);
    expect(receivedValues[0]).toEqual({ value: 0 });
  });

  // -------------------------------------------------------------------------
  // changed: false — no write
  // -------------------------------------------------------------------------

  it('does not write a file when the modifier returns changed: false', async () => {
    const filePath = path.join(tmpDir, 'no-write.json');

    await atomicModifyFile(filePath, { value: 1 }, makeMutex(), parseObject, (current) => ({
      content: current,
      changed: false,
      result: undefined,
    }));

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('does not leave a tmp file behind when changed: false', async () => {
    const filePath = path.join(tmpDir, 'no-write.json');

    await atomicModifyFile(filePath, { value: 1 }, makeMutex(), parseObject, (current) => ({
      content: current,
      changed: false,
      result: undefined,
    }));

    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rejects before modification when the parser does not accept disk JSON', async () => {
    const filePath = path.join(tmpDir, 'invalid.json');
    await fs.writeFile(filePath, '[]\n', 'utf-8');

    await expect(
      atomicModifyFile(filePath, {}, makeMutex(), parseObject, () => ({
        content: {},
        changed: true,
        result: undefined,
      })),
    ).rejects.toThrow('Expected object JSON');

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Happy path — changed: true
  // -------------------------------------------------------------------------

  it('writes the new content atomically when changed: true', async () => {
    const filePath = path.join(tmpDir, 'written.json');

    await atomicModifyFile(filePath, { value: 0 }, makeMutex(), parseObject, (current) => ({
      content: { value: (current as { value: number }).value + 1 },
      changed: true,
      result: undefined,
    }));

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ value: 1 });
  });

  it('forwards the modifier result as the resolved value', async () => {
    const filePath = path.join(tmpDir, 'result.json');

    const result = await atomicModifyFile(filePath, { done: false }, makeMutex(), parseObject, () => ({
      content: { done: true },
      changed: true,
      result: 42,
    }));

    expect(result).toBe(42);
  });

  it('reads back previously written content on the second call', async () => {
    const filePath = path.join(tmpDir, 'accumulate.json');
    const mutex = makeMutex();

    await atomicModifyFile(filePath, { count: 0 }, mutex, parseObject, (current) => ({
      content: { count: (current as { count: number }).count + 1 },
      changed: true,
      result: undefined,
    }));

    await atomicModifyFile(filePath, { count: 0 }, mutex, parseObject, (current) => ({
      content: { count: (current as { count: number }).count + 1 },
      changed: true,
      result: undefined,
    }));

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ count: 2 });
  });

  // -------------------------------------------------------------------------
  // Concurrent serialization
  // -------------------------------------------------------------------------

  it('serializes concurrent calls on the same path so writes do not interleave', async () => {
    const filePath = path.join(tmpDir, 'concurrent.json');
    const mutex = makeMutex();
    const order: number[] = [];

    const call = (id: number): Promise<void> =>
      atomicModifyFile(filePath, { count: 0 }, mutex, parseObject, async (current) => {
        order.push(id);
        // Yield to the microtask queue to maximise interleaving if calls ran in parallel.
        await Promise.resolve();
        const next = (current as { count: number }).count + 1;
        order.push(id);
        return { content: { count: next }, changed: true, result: undefined };
      });

    await Promise.all([call(1), call(2), call(3)]);

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ count: 3 });

    // Each call's two entries must be contiguous — no interleaving.
    for (let i = 0; i < order.length - 1; i += 2) {
      expect(order[i]).toBe(order[i + 1]);
    }
  });

  // -------------------------------------------------------------------------
  // Tmp file cleanup on modifier failure
  // -------------------------------------------------------------------------

  it('cleans up the tmp file when the modifier throws', async () => {
    const filePath = path.join(tmpDir, 'fail.json');

    await expect(
      atomicModifyFile(filePath, {}, makeMutex(), parseObject, () => {
        throw new Error('modifier error');
      }),
    ).rejects.toThrow('modifier error');

    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });

  it('removes the mutex entry after a successful call', async () => {
    const filePath = path.join(tmpDir, 'cleanup.json');
    const mutex = makeMutex();

    await atomicModifyFile(filePath, {}, mutex, parseObject, (current) => ({
      content: current,
      changed: false,
      result: undefined,
    }));

    expect(mutex.has(filePath)).toBe(false);
  });

  it('removes the mutex entry after a failed call', async () => {
    const filePath = path.join(tmpDir, 'cleanup-fail.json');
    const mutex = makeMutex();

    await expect(
      atomicModifyFile(filePath, {}, mutex, parseObject, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mutex.has(filePath)).toBe(false);
  });
});
