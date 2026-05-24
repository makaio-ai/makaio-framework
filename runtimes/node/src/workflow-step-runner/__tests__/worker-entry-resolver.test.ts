import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveWorkerEntry } from '../worker-entry-resolver.js';

describe('resolveWorkerEntry', () => {
  const packageRoot = '/opt/makaio/runtimes/node';

  it('returns TypeScript source path in source mode', () => {
    const result = resolveWorkerEntry({ packageRoot, mode: 'source' });

    expect(result).toBe(join(packageRoot, 'src', 'workflow-step-runner', 'worker-entry.ts'));
  });

  it('returns compiled ESM path in dist mode', () => {
    const result = resolveWorkerEntry({ packageRoot, mode: 'dist' });

    expect(result).toBe(join(packageRoot, 'dist', 'workflow-step-runner', 'worker-entry.mjs'));
  });

  it('handles package root with trailing separator', () => {
    const rootWithSlash = '/opt/makaio/runtimes/node/';
    const result = resolveWorkerEntry({ packageRoot: rootWithSlash, mode: 'source' });

    // path.join normalizes trailing slashes
    expect(result).toBe(join(rootWithSlash, 'src', 'workflow-step-runner', 'worker-entry.ts'));
  });
});
