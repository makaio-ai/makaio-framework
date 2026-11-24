import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { stubExtensionIdentity } from '@makaio/test-utils';
import type { ExtensionToken } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { TransitionPipelineToken } from '../../framework-packages.js';
import { createTransitionContributionProcessor } from '../transition-contribution-processor.js';
import { TransitionPipelineService } from '../transition-pipeline-service.js';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { makeContext: makeStubNodeExtensionContext } = useJournalHostFixture();

function makeContext(service?: TransitionPipelineService): KernelExtensionContext {
  const bus = createBusInstance();
  return makeStubNodeExtensionContext(bus, {
    identity: stubExtensionIdentity('pkg-transition'),
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/pkg-transition',
    username: 'test',
    machineId: 'machine-1',
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === TransitionPipelineToken.name ? service : undefined) as T | undefined,
  });
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

  describe('namespace ownership', () => {
    const action = () => ({
      async execute() {
        return undefined;
      },
    });

    async function activateWithRuleId(id: string): Promise<void> {
      const service = new TransitionPipelineService(createBusInstance());
      const pkg = {
        name: 'pkg-transition',
        displayName: 'Transition Package',
        version: '0.1.0',
        transitionRules: {
          rules: [{ id, on: 'artifact.created', action: { type: 'pkg-transition.capture' }, enabled: true }],
        },
      } satisfies KernelMakaioExtension;
      await createTransitionContributionProcessor().processActivated('pkg-transition', pkg, makeContext(service));
    }

    async function activateWithActionKey(key: string): Promise<void> {
      const service = new TransitionPipelineService(createBusInstance());
      const pkg = {
        name: 'pkg-transition',
        displayName: 'Transition Package',
        version: '0.1.0',
        transitionActions: { actions: { [key]: action } },
      } satisfies KernelMakaioExtension;
      await createTransitionContributionProcessor().processActivated('pkg-transition', pkg, makeContext(service));
    }

    it.each(['other-extension.capture-created', 'pkg-transition.'])('rejects rule id %s', async (id) => {
      await expect(activateWithRuleId(id)).rejects.toThrow(
        `TransitionContributionProcessor: rule '${id}' must be namespaced by extension 'pkg-transition.'`,
      );
    });

    it.each(['other-extension.capture', 'pkg-transition.'])('rejects action key %s', async (key) => {
      await expect(activateWithActionKey(key)).rejects.toThrow(
        `TransitionContributionProcessor: action type '${key}' must be namespaced by extension 'pkg-transition.'`,
      );
    });
  });
});
