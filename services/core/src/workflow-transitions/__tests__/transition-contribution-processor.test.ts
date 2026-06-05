import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { ExtensionToken } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { TransitionPipelineToken } from '../../framework-packages.js';
import { createTransitionContributionProcessor } from '../transition-contribution-processor.js';
import { TransitionPipelineService } from '../transition-pipeline-service.js';

function makeContext(service?: TransitionPipelineService): KernelExtensionContext {
  const bus = createBusInstance();
  return {
    bus,
    identity: {
      extensionName: 'pkg-transition',
    } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/pkg-transition',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === TransitionPipelineToken.name ? service : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

describe('createTransitionContributionProcessor', () => {
  it('rolls back rule registration when action registration fails during activation', async () => {
    const service = new TransitionPipelineService(createBusInstance());
    service.actionRegistry.register('other-extension', {
      'pkg-transition.capture': () => ({
        async execute() {
          return undefined;
        },
      }),
    });

    const processor = createTransitionContributionProcessor();
    const pkg = {
      name: 'pkg-transition',
      displayName: 'Transition Package',
      version: '0.1.0',
      transitionRules: {
        rules: [
          {
            id: 'pkg-transition.capture-created',
            on: 'artifact.created',
            action: { type: 'pkg-transition.capture' },
            enabled: true,
          },
        ],
      },
      transitionActions: {
        actions: {
          'pkg-transition.capture': () => ({
            async execute() {
              return undefined;
            },
          }),
        },
      },
    } satisfies KernelMakaioExtension;

    await expect(processor.processActivated('pkg-transition', pkg, makeContext(service))).rejects.toThrow(
      "duplicate action type 'pkg-transition.capture'",
    );

    expect(service.ruleRegistry.snapshotSource('pkg-transition')).toBeUndefined();
    expect(service.actionRegistry.has('pkg-transition.capture')).toBe(true);
  });
});
