import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { ModelRegistry } from '@makaio/services-core/model-registry';
import { FileRegistryCache } from '../file-registry-cache.js';

const mockRegistry: ModelRegistry = {
  $schema: 'makaio/model-registry/v2',
  updatedAt: '2026-01-30T12:00:00.000Z',
  labs: {
    'test-lab': {
      name: 'Test Lab',
      models: [{ name: 'm1', friendlyName: 'M1', contextWindowSize: 8000, labId: 'test-lab' }],
    },
  },
  providers: {
    'test-provider': {
      name: 'Test',
      models: { m1: {} },
    },
  },
};

describe('FileRegistryCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-registry-cache-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('get() returns null when the cache file does not exist', async () => {
    const cache = new FileRegistryCache(path.join(tmpDir, 'nonexistent.json'));

    const result = await cache.get();

    expect(result).toBeNull();
  });

  it('get() returns null when the cache file contains invalid JSON', async () => {
    const cachePath = path.join(tmpDir, 'bad.json');
    await fs.promises.writeFile(cachePath, 'not valid json', 'utf-8');

    const cache = new FileRegistryCache(cachePath);
    const result = await cache.get();

    expect(result).toBeNull();
  });

  it('set() then get() round-trips the registry correctly', async () => {
    const cachePath = path.join(tmpDir, 'registry.json');
    const cache = new FileRegistryCache(cachePath);

    await cache.set(mockRegistry);
    const result = await cache.get();

    expect(result).toEqual(mockRegistry);
  });

  it('set() creates parent directories when they do not exist', async () => {
    const cachePath = path.join(tmpDir, 'nested', 'deeply', 'registry.json');
    const cache = new FileRegistryCache(cachePath);

    await cache.set(mockRegistry);

    const stat = await fs.promises.stat(cachePath);
    expect(stat.isFile()).toBe(true);
  });

  it('set() logs a warning when writing to a read-only path', async () => {
    const readOnlyDir = path.join(tmpDir, 'readonly');
    await fs.promises.mkdir(readOnlyDir);
    await fs.promises.chmod(readOnlyDir, 0o555);

    const cachePath = path.join(readOnlyDir, 'registry.json');
    const cache = new FileRegistryCache(cachePath);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await cache.set(mockRegistry);

    expect(warnSpy).toHaveBeenCalledWith('[FileRegistryCache] Failed to write cache:', expect.any(Error));
  });
});
