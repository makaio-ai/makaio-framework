import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogFileWatcher, type FileChangeEvent } from '@makaio/file-watcher';

const fsPromisesMockState = vi.hoisted(() => ({
  delayedPath: undefined as string | undefined,
  statGate: undefined as Promise<void> | undefined,
  statCalls: [] as string[],
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  return {
    ...actual,
    stat: async (pathLike: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
      const filePath = typeof pathLike === 'string' ? pathLike : pathLike.toString();
      fsPromisesMockState.statCalls.push(filePath);

      if (fsPromisesMockState.delayedPath === filePath && fsPromisesMockState.statGate) {
        await fsPromisesMockState.statGate;
      }

      return actual.stat(pathLike, options);
    },
  };
});

describe('LogFileWatcher', () => {
  afterEach(() => {
    fsPromisesMockState.delayedPath = undefined;
    fsPromisesMockState.statGate = undefined;
    fsPromisesMockState.statCalls.length = 0;
    vi.restoreAllMocks();
  });

  it('deduplicates overlapping poll and immediate checks for the same file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watcher-'));
    const filePath = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(filePath, '{"id":"1"}\n', 'utf8');

    const watcher = new LogFileWatcher({ directory: tempDir, pattern: '*.jsonl' });
    const changeEvents: FileChangeEvent[] = [];
    const errorEvents: Array<{ error: Error; filePath?: string }> = [];
    const unsubscribeChange = watcher.on('change', (event) => {
      changeEvents.push(event);
    });
    const unsubscribeError = watcher.on('error', (event) => {
      errorEvents.push(event);
    });

    try {
      const startPromise = watcher.start();
      watcher.triggerImmediatePoll(filePath);
      await startPromise;

      await vi.waitFor(() => {
        expect(changeEvents).toHaveLength(1);
      });

      expect(changeEvents[0]).toMatchObject({
        filePath,
        changeType: 'created',
      });
      expect(errorEvents).toHaveLength(0);
    } finally {
      unsubscribeChange();
      unsubscribeError();
      watcher.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not emit or mutate tracked state after dispose while a check is in flight', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watcher-'));
    const filePath = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(filePath, '{"id":"1"}\n', 'utf8');

    const watcher = new LogFileWatcher({ directory: tempDir, pattern: '*.jsonl' });
    const changeEvents: FileChangeEvent[] = [];
    const unsubscribeChange = watcher.on('change', (event) => {
      changeEvents.push(event);
    });

    let releaseStat: (() => void) | undefined;
    const statGate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    fsPromisesMockState.delayedPath = filePath;
    fsPromisesMockState.statGate = statGate;

    try {
      watcher.triggerImmediatePoll(filePath);
      await vi.waitFor(() => {
        expect(fsPromisesMockState.statCalls).toContain(filePath);
      });

      watcher.dispose();
      releaseStat?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(changeEvents).toHaveLength(0);
      expect(watcher.getTrackedFiles().size).toBe(0);
    } finally {
      releaseStat?.();
      unsubscribeChange();
      watcher.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
