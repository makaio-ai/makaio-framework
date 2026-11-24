import { createBusInstance } from '@makaio/bus-core';
import type { RuleSourceContribution, RulesTriggerReader } from '@makaio/contracts/rules';
import { useJournalHostFixture } from '@makaio/storage-conformance';
import { expect, it, onTestFinished } from 'vitest';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';

const { constructContext } = useJournalHostFixture();
const sourceName = 'test-rules';

/** @returns A real coordinator with an isolated extension context. */
function createCoordinator(): ExtensionCoordinator {
  const coordinator = new ExtensionCoordinator(createBusInstance(), {
    extensionContextBase: {
      constructContext,
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'rule-source-test',
      tryImport: async () => null,
    },
  });
  onTestFinished(() => coordinator.shutdown());
  return coordinator;
}

it.each(['disable', 'shutdown'] as const)('releases the rule source before destroy during %s', async (operation) => {
  const coordinator = createCoordinator();
  let subscribed = false;
  const source: RuleSourceContribution = {
    rulesFor: async () => ({ set: null }),
    ruleTriggers: () => [],
    onTriggersChanged: () => {
      subscribed = true;
      return () => {
        subscribed = false;
      };
    },
  };
  const atDestroy: Array<{ source: RuleSourceContribution | undefined; subscribed: boolean }> = [];
  coordinator.load([
    {
      name: sourceName,
      displayName: 'Test rules',
      version: '1.0.0',
      ruleSource: source,
      create: () => ({
        destroy: () => {
          atDestroy.push({ source: coordinator.getRuleSource(), subscribed });
        },
      }),
    },
  ]);
  await coordinator.startAll();
  expect(coordinator.getRuleSource()).toBe(source);
  expect(subscribed).toBe(true);

  if (operation === 'disable') {
    await expect(coordinator.applyExtensionTransition(sourceName, false)).resolves.toBe('applied');
  } else {
    await coordinator.shutdown();
  }
  expect(atDestroy).toEqual([{ source: undefined, subscribed: false }]);
});

/**
 * Builds a source with an independently controlled trigger value and notification.
 * @param initial - Initial trigger parameter.
 * @returns The source, its active listeners, and a setter that queues no notifications.
 */
function createRuleFeed(initial: string) {
  const listeners = new Set<() => void>();
  let value = initial;
  const source: RuleSourceContribution = {
    rulesFor: async () => ({ set: null }),
    ruleTriggers: () => [{ kind: `${sourceName}.trigger`, params: value, subjects: ['test.changed'] }],
    onTriggersChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    setValue(next: string) {
      value = next;
    },
  };
}

it('binds the reactivated source and ignores a stale trigger callback', async () => {
  const coordinator = createCoordinator();
  const first = createRuleFeed('first');
  const second = createRuleFeed('second');
  let declaredSource = first.source;
  const readers: RulesTriggerReader[] = [];
  coordinator.load([
    {
      name: sourceName,
      displayName: 'Test rules',
      version: '1.0.0',
      get ruleSource() {
        return declaredSource;
      },
      create: (ctx) => {
        readers.push(ctx.rules.triggers());
        return {};
      },
    },
  ]);
  await coordinator.startAll();
  const [oldNotify] = first.listeners;
  const [oldReader] = readers;
  if (!oldNotify || !oldReader) throw new Error('Initial source did not start');
  expect(coordinator.getRuleSource()).toBe(first.source);
  expect(oldReader.current()).toEqual(first.source.ruleTriggers());
  const stopOldReader = oldReader.onChange(() => {});

  await expect(coordinator.applyExtensionTransition(sourceName, false)).resolves.toBe('applied');
  expect(coordinator.getRuleSource()).toBeUndefined();
  expect(first.listeners.size).toBe(0);
  declaredSource = second.source;
  await expect(coordinator.applyExtensionTransition(sourceName, true)).resolves.toBe('applied');

  const [newNotify] = second.listeners;
  const newReader = readers[1];
  if (!newNotify || !newReader) throw new Error('Replacement source did not start');
  expect(coordinator.getRuleSource()).toBe(second.source);
  expect(newReader.current()).toEqual(second.source.ruleTriggers());
  expect(oldReader.current()).toEqual([]);

  const changes: Array<ReturnType<RulesTriggerReader['current']>> = [];
  newReader.onChange(() => changes.push(newReader.current()));
  second.setValue('updated');
  // A notification already queued by the retired source can still arrive after unsubscribe.
  oldNotify();
  stopOldReader();
  expect(coordinator.getRuleSource()).toBe(second.source);
  expect(changes).toEqual([]);
  newNotify();
  expect(changes).toEqual([second.source.ruleTriggers()]);
});
