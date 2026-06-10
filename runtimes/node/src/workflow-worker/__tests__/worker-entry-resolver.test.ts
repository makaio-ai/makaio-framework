import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveWorkflowWorkerEntry } from '../worker-entry-resolver.js';

describe('resolveWorkflowWorkerEntry', () => {
  describe('source layout — running directly from the TypeScript source tree', () => {
    // moduleDir = <repo>/framework/runtimes/node/src
    const moduleDir = '/repo/framework/runtimes/node/src';

    it('returns the TypeScript worker-entry sibling path in source mode', () => {
      const result = resolveWorkflowWorkerEntry({ moduleDir, mode: 'source' });
      expect(result).toBe(join(moduleDir, 'workflow-worker', 'worker-entry.ts'));
    });

    it('returns the mjs worker-entry sibling path in dist mode', () => {
      const result = resolveWorkflowWorkerEntry({ moduleDir, mode: 'dist' });
      expect(result).toBe(join(moduleDir, 'workflow-worker', 'worker-entry.mjs'));
    });
  });

  describe('standalone dist layout — standalone @makaio/runtime-node package', () => {
    // moduleDir = <pkg>/dist
    const moduleDir = '/pkg/node_modules/@makaio/runtime-node/dist';

    it('returns the mjs worker-entry sibling path in dist mode', () => {
      const result = resolveWorkflowWorkerEntry({ moduleDir, mode: 'dist' });
      expect(result).toBe(join(moduleDir, 'workflow-worker', 'worker-entry.mjs'));
    });

    it('returns the ts worker-entry sibling path in source mode (edge case)', () => {
      const result = resolveWorkflowWorkerEntry({ moduleDir, mode: 'source' });
      expect(result).toBe(join(moduleDir, 'workflow-worker', 'worker-entry.ts'));
    });
  });

  describe('umbrella dist layout — @makaio/framework with sourceDist copied to dist/runtime-node', () => {
    // moduleDir = <pkg>/dist/runtime-node  (NOT <pkg>/dist — that would double-dist)
    const moduleDir = '/pkg/node_modules/@makaio/framework/dist/runtime-node';

    it('resolves to dist/runtime-node/workflow-worker/worker-entry.mjs, not dist/dist/…', () => {
      const result = resolveWorkflowWorkerEntry({ moduleDir, mode: 'dist' });
      expect(result).toBe(join(moduleDir, 'workflow-worker', 'worker-entry.mjs'));
      // Guard: must NOT contain the double-dist path that the old packageRoot
      // approach would have produced.
      expect(result).not.toContain(join('dist', 'dist'));
    });

    it('produces the full expected path under the umbrella package root', () => {
      const result = resolveWorkflowWorkerEntry({ moduleDir, mode: 'dist' });
      expect(result).toBe(
        join('/pkg/node_modules/@makaio/framework', 'dist', 'runtime-node', 'workflow-worker', 'worker-entry.mjs'),
      );
    });
  });
});
