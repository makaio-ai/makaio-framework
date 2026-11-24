import { createBusInstance } from '@makaio/bus-core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { KernelMakaioExtension } from '../extension/types.js';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { constructContext } = useJournalHostFixture();

let coordinator: ExtensionCoordinator;
const name = 'feature';

beforeEach(() => {
  coordinator = new ExtensionCoordinator(createBusInstance(), {
    extensionContextBase: {
      constructContext,
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'machine-1',
      tryImport: async () => null,
    },
  });
});

afterEach(async () => {
  await coordinator.shutdown();
});

/**
 * Load one extension for lifecycle assertions.
 * @param create - Its service factory.
 */
function load(create: KernelMakaioExtension['create']): void {
  coordinator.load([{ name, displayName: 'Feature', version: '1.0.0', create }]);
}

it('runs static staging before create and init on startup and re-enable', async () => {
  const calls: string[] = [];
  coordinator.registerContributionProcessor({
    processActivating(extension, manifest) {
      calls.push(`stage:${extension}:${manifest.name}`);
    },
    async processActivated() {
      calls.push('activate');
    },
  });
  load(() => {
    calls.push('create');
    return {
      init() {
        calls.push('init');
      },
    };
  });

  await coordinator.startAll();
  const activation = ['stage:feature:feature', 'create', 'init', 'activate'];
  expect(calls).toEqual(activation);

  expect(await coordinator.applyExtensionTransition(name, false)).toBe('applied');
  expect(await coordinator.applyExtensionTransition(name, true)).toBe('applied');
  expect(calls).toEqual([...activation, ...activation]);
});

it('fails an entry before create when a staging hook throws and rolls back earlier hooks', async () => {
  const calls: string[] = [];
  coordinator.registerContributionProcessor({
    filter: () => false,
    processActivating() {
      calls.push('stage');
    },
    async processActivated() {
      calls.push('activate');
    },
    async processStopped() {
      calls.push('rollback');
    },
  });
  coordinator.registerContributionProcessor({
    processActivating() {
      calls.push('stage-failed');
      throw new Error('Staging failed');
    },
    async processActivated() {},
    async processStopped() {
      calls.push('rollback-failed-stage');
    },
  });
  load(() => {
    calls.push('create');
    return {};
  });

  await coordinator.startAll();

  expect(coordinator.getInfo(name)).toMatchObject({ state: 'failed', error: 'Staging failed' });
  expect(calls).toEqual(['stage', 'stage-failed', 'rollback-failed-stage', 'rollback']);
});

it.each(['create', 'init'] as const)('rolls back staging when %s fails', async (phase) => {
  const stopped: string[] = [];
  coordinator.registerContributionProcessor({
    processActivating() {},
    async processActivated() {},
    async processStopped(extension) {
      stopped.push(extension);
    },
  });
  const message = `${phase} failed`;
  load(() => {
    if (phase === 'create') throw new Error(message);
    return {
      init() {
        throw new Error(message);
      },
    };
  });

  await coordinator.startAll();

  expect(coordinator.getInfo(name)).toMatchObject({ state: 'failed', error: message });
  expect(stopped).toEqual([name]);

  expect(await coordinator.applyExtensionTransition(name, true)).toBe('rejected');
  expect(coordinator.getInfo(name)).toMatchObject({ state: 'failed', error: message });
  expect(stopped).toEqual([name, name]);
});
