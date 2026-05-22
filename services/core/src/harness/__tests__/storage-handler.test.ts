import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { HarnessSubjects } from '@makaio/contracts';
import { HarnessStorageSubjects } from '../storage/namespace.js';
import { createHarness, createTestDb } from './shared.js';

describe('Harness storage handlers', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = await createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => cleanup());

  it('creates and retrieves a harness', async () => {
    const harness = createHarness({ id: 'harness-1', name: 'Codex Native', adapterName: 'codex-app-server' });

    const { id } = await MakaioBus.request(HarnessStorageSubjects.set, { harness });
    expect(id).toBe('harness-1');

    const { harness: retrieved } = await MakaioBus.request(HarnessStorageSubjects.get, { id });
    expect(retrieved?.name).toBe('Codex Native');
    expect(retrieved?.adapterName).toBe('codex-app-server');
    expect(retrieved?.nativeTools.enabled).toEqual(['bash']);
  });

  it('filters list by adapter and name', async () => {
    await MakaioBus.request(HarnessStorageSubjects.set, {
      harness: createHarness({ id: 'codex-default', name: 'Default', adapterName: 'codex-app-server' }),
    });
    await MakaioBus.request(HarnessStorageSubjects.set, {
      harness: createHarness({ id: 'openai-default', name: 'Default', adapterName: 'openai-node' }),
    });

    const { harnesses: codexHarnesses } = await MakaioBus.request(HarnessStorageSubjects.list, {
      adapterName: 'codex-app-server',
      name: 'Default',
    });

    expect(codexHarnesses).toHaveLength(1);
    expect(codexHarnesses[0]?.id).toBe('codex-default');
  });

  it('updates timestamps on update', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let currentTime = 1_700_000_000_000;
    nowSpy.mockImplementation(() => currentTime);
    try {
      await MakaioBus.request(HarnessStorageSubjects.set, {
        harness: createHarness({ id: 'update-me', approvalPolicy: 'always-ask' }),
      });

      const { harness: original } = await MakaioBus.request(HarnessStorageSubjects.get, { id: 'update-me' });
      expect(original).not.toBeNull();

      currentTime += 1_000;

      await MakaioBus.request(HarnessStorageSubjects.set, {
        harness: createHarness({ id: 'update-me', approvalPolicy: 'full-access' }),
      });

      const { harness: updated } = await MakaioBus.request(HarnessStorageSubjects.get, { id: 'update-me' });
      expect(updated?.createdAt).toEqual(original?.createdAt);
      expect(updated?.updatedAt).toBeGreaterThan(original?.updatedAt ?? 0);
      expect(updated?.approvalPolicy).toBe('full-access');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('deletes harnesses and returns status', async () => {
    await MakaioBus.request(HarnessStorageSubjects.set, {
      harness: createHarness({ id: 'delete-me' }),
    });

    const { deleted } = await MakaioBus.request(HarnessStorageSubjects.delete, { id: 'delete-me' });
    expect(deleted).toBe(true);

    const { harness } = await MakaioBus.request(HarnessStorageSubjects.get, { id: 'delete-me' });
    expect(harness).toBeNull();
  });

  describe('Lifecycle events', () => {
    it('emits created on insert', async () => {
      const handler = vi.fn();
      const unsubscribe = MakaioBus.on(HarnessSubjects.created, (ctx) => handler(ctx.payload));
      try {
        await MakaioBus.request(HarnessStorageSubjects.set, {
          harness: createHarness({ id: 'lc-1', name: 'Lifecycle Test' }),
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'lc-1', name: 'Lifecycle Test' }));
      } finally {
        unsubscribe();
      }
    });

    it('emits updated on upsert of existing entity', async () => {
      await MakaioBus.request(HarnessStorageSubjects.set, {
        harness: createHarness({ id: 'lc-2', name: 'Original' }),
      });

      const handler = vi.fn();
      const unsubscribe = MakaioBus.on(HarnessSubjects.updated, (ctx) => handler(ctx.payload));
      try {
        await MakaioBus.request(HarnessStorageSubjects.set, {
          harness: createHarness({ id: 'lc-2', name: 'Updated' }),
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'lc-2', name: 'Updated' }));
      } finally {
        unsubscribe();
      }
    });

    it('emits deleted on removal', async () => {
      await MakaioBus.request(HarnessStorageSubjects.set, {
        harness: createHarness({ id: 'lc-3', name: 'To Delete' }),
      });

      const handler = vi.fn();
      const unsubscribe = MakaioBus.on(HarnessSubjects.deleted, (ctx) => handler(ctx.payload));
      try {
        await MakaioBus.request(HarnessStorageSubjects.delete, { id: 'lc-3' });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ id: 'lc-3' });
      } finally {
        unsubscribe();
      }
    });
  });
});
