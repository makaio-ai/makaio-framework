import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import type { ExtensionToken } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { WorkflowBlockRegistryToken } from '../../framework-packages.js';
import { createWorkflowBlockContributionProcessor } from '../workflow-block-contribution-processor.js';
import { WorkflowBlockRegistry } from '../workflow-block-registry.js';

function makeContext(registry?: WorkflowBlockRegistry): KernelExtensionContext {
  const bus = createBusInstance();
  return {
    bus,
    identity: {
      extensionName: 'alpha',
    } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/alpha',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === WorkflowBlockRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

function makePackage(): KernelMakaioExtension {
  return {
    name: 'alpha',
    displayName: 'Alpha',
    version: '0.1.0',
    workflowBlocks: {
      blocks: {
        triggers: [
          {
            metadata: {
              name: 'alpha.review-posted',
              label: 'Review Posted',
              description: 'A review was posted.',
            },
            configSchema: z.object({}),
            outputSchema: z.object({ findingCount: z.number() }),
          },
        ],
        steps: [
          {
            metadata: {
              name: 'alpha.create-issue',
              label: 'Create Issue',
              description: 'Creates an issue.',
            },
            configSchema: z.object({ title: z.string() }),
            inputSchema: z.object({ body: z.string() }),
            outputSchema: z.object({ issueId: z.string() }),
            runs: {
              type: 'station',
              prompt: 'Create an issue with title {{ config.title }} and body {{ input.body }}.',
              role: 'alpha.issue-creator',
            },
          },
        ],
      },
    },
  };
}

describe('createWorkflowBlockContributionProcessor', () => {
  it('registers workflow blocks on activation and deregisters them on stop', async () => {
    const registry = new WorkflowBlockRegistry(createBusInstance());
    await registry.init();
    const processor = createWorkflowBlockContributionProcessor();

    await processor.processActivated('alpha', makePackage(), makeContext(registry));
    expect(registry.listTriggers().map((trigger) => trigger.metadata.name)).toEqual(['alpha.review-posted']);
    expect(registry.listSteps()[0]?.runs).toEqual({
      type: 'station',
      prompt: 'Create an issue with title {{ config.title }} and body {{ input.body }}.',
      role: 'alpha.issue-creator',
    });

    await processor.processStopped?.('alpha');
    expect(registry.listTriggers()).toEqual([]);

    await registry.destroy();
  });

  it('ignores packages without workflow block contributions', () => {
    const processor = createWorkflowBlockContributionProcessor();

    expect(processor.filter!({ name: 'plain', displayName: 'Plain', version: '0.1.0' })).toBe(false);
    expect(processor.filter!(makePackage())).toBe(true);
  });

  it('throws a hard composition error when the registry is missing', async () => {
    const processor = createWorkflowBlockContributionProcessor();

    await expect(processor.processActivated('alpha', makePackage(), makeContext())).rejects.toThrow(
      'WorkflowBlockRegistry is not available',
    );
  });
});
