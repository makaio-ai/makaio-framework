import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ownerOf } from '@makaio/bus-core/kernel-api';
import type { NamespaceCapability, NamespaceLease } from '@makaio/contracts/extension';
import { createBusNamespace } from '@makaio/core';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BootProgressObserver } from '../extension/boot-progress-observer.js';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import {
  claimManifestNamespaces,
  releaseEntryNamespaces,
  startExtensionEntry,
} from '../extension/extension-start-runner.js';
import { OpenContributionIndex } from '../extension/open-contribution-index.js';
import type { ExtensionContextBase, ExtensionEntry, KernelMakaioExtension } from '../extension/types.js';
import { ServiceSkipError } from '../service-skip-error.js';

const shared = createBusNamespace('shared', { ping: z.object({}) });
const runtime = createBusNamespace('runtime', { ping: z.object({}) });
const other = createBusNamespace('other', { ping: z.object({}) });
const owner = { kind: 'extension', extension: 'owner' };
const extensionContextBase: ExtensionContextBase = {
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async () => null,
};

/**
 * Build a manifest for a coordinator lifecycle test.
 * @param name - Unique extension name.
 * @param fields - Manifest fields specific to the test.
 * @returns The extension manifest.
 */
function extension(name: string, fields: Partial<KernelMakaioExtension> = {}): KernelMakaioExtension {
  return { name, displayName: name, version: '1.0.0', ...fields };
}

it.each([false, true])('isolates a competing manifest claim (critical: %s)', async (critical) => {
  const coordinator = new ExtensionCoordinator(createBusInstance());
  const owners = coordinator.namespaceOwners();
  coordinator.load([
    extension('first', { namespaces: [shared] }),
    extension('second', { namespaces: [other, shared], critical }),
    extension('third'),
  ]);

  try {
    if (critical) {
      await expect(coordinator.startAll()).rejects.toMatchObject({
        code: 'namespace-already-owned',
        owner: { kind: 'extension', extension: 'first' },
        requester: { kind: 'extension', extension: 'second' },
      });
    } else {
      await expect(coordinator.startAll()).resolves.toBeUndefined();
    }

    expect(coordinator.getInfo('second')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/namespace-already-owned.*first.*second/),
    });
    expect(coordinator.getInfo('first')?.state).toBe('active');
    expect(coordinator.getInfo('third')?.state).toBe(critical ? 'discovered' : 'active');
    expect(owners.ownerOf(shared.name)).toEqual({ kind: 'extension', extension: 'first' });
    expect(owners.ownerOf(other.name)).toBeUndefined();
  } finally {
    await coordinator.shutdown();
  }
});

