import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { CONFORMANCE_PATH, writeConformanceArtifacts } from '../lib/conformance/index.js';
import type { AdapterResult } from '../lib/conformance/index.js';

function createResult(adapter: string): AdapterResult {
  return {
    adapter,
    passed: 2,
    failed: 1,
    skipped: 0,
    duration: 123,
    errors: [
      { test: 'fails clearly', message: 'boom', file: '/repo/framework/adapters/implementations/__tests__/x.ts' },
    ],
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

function createEmptyResult(adapter: string): AdapterResult {
  return {
    adapter,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
    errors: [],
    unhandledErrors: [],
    schemaViolations: [],
  };
}

describe('conformance artifacts', () => {
  it('writes phase-aware result and schema violation artifacts', async () => {
    const dir = join(tmpdir(), `makaio-conformance-${randomUUID()}`);
    const resultPath = join(dir, 'result.json');
    const schemaPath = join(dir, 'schema.json');

    try {
      await writeConformanceArtifacts({
        results: [createResult('openai-node')],
        phase: 'reference-smoke',
        testFiles: [join(CONFORMANCE_PATH, 'agents.simple.test.ts')],
        resultOutputPath: resultPath,
        schemaViolationsOutputPath: schemaPath,
      });

      const resultArtifact = JSON.parse(await readFile(resultPath, 'utf8')) as {
        schemaVersion?: number;
        phase?: string;
        runs?: Array<{ adapter: string; status: string; testFiles: string[] }>;
      };
      const schemaArtifact = JSON.parse(await readFile(schemaPath, 'utf8')) as Array<{ adapter: string }>;

      expect(resultArtifact.schemaVersion).toBe(1);
      expect(resultArtifact.phase).toBe('reference-smoke');
      expect(resultArtifact.runs).toEqual([
        expect.objectContaining({
          adapter: 'openai-node',
          status: 'failed',
          testFiles: ['agents.simple.test.ts'],
        }),
      ]);
      expect(schemaArtifact).toEqual([expect.objectContaining({ adapter: 'openai-node' })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks zero-test adapter results as failed', async () => {
    const dir = join(tmpdir(), `makaio-conformance-${randomUUID()}`);
    const resultPath = join(dir, 'result.json');
    const schemaPath = join(dir, 'schema.json');

    try {
      await writeConformanceArtifacts({
        results: [createEmptyResult('openai-node')],
        testFiles: [],
        resultOutputPath: resultPath,
        schemaViolationsOutputPath: schemaPath,
      });

      const resultArtifact = JSON.parse(await readFile(resultPath, 'utf8')) as {
        runs?: Array<{ adapter: string; status: string }>;
      };

      expect(resultArtifact.runs).toEqual([expect.objectContaining({ adapter: 'openai-node', status: 'failed' })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
