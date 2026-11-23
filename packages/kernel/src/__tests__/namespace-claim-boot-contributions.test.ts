import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';

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