it('releases manifest and runtime claims from failed startup before a later extension starts', async () => {
  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus, { extensionContextBase });
  const owners = coordinator.namespaceOwners();
  let beforeLaterStart: Array<ReturnType<typeof owners.ownerOf>> | undefined;
  coordinator.load([
    extension('broken', {
      namespaces: [shared],
      /**
       * Allocate a runtime namespace before failing startup.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        ctx.namespaces.lease(runtime);
        throw new Error('startup failed');
      },
    }),
    extension('later', {
      /**
       * Observe and claim the namespaces released by the failed extension.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        beforeLaterStart = [owners.ownerOf(shared.name), owners.ownerOf(runtime.name)];
        ctx.namespaces.lease(shared);
        ctx.namespaces.lease(runtime);
        return {};
      },
    }),
  ]);

  try {
    await coordinator.startAll();
    expect(coordinator.getInfo('broken')).toMatchObject({ state: 'failed', error: 'startup failed' });
    expect(beforeLaterStart).toEqual([undefined, undefined]);
    expect(coordinator.getInfo('later')?.state).toBe('active');
    expect(owners.ownerOf(shared.name)).toEqual({ kind: 'extension', extension: 'later' });
    expect(owners.ownerOf(runtime.name)).toEqual({ kind: 'extension', extension: 'later' });
  } finally {
    await coordinator.shutdown();
  }
});

it.each([
  { phase: 'start', retained: false },
  { phase: 'start', retained: true },
  { phase: 're-enable', retained: false },
  { phase: 're-enable', retained: true },
])('handles namespace ownership on skip during $phase (retained: $retained)', async ({ phase, retained }) => {
  const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase });
  const owners = coordinator.namespaceOwners();
  const destroy = vi.fn();
  let skip = phase === 'start';
  coordinator.load([
    extension('owner', {
      namespaces: [shared],
      /**
       * Claim a runtime namespace before initializing the service.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        ctx.namespaces.lease(runtime);
        return {
          init: () => {
            if (skip) {
              if (retained) destroy.mockRejectedValueOnce(new Error('destroy failed'));
              throw new ServiceSkipError('not configured');
            }
          },
          destroy,
        };
      },
    }),
  ]);

  try {
    await coordinator.startAll();
    if (phase === 're-enable') {
      expect(await coordinator.applyExtensionTransition('owner', false)).toBe('applied');
      skip = true;
      expect(await coordinator.applyExtensionTransition('owner', true)).toBe('rejected');
    }
    expect(coordinator.getInfo('owner')).toMatchObject({ state: 'skipped', error: 'not configured' });
    expect(owners.ownerOf(shared.name)).toEqual(retained ? owner : undefined);
    expect(owners.ownerOf(runtime.name)).toEqual(retained ? owner : undefined);
  } finally {
    await coordinator.shutdown();
  }
  expect(owners.ownerOf(shared.name)).toBeUndefined();
  expect(owners.ownerOf(runtime.name)).toBeUndefined();
});

it('releases claims on disable and failed re-enable, and reclaims them on retry', async () => {
  let failOnEnable = false;
  const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase });
  const owners = coordinator.namespaceOwners();
  const hostOwners = owners.listOwners();
  coordinator.load([
    extension('owner', {
      namespaces: [shared],
      /**
       * Register the runtime namespace on start and restart.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        ctx.namespaces.lease(runtime);
        if (failOnEnable) throw new Error('re-enable failed');
        return {};
      },
    }),
  ]);

  const expectedOwners = [
    ...hostOwners,
    { namespace: runtime.name, owner: { kind: 'extension', extension: 'owner' } },
    { namespace: shared.name, owner: { kind: 'extension', extension: 'owner' } },
  ];

  try {
    await coordinator.startAll();
    expect(owners.listOwners()).toEqual(expectedOwners);
    expect(await coordinator.applyExtensionTransition('owner', false)).toBe('applied');
    expect(owners.listOwners()).toEqual(hostOwners);
    expect(await coordinator.applyExtensionTransition('owner', true)).toBe('applied');
    expect(owners.listOwners()).toEqual(expectedOwners);

    expect(await coordinator.applyExtensionTransition('owner', false)).toBe('applied');
    failOnEnable = true;
    expect(await coordinator.applyExtensionTransition('owner', true)).toBe('rejected');
    expect(owners.listOwners()).toEqual(hostOwners);
    failOnEnable = false;
    expect(await coordinator.applyExtensionTransition('owner', true)).toBe('applied');
    expect(owners.listOwners()).toEqual(expectedOwners);
  } finally {
    await coordinator.shutdown();
  }

  expect(owners.listOwners()).toEqual(hostOwners);
  expect(owners.ownerOf(shared.name)).toBeUndefined();
  expect(owners.ownerOf(runtime.name)).toBeUndefined();
});

it('maintains one runtime lease across three disable and enable cycles', async () => {
  const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase });
  const owners = coordinator.namespaceOwners();
  const leases: NamespaceLease[] = [];
  coordinator.load([
    extension('owner', {
      namespaces: [shared],
      /**
       * Acquire the service's lease during each initialization.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        return { init: () => void leases.push(ctx.namespaces.lease(runtime)) };
      },
    }),
  ]);
  try {
    await coordinator.startAll();
    for (let cycle = 0; cycle < 3; cycle++) {
      const lease = leases.at(-1);
      expect(lease).toBeDefined();
      expect(await coordinator.applyExtensionTransition('owner', false)).toBe('applied');
      expect(owners.ownerOf(runtime.name)).toBeUndefined();
      expect(await coordinator.applyExtensionTransition('owner', true)).toBe('applied');
      lease?.release();
      expect(owners.ownerOf(shared.name)).toEqual(owner);
      expect(owners.ownerOf(runtime.name)).toEqual(owner);
      expect(leases).toHaveLength(cycle + 2);
    }
    leases.at(-1)?.release();
    expect(owners.ownerOf(runtime.name)).toBeUndefined();
  } finally {
    await coordinator.shutdown();
  }
});

it('closes a destroyed service capability and lets another extension claim its namespaces', async () => {
  const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase });
  const owners = coordinator.namespaceOwners();
  const destroy = vi.fn();
  let capability: NamespaceCapability | undefined;
  coordinator.load([
    extension('owner', {
      namespaces: [shared],
      /**
       * Capture the service capability and claim a runtime namespace.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        capability = ctx.namespaces;
        ctx.namespaces.lease(runtime);
        return { destroy };
      },
    }),
    extension('next-owner'),
  ]);
  try {
    await coordinator.startAll();
    expect(await coordinator.applyExtensionTransition('owner', false)).toBe('applied');
    expect(destroy).toHaveBeenCalledOnce();
    expect(() => capability?.lease(other)).toThrow(expect.objectContaining({ code: 'namespace-capability-closed' }));
    coordinator.forExtension('next-owner', (_name, _pkg, ctx) => {
      ctx.namespaces.lease(shared);
      ctx.namespaces.lease(runtime);
    });
    expect(owners.ownerOf(shared.name)).toEqual({ kind: 'extension', extension: 'next-owner' });
    expect(owners.ownerOf(runtime.name)).toEqual({ kind: 'extension', extension: 'next-owner' });
  } finally {
    await coordinator.shutdown();
  }
});

it.each([
  're-enable',
  'retry the entry start',
] as const)('opens a fresh namespace capability when asked to %s', async (retry) => {
  const bus = createBusInstance();
  const capabilities: NamespaceCapability[] = [];
  const pkg = extension('owner', {
    namespaces: [shared],
    /**
     * Claim a runtime namespace before failing the first activation.
     * @param ctx - Context supplied by the activation runner.
     */
    create(ctx) {
      capabilities.push(ctx.namespaces);
      ctx.namespaces.lease(runtime);
      if (capabilities.length === 1) throw new Error('startup failed');
      return {};
    },
  });

  if (retry === 're-enable') {
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase });
    coordinator.load([pkg]);
    try {
      await coordinator.startAll();
      expect(coordinator.getInfo('owner')).toMatchObject({ state: 'failed', error: 'startup failed' });
      expect(await coordinator.applyExtensionTransition('owner', true)).toBe('applied');
      expectFreshCapability(bus, capabilities);
    } finally {
      await coordinator.shutdown();
    }
    return;
  }

  const entry: ExtensionEntry = {
    pkg,
    identity: createExtensionIdentity(pkg.name),
    state: 'discovered',
    enabled: true,
    extensionManaged: true,
    surfacesCollected: true,
    warnings: [],
  };
  const bootProgress = new BootProgressObserver(bus, 1);
  const contributions = new OpenContributionIndex();
  const host = {
    bus,
    db: undefined,
    entries: new Map([[pkg.name, entry]]),
    contributionProcessors: [],
    bootProgress,
    contextHost: {
      bus,
      extensionContextBase,
      loadConfig: undefined,
      operatorConfig: undefined,
      signal: new AbortController().signal,
      hasActiveExtension: () => false,
      openContributionReaderFor: (name: string) => contributions.readerFor(name),
      getExtensionService: () => undefined,
    },
  };
  try {
    expect(claimManifestNamespaces(bus, entry)).toBeUndefined();
    await startExtensionEntry(host, pkg.name, entry);
    expect(entry).toMatchObject({ state: 'failed', error: 'startup failed' });
    await startExtensionEntry(host, pkg.name, entry);
    expect(entry.state).toBe('active');
    expect(entry.error).toBeUndefined();
    expectFreshCapability(bus, capabilities);
  } finally {
    releaseEntryNamespaces(entry);
    bootProgress.dispose();
  }
});

