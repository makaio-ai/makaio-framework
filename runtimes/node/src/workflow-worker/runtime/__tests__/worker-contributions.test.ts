import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ownerOf } from '@makaio/bus-core/kernel-api';
import { ToolSubjects, WorkflowSubjects } from '@makaio/contracts';
import { ExtensionStorageCapabilityError } from '@makaio/kernel';
import { createTestCall } from '@makaio/test-utils';
import { bootWorkerBus, bootWorkerRuntime } from '../worker-boot.js';
import { loadWorkerRuntimeContributions, WorkerNamespaceClaimError } from '../worker-contributions.js';

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
    expect(result.toolsets[0]?.toolset.metadata.name).toBe('tools');
  });

  it('accepts an empty verified identity realization', async () => {
    await expect(loadWorkerRuntimeContributions([])).resolves.toEqual({ toolsets: [] });
  });

  it.each([
    ['declared-storage', "storage: { migrations: './drizzle' }"],
    ['required-storage', "requires: [{ type: 'capability', id: 'storage.drizzle' }]"],
  ])('rejects %s before invoking its toolset factory', async (name, requirement) => {
    const entrypoint = path.join(root, `${name}.mjs`);
    await fs.writeFile(
      entrypoint,
      `export default { name: '${name}', displayName: '${name}', version: '1.0.0', ${requirement},
        tools: { createToolsets: () => { throw new Error('toolset factory invoked'); } } };`,
    );

    await expect(loadWorkerRuntimeContributions([entrypoint])).rejects.toMatchObject({
      constructor: ExtensionStorageCapabilityError,
      capability: 'storage.drizzle',
      extensions: [name],
    });
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

    expect(result.toolsets[0]?.toolset.metadata.name).toBe('present');
  });

  it('binds the worker bus to the loaded extension as its carrier', async () => {
    const carrierEntrypoint = path.join(root, 'carrier.mjs');
    await fs.writeFile(
      carrierEntrypoint,
      `export default { name: 'carrier-ext', displayName: 'Carrier', tools: { createToolsets: (ctx) => [{ metadata: { name: JSON.stringify({ caller: ctx.bus.own('start').caller, extensionName: ctx.identity.extensionName }), description: 'carrier', version: '1.0.0' }, tools: {} }] } };`,
    );
    const result = await loadWorkerRuntimeContributions([carrierEntrypoint], {
      bus: createBusInstance(),
      signal: new AbortController().signal,
    });

    const reported: unknown = JSON.parse(result.toolsets[0]?.toolset.metadata.name ?? 'null');
    expect(reported).toEqual({
      caller: { kind: 'makaio.extension', id: 'carrier-ext' },
      extensionName: 'carrier-ext',
    });
  });

  it('uses the loaded extension as the caller of a tool request in the worker runtime', async () => {
    const entrypoint = path.join(root, 'lookup.mjs');
    await fs.writeFile(
      entrypoint,
      `import { z } from ${JSON.stringify(import.meta.resolve('zod'))};
      const getExecution = ${JSON.stringify(WorkflowSubjects.getExecution)};
      const tool = {
        metadata: { name: 'lookup-execution', description: 'Look up a workflow execution' },
        inputSchema: z.object({ executionId: z.string() }),
        outputSchema: z.object({ found: z.boolean() }),
        async execute(input, { bus, call }) {
          const { execution } = await bus.request(call, getExecution, input);
          return { success: true, data: { found: execution !== null } };
        },
      };
      export default {
        name: 'lookup-extension',
        displayName: 'Lookup',
        tools: { createToolsets: () => [{
          metadata: { name: 'lookup', description: 'Lookup tools', version: '1.0.0' },
          tools: { 'lookup-execution': tool },
        }] },
      };`,
    );
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const captureCall = vi.fn();
    const unsubscribe = handle.bus.on(WorkflowSubjects.getExecution, (ctx) => {
      captureCall(ctx.call);
      ctx.setResult({ execution: null });
    });
    const principal = { kind: 'makaio.host', id: 'tool-requester' } as const;

    try {
      const contributions = await loadWorkerRuntimeContributions([entrypoint], { bus: handle.bus });
      const runtime = await bootWorkerRuntime(handle, contributions);
      try {
        const result = await handle.bus.request(createTestCall({ principal }), ToolSubjects.execute, {
          toolName: 'lookup-execution',
          input: { executionId: 'run' },
        });

        expect(result).toEqual({ success: true, data: { found: false } });
        expect(captureCall).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ caller: { kind: 'makaio.extension', id: 'lookup-extension' }, principal }),
        );
      } finally {
        await runtime.close();
      }
    } finally {
      unsubscribe();
      await handle.close();
    }
  });

  it('leaves the bus unset when no worker-local bus is supplied', async () => {
    const noBusEntrypoint = path.join(root, 'no-bus.mjs');
    await fs.writeFile(
      noBusEntrypoint,
      `export default { name: 'no-bus', displayName: 'NoBus', tools: { createToolsets: (ctx) => [{ metadata: { name: ctx.bus === undefined ? 'unset' : 'set', description: 'no bus', version: '1.0.0' }, tools: {} }] } };`,
    );
    const result = await loadWorkerRuntimeContributions([noBusEntrypoint]);

    expect(result.toolsets[0]?.toolset.metadata.name).toBe('unset');
  });

  it('throws a clear error when a toolset factory reads open contributions', async () => {
    const readerEntrypoint = path.join(root, 'reader.mjs');
    await fs.writeFile(
      readerEntrypoint,
      `export default { name: 'reader', displayName: 'Reader', tools: { createToolsets: (ctx) => { ctx.openContributions.of('some.kind'); return []; } } };`,
    );

    await expect(loadWorkerRuntimeContributions([readerEntrypoint])).rejects.toThrow(
      'Open contributions are not available in the workflow worker',
    );
  });

  it('throws a clear error when a toolset factory claims a namespace', async () => {
    const claimerEntrypoint = path.join(root, 'claimer.mjs');
    await fs.writeFile(
      claimerEntrypoint,
      `export default { name: 'claimer', displayName: 'Claimer', tools: { createToolsets: (ctx) => { ctx.namespaces.lease({ domain: 'claimer', subjects: {} }); return []; } } };`,
    );

    await expect(loadWorkerRuntimeContributions([claimerEntrypoint])).rejects.toThrow(
      'Namespace claims are not available in the workflow worker',
    );
  });

  it.each([
    ['lease', 'ctx.namespaces.lease(definition)'],
    ['registerNamespace', 'ctx.bus.registerNamespace(definition)'],
    ['registerNamespaces', 'ctx.bus.registerNamespaces([definition])'],
  ])('rejects %s with the same namespace claim error', async (method, claim) => {
    const entrypoint = path.join(root, `claimer-${method}.mjs`);
    await fs.writeFile(
      entrypoint,
      `const definition = { name: 'worker-probe', schemas: {}, subjects: {} };
      export default { name: 'claimer', tools: { createToolsets: (ctx) => { ${claim}; return []; } } };`,
    );

    const bus = createBusInstance();
    await expect(loadWorkerRuntimeContributions([entrypoint], { bus })).rejects.toBeInstanceOf(
      WorkerNamespaceClaimError,
    );
    expect(ownerOf(bus, 'worker-probe')).toBeUndefined();
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
