import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { loadWorkerRuntimeContributions } from '../worker-contributions.js';

describe('loadWorkerRuntimeContributions', () => {
  let root: string;
  let toolsEntrypoint: string;
  let adaptersEntrypoint: string;
  let brokenEntrypoint: string;
  let invalidEntrypoint: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-contributions-'));
    toolsEntrypoint = path.join(root, 'tools.mjs');
    adaptersEntrypoint = path.join(root, 'adapters.mjs');
    brokenEntrypoint = path.join(root, 'broken.mjs');
    invalidEntrypoint = path.join(root, 'invalid.mjs');
    await Promise.all([
      fs.writeFile(
        toolsEntrypoint,
        `export default { name: 'tools', displayName: 'Tools', tools: { createToolsets: () => [{ metadata: { name: 'tools', description: 'tools', version: '1.0.0' }, tools: {} }] } };`,
      ),
      fs.writeFile(adaptersEntrypoint, `export default { name: 'adapters', displayName: 'Adapters', adapters: [] };`),
      fs.writeFile(brokenEntrypoint, `throw new Error('module load failure');`),
      fs.writeFile(invalidEntrypoint, `export default { name: 'invalid', displayName: 'Invalid' };`),
    ]);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('imports toolsets only from verified worker-local entrypoints', async () => {
    const result = await loadWorkerRuntimeContributions([toolsEntrypoint, adaptersEntrypoint]);

    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0]?.metadata.name).toBe('tools');
  });

  it('accepts an empty verified identity realization', async () => {
    await expect(loadWorkerRuntimeContributions([])).resolves.toEqual({ toolsets: [] });
  });

  it('passes worker-local bus and cancellation to contribution factories', async () => {
    const contextEntrypoint = path.join(root, 'context.mjs');
    await fs.writeFile(
      contextEntrypoint,
      `export default { name: 'context', displayName: 'Context', tools: { createToolsets: (ctx) => [{ metadata: { name: ctx.bus && ctx.signal ? 'present' : 'missing', description: 'context', version: '1.0.0' }, tools: {} }] } };`,
    );
    const result = await loadWorkerRuntimeContributions([contextEntrypoint], {
      bus: createBusInstance(),
      signal: new AbortController().signal,
    });

    expect(result.toolsets[0]?.metadata.name).toBe('present');
  });

  it('fails closed when a verified entrypoint cannot import', async () => {
    await expect(loadWorkerRuntimeContributions([toolsEntrypoint, brokenEntrypoint])).rejects.toThrow(
      'module load failure',
    );
  });

  it('fails closed when an entrypoint is not an extension contribution', async () => {
    await expect(loadWorkerRuntimeContributions([invalidEntrypoint])).rejects.toThrow(
      'No recognizable extension export',
    );
  });
});