/**
 * Confirm activation reclaimed its namespaces with a different capability.
 * @param bus - Bus receiving the namespace claims.
 * @param capabilities - Capabilities captured by the initial and retry factories.
 */
function expectFreshCapability(bus: IMakaioBus, capabilities: readonly NamespaceCapability[]): void {
  expect(ownerOf(bus, shared.name)).toEqual(owner);
  expect(ownerOf(bus, runtime.name)).toEqual(owner);
  expect(capabilities).toHaveLength(2);
  expect(capabilities[1]).not.toBe(capabilities[0]);
  expect(() => capabilities[0]?.lease(other)).toThrow(expect.objectContaining({ code: 'namespace-capability-closed' }));
}

it('keeps manifest and runtime namespaces owned until shutdown destroys a retained startup service', async () => {
  const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase });
  const owners = coordinator.namespaceOwners();
  const destroy = vi.fn().mockRejectedValueOnce(new Error('destroy failed')).mockResolvedValue(undefined);
  coordinator.load([
    extension('owner', {
      namespaces: [shared],
      /**
       * Register a runtime namespace before startup fails.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        ctx.namespaces.lease(runtime);
        return { init: () => Promise.reject(new Error('init failed')), destroy };
      },
    }),
  ]);
  try {
    await coordinator.startAll();
    expect(coordinator.getInfo('owner')?.state).toBe('failed');
    expect(destroy).toHaveBeenCalledOnce();
    expect(owners.ownerOf(shared.name)).toEqual(owner);
    expect(owners.ownerOf(runtime.name)).toEqual(owner);
  } finally {
    await coordinator.shutdown();
  }
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(owners.ownerOf(shared.name)).toBeUndefined();
  expect(owners.ownerOf(runtime.name)).toBeUndefined();
});

it.each([
  'disable',
  're-enable',
] as const)('keeps both namespaces owned when destroy fails during %s', async (phase) => {
  let failDestroy = phase === 'disable';
  let failInit = false;
  const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase });
  const owners = coordinator.namespaceOwners();
  coordinator.load([
    extension('owner', {
      namespaces: [shared],
      /**
       * Register a runtime namespace and simulate an unsuccessful teardown.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        ctx.namespaces.lease(runtime);
        return {
          init: () => {
            if (failInit) throw new Error('init failed');
          },
          destroy: () => {
            if (failDestroy) throw new Error('destroy failed');
          },
        };
      },
    }),
  ]);
  try {
    await coordinator.startAll();
    expect(await coordinator.applyExtensionTransition('owner', false)).toBe('applied');
    if (phase === 're-enable') {
      failInit = true;
      failDestroy = true;
      expect(await coordinator.applyExtensionTransition('owner', true)).toBe('rejected');
    }
    expect(owners.ownerOf(shared.name)).toEqual(owner);
    expect(owners.ownerOf(runtime.name)).toEqual(owner);
    expect(await coordinator.applyExtensionTransition('owner', true)).toBe('rejected');
    expect(coordinator.getInfo('owner')?.error).toContain('retained until shutdown');
    expect(owners.ownerOf(shared.name)).toEqual(owner);
    expect(owners.ownerOf(runtime.name)).toEqual(owner);
  } finally {
    failDestroy = false;
    await coordinator.shutdown();
  }
  expect(owners.ownerOf(shared.name)).toBeUndefined();
  expect(owners.ownerOf(runtime.name)).toBeUndefined();
});
