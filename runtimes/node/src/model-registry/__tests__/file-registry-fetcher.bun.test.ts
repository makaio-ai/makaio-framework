import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ModelRegistry } from '@makaio/services-core/model-registry';
import { FileRegistryFetcher } from '../file-registry-fetcher.js';

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

describe('FileRegistryFetcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-registry-fetcher-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should read and parse a valid JSON file', async () => {
    const filePath = path.join(tmpDir, 'registry.json');
    await fs.promises.writeFile(filePath, JSON.stringify(mockRegistry), 'utf-8');

    const fetcher = new FileRegistryFetcher(filePath);
    const result = await fetcher.fetch();

    expect(result).toEqual(mockRegistry);
  });

  it('should throw when file does not exist', async () => {
    const fetcher = new FileRegistryFetcher(path.join(tmpDir, 'nonexistent.json'));

    await expect(fetcher.fetch()).rejects.toThrow();
  });

  it('should throw when file contains invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'bad.json');
    await fs.promises.writeFile(filePath, 'not json', 'utf-8');

    const fetcher = new FileRegistryFetcher(filePath);

    await expect(fetcher.fetch()).rejects.toThrow();
  });
});
