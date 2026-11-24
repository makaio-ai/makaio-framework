import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { WorkflowSubjects, type ExtensionToken } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { useJournalHostFixture } from '@makaio/storage-conformance';
import { createTestCall, makeStubExtensionBus, stubExtensionIdentity } from '@makaio/test-utils';
import { defineTool, defineToolset, toolSuccess } from '@makaio/tools-core';
import type { Toolset } from '@makaio/tools-core';
import { ToolRegistryToken } from '../../framework-packages.js';
import { ToolRegistry } from '../tool-registry.js';
import { createToolContributionProcessor } from '../tool-contribution-processor.js';

const { makeContext: makeNodeContext } = useJournalHostFixture();

/**
 * Build a minimal toolset for test purposes.
 * @param name - Toolset name, also used as tool name prefix.
 * @returns A fully typed toolset with one echo tool.
 */
function makeToolset(name: string): Toolset {
  const echoTool = defineTool({
    name: `${name}.echo`,
    description: 'Echo input',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async (input) => toolSuccess({ value: input.value }),
  });

  return defineToolset({
    name,
    description: `${name} tools`,
    version: '1.0.0',
    tools: [echoTool],
  });
}

/**
 * Build a minimal ExtensionContext for test purposes.
 * @param registry - Optional ToolRegistry to expose via getService.
 * @param bus - Bus context shared by the registry and the contributing extension.
 * @returns Node context with real database and journal capabilities.
 */
function makeContext(registry?: ToolRegistry, bus = createBusInstance()): KernelExtensionContext {
  return makeNodeContext(makeStubExtensionBus(bus, 'pkg-tools'), {
    identity: stubExtensionIdentity('pkg-tools'),
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/pkg-tools',
    username: 'test',
    machineId: 'machine-1',
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === ToolRegistryToken.name ? registry : undefined) as T | undefined,
  });
}

describe('createToolContributionProcessor', () => {
  it('registers toolsets on activation and deregisters them on stop', async () => {
    const bus = createBusInstance();
    const registry = new ToolRegistry({ bus });
    const processor = createToolContributionProcessor();
    const pkg = {
      name: 'pkg-tools',
      displayName: 'Tools Package',
      version: '0.1.0',
      tools: { createToolsets: () => [makeToolset('alpha'), makeToolset('beta')] },
    } satisfies KernelMakaioExtension;

    await processor.processActivated('pkg-tools', pkg, makeContext(registry));
    expect(registry.listToolsets().map((entry) => entry.name)).toEqual(['alpha', 'beta']);

    await processor.processStopped?.('pkg-tools');
    expect(registry.listToolsets()).toEqual([]);

    registry.dispose();
  });

  it('uses the contributing extension as the caller of a tool request', async () => {
    const bus = createBusInstance();
    const registry = new ToolRegistry({ bus });
    const processor = createToolContributionProcessor();
    const captureCall = vi.fn();
    const unsubscribe = bus.on(WorkflowSubjects.getExecution, (ctx) => {
      captureCall(ctx.call);
      ctx.setResult({ execution: null });
    });
    const tool = defineTool({
      name: 'lookup-execution',
      description: 'Look up a workflow execution',
      inputSchema: z.object({ executionId: z.string() }),
      outputSchema: z.object({ found: z.boolean() }),
      execute: async (input, { bus, call }) => {
        assert(bus, 'The registry must supply an execution bus');
        const { execution } = await bus.request(call, WorkflowSubjects.getExecution, input);
        return toolSuccess({ found: execution !== null });
      },
    });
    const toolset = defineToolset({ name: 'lookup', description: 'Lookup tools', version: '1.0.0', tools: [tool] });
    const pkg = {
      name: 'pkg-tools',
      displayName: 'Tools Package',
      version: '0.1.0',
      tools: { createToolsets: () => [toolset] },
    } satisfies KernelMakaioExtension;
    const principal = { kind: 'makaio.host', id: 'tool-requester' } as const;

    try {
      await processor.processActivated('pkg-tools', pkg, makeContext(registry, bus));

      const result = await registry.execute(createTestCall({ principal }), 'lookup-execution', { executionId: 'run' });

      expect(result).toEqual({ success: true, data: { found: false } });
      expect(captureCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ caller: { kind: 'makaio.extension', id: 'pkg-tools' }, principal }),
      );
    } finally {
      await processor.processStopped?.('pkg-tools');
      unsubscribe();
      registry.dispose();
    }
  });

  it('rolls back already registered toolsets when a later register fails', async () => {
    const bus = createBusInstance();
    const registry = new ToolRegistry({ bus });
    const registerSpy = vi.spyOn(registry, 'register');

    // First call: delegate to real implementation
    registerSpy.mockImplementationOnce(async (toolset) => {
      await ToolRegistry.prototype.register.call(registry, toolset);
    });
    // Second call: simulate a registration failure
    registerSpy.mockRejectedValueOnce(new Error('duplicate tool'));

    const processor = createToolContributionProcessor();
    const pkg = {
      name: 'pkg-tools',
      displayName: 'Tools Package',
      version: '0.1.0',
      tools: { createToolsets: () => [makeToolset('alpha'), makeToolset('beta')] },
    } satisfies KernelMakaioExtension;

    await expect(processor.processActivated('pkg-tools', pkg, makeContext(registry))).rejects.toThrow('duplicate tool');
    expect(registry.listToolsets()).toEqual([]);

    registry.dispose();
  });

  it('throws a hard composition error when ToolRegistry is missing', async () => {
    const processor = createToolContributionProcessor();
    const pkg = {
      name: 'pkg-tools',
      displayName: 'Tools Package',
      version: '0.1.0',
      tools: { createToolsets: () => [makeToolset('alpha')] },
    } satisfies KernelMakaioExtension;

    await expect(processor.processActivated('pkg-tools', pkg, makeContext())).rejects.toThrow(
      'ToolRegistry is not available',
    );
  });
});
