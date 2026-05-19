import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import type { AdapterResult } from '../lib/conformance/index.js';
import { runAdapterQueueWithSchemaArtifact } from '../lib/conformance/index.js';

function createResult(adapter: string): AdapterResult {
  return {
    adapter,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration: 1,
    errors: [],
    unhandledErrors: [],
    schemaViolations: [
      {
        subject: 'adapter:test.sdk.event',
        issues: ['type: Invalid input'],
        sample: { type: 'new_event' },
      },
    ],
  };
}

describe('conformance schema artifact writing', () => {
  it('writes the schema artifact even when adapter execution rejects', async () => {
    const dir = join(tmpdir(), `makaio-conformance-${randomUUID()}`);
    const artifactPath = join(dir, 'schema-violations.json');
    const results: AdapterResult[] = [];

    try {
      await expect(
        runAdapterQueueWithSchemaArtifact({
          adapters: ['rejecting-adapter'],
          adapterParallelism: 1,
          testFiles: [],
          verbose: false,
          results,
          schemaViolationsPath: artifactPath,
          runAdapter: async () => {
            throw new Error('adapter runtime failed');
          },
        }),
      ).rejects.toThrow('adapter runtime failed');

      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as unknown[];
      expect(artifact).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves completed adapter violations before a later adapter rejects', async () => {
    const dir = join(tmpdir(), `makaio-conformance-${randomUUID()}`);
    const artifactPath = join(dir, 'schema-violations.json');
    const results: AdapterResult[] = [];

    try {
      await expect(
        runAdapterQueueWithSchemaArtifact({
          adapters: ['completed-adapter', 'rejecting-adapter'],
          adapterParallelism: 1,
          testFiles: [],
          verbose: false,
          results,
          schemaViolationsPath: artifactPath,
          runAdapter: async (adapter) => {
            if (adapter === 'rejecting-adapter') throw new Error('adapter runtime failed');
            return createResult(adapter);
          },
        }),
      ).rejects.toThrow('adapter runtime failed');

      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as Array<{ adapter: string }>;
      expect(artifact).toEqual([expect.objectContaining({ adapter: 'completed-adapter' })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
