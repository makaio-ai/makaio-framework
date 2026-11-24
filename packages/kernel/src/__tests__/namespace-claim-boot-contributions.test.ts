import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { KernelMakaioExtension } from '../extension/types.js';

it('releases all manifest claims when static surface collection aborts load', async () => {
  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus);
  const owners = coordinator.namespaceOwners();
  const first = {
    name: 'first',
    displayName: 'First',
    version: '1.0.0',
    namespaces: [createBusNamespace('first', { ping: z.object({}) })],
  };
  const window = { id: 'main', style: 'utility' } as const;
  const second = {
    name: 'second',
    displayName: 'Second',
    version: '1.0.0',
    dependencies: [{ type: 'extension', name: first.name, version: '1.0.0' }],
    namespaces: [createBusNamespace('second', { ping: z.object({}) })],
    windows: [window],
  } satisfies KernelMakaioExtension;

  expect(() => coordinator.load([first, { ...second, windows: [window, window] }])).toThrow(
    'WindowRegistry: duplicate window ID "second:main"',
  );
  expect([owners.ownerOf('first'), owners.ownerOf('second')]).toEqual([undefined, undefined]);

  const retry = new ExtensionCoordinator(bus);
  try {
    expect(retry.load([first, second])).toEqual([first, second]);
    expect(owners.ownerOf('first')).toEqual({ kind: 'extension', extension: 'first' });
    expect(owners.ownerOf('second')).toEqual({ kind: 'extension', extension: 'second' });
  } finally {
    await retry.shutdown();
  }
  expect([owners.ownerOf('first'), owners.ownerOf('second')]).toEqual([undefined, undefined]);
});

it('excludes a competing manifest claim from boot configuration and reports it at startup', async () => {
  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus);
  const namespace = createBusNamespace('shared', { ping: z.object({}) });
  const configureFirst = vi.fn();
  const configureSecond = vi.fn();

  try {
    const retained = coordinator.load([
      {
        name: 'first',
        displayName: 'First',
        version: '1.0.0',
        namespaces: [namespace],
        runtimeBoot: { configure: configureFirst },
      },
      {
        name: 'second',
        displayName: 'Second',
        version: '1.0.0',
        namespaces: [namespace],
        runtimeBoot: { configure: configureSecond },
      },
    ]);

    for (const pkg of retained) {
      pkg.runtimeBoot?.configure({
        bus,
        registerContributionProcessor: coordinator.registerContributionProcessor.bind(coordinator),
        forEachActiveExtension: coordinator.forEachActiveExtension.bind(coordinator),
      });
    }
    await coordinator.startAll();

    expect(coordinator.getInfo('second')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/namespace-already-owned.*first.*second/),
    });
    expect(configureFirst).toHaveBeenCalledOnce();
    expect(configureSecond).not.toHaveBeenCalled();
  } finally {
    await coordinator.shutdown();
  }
});

it('excludes an ownership conflict and its required dependents from boot contributions, surfaces and migrations', async () => {
  const bus = createBusInstance();
  const runMigrations = vi.fn(async () => {});
  const coordinator = new ExtensionCoordinator(bus, { runMigrations });
  const shared = createBusNamespace('shared', { ping: z.object({}) });
  const storage = { migrations: '/extensions/drizzle' };
  const winner = { name: 'winner', displayName: 'Winner', version: '1.0.0', namespaces: [shared], storage };
  const conflicted = { ...winner, name: 'conflicted', displayName: 'Conflicted' };
  const dependent = (name: string, dependency: string, optional = false): KernelMakaioExtension => ({
    name,
    displayName: name,
    version: '1.0.0',
    dependencies: [{ type: 'extension', name: dependency, version: '1.0.0', optional }],
    namespaces: [createBusNamespace(name, { ping: z.object({}) })],
    windows: [{ id: 'main', style: 'utility' }],
    runtimeBoot: { configure: vi.fn() },
    storage,
  });
  const direct = dependent('direct', conflicted.name);
  const transitive = dependent('transitive', direct.name);
  const optional = dependent('optional', conflicted.name, true);

  try {
    const retained = coordinator.load([winner, conflicted, direct, transitive, optional]);
    expect(retained.map((pkg) => pkg.name)).toEqual([winner.name, optional.name]);
    expect(coordinator.windowRegistry.get('direct:main')).toBeUndefined();
    expect(coordinator.windowRegistry.get('transitive:main')).toBeUndefined();
    expect(coordinator.windowRegistry.get('optional:main')).toBeDefined();
    expect(coordinator.namespaceOwners().ownerOf(direct.name)).toBeUndefined();
    expect(coordinator.namespaceOwners().ownerOf(transitive.name)).toBeUndefined();
    await coordinator.startAll();
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ name: winner.name }),
      expect.objectContaining({ name: optional.name }),
    ]);
    expect(coordinator.getInfo(direct.name)?.state).toBe('failed');
    expect(coordinator.getInfo(transitive.name)).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/namespace-already-owned.*winner.*conflicted/),
    });
    expect(coordinator.getInfo(optional.name)?.state).toBe('active');
  } finally {
    await coordinator.shutdown();
  }
});
