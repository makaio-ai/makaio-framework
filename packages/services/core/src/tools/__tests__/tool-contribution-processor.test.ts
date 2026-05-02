import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import type { NodeExtensionContext as ExtensionContext, ExtensionToken, MakaioExtension } from '@makaio/contracts';
import { defineTool, defineToolset, toolSuccess } from '@makaio/tools-core';
import type { Toolset } from '@makaio/tools-core';
import { ToolRegistryToken } from '../../framework-packages.js';
import { ToolRegistry } from '../tool-registry.js';
import { createToolContributionProcessor } from '../tool-contribution-processor.js';

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
 * @returns Minimal context stub satisfying the ExtensionContext contract.
 */
function makeContext(registry?: ToolRegistry): ExtensionContext {
  const bus = createBusInstance();
  return {
    bus,
    identity: {
      extensionName: 'pkg-tools',
    } as ExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/pkg-tools',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === ToolRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

describe('createToolContributionProcessor', () => {
  it('registers toolsets on activation and deregisters them on stop', async () => {
    const bus = createBusInstance();
    const registry = new ToolRegistry({ bus });
    const processor = createToolContributionProcessor();
    const pkg = {
      name: 'pkg-tools',
      displayName: 'Tools Package',
      tools: { createToolsets: () => [makeToolset('alpha'), makeToolset('beta')] },
    } satisfies MakaioExtension;

    await processor.processActivated('pkg-tools', pkg, makeContext(registry));
    expect(registry.listToolsets().map((entry) => entry.name)).toEqual(['alpha', 'beta']);

    await processor.processStopped?.('pkg-tools');
    expect(registry.listToolsets()).toEqual([]);

    registry.dispose();
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
      tools: { createToolsets: () => [makeToolset('alpha'), makeToolset('beta')] },
    } satisfies MakaioExtension;

    await expect(processor.processActivated('pkg-tools', pkg, makeContext(registry))).rejects.toThrow('duplicate tool');
    expect(registry.listToolsets()).toEqual([]);

    registry.dispose();
  });

  it('throws a hard composition error when ToolRegistry is missing', async () => {
    const processor = createToolContributionProcessor();
    const pkg = {
      name: 'pkg-tools',
      displayName: 'Tools Package',
      tools: { createToolsets: () => [makeToolset('alpha')] },
    } satisfies MakaioExtension;

    await expect(processor.processActivated('pkg-tools', pkg, makeContext())).rejects.toThrow(
      'ToolRegistry is not available',
    );
  });
});
