import { createBusInstance, type IHostMakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { ownerOf } from '@makaio/bus-core/kernel-api';
import {
  NAMESPACE_ALREADY_OWNED,
  NAMESPACE_CAPABILITY_CLOSED,
  WORKER_NAMESPACE_CLAIM_UNAVAILABLE,
} from '@makaio/contracts/extension';
import { createBusNamespace } from '@makaio/core';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { KernelExtensionContext } from '../extension/types.js';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import { namespaceCapabilityFor, releaseExtensionNamespaces } from '../extension/namespace-capability.js';
import { NamespaceCapabilityClosedError } from '../index.js';

const first = createBusNamespace('example:first', { ready: z.object({}) });
const second = createBusNamespace('example:second', { ready: z.object({}) });
const third = createBusNamespace('example:third', { ready: z.object({}) });

const extensionContextBase = {
  platform: 'linux' as const,
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async () => null,
};

afterEach(() => vi.unstubAllEnvs());

it('exposes stable namespace claim error codes to extensions', () => {
  expect(NAMESPACE_ALREADY_OWNED).toBe('namespace-already-owned');
  expect(NAMESPACE_CAPABILITY_CLOSED).toBe('namespace-capability-closed');
  expect(WORKER_NAMESPACE_CLAIM_UNAVAILABLE).toBe('worker-namespace-claim-unavailable');
  expect(new NamespaceCapabilityClosedError('extension').code).toBe(NAMESPACE_CAPABILITY_CLOSED);
});

it('forgets manually released leases and releases outstanding leases on teardown', () => {
  const bus = createBusInstance();
  const identity = createExtensionIdentity('extension');
  const capability = namespaceCapabilityFor(bus, identity);
  const released = capability.lease(first);
  const release = vi.spyOn(released, 'release');
  capability.lease(second);

  released.release();
  expect(ownerOf(bus, first.name)).toBeUndefined();
  expect(ownerOf(bus, second.name)).toEqual({ kind: 'extension', extension: 'extension' });
  releaseExtensionNamespaces(identity);

  expect(release).toHaveBeenCalledTimes(1);
  expect(ownerOf(bus, second.name)).toBeUndefined();
});

it('attributes runtime claims to each extension and releases only that entry’s leases', async () => {
  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus, { extensionContextBase });
  coordinator.load([
    {
      name: 'first-extension',
      displayName: 'First Extension',
      version: '1.0.0',
      /**
       * Claim a namespace while creating the service.
       * @param ctx - Context supplied by the coordinator.
       */
      create(ctx) {
        ctx.namespaces.lease(first);
        return {};
      },
    },
    { name: 'second-extension', displayName: 'Second Extension', version: '1.0.0' },
  ]);

  try {
    await coordinator.startAll();
    await expect(coordinator.applyExtensionTransition('first-extension', false)).resolves.toBe('applied');
    await expect(coordinator.applyExtensionTransition('first-extension', true)).resolves.toBe('applied');
    expect(ownerOf(bus, first.name)).toEqual({ kind: 'extension', extension: 'first-extension' });

    coordinator.forExtension('second-extension', (_name, _pkg, ctx) => {
      expect(() => ctx.namespaces.lease(first)).toThrow(expect.objectContaining({ code: 'namespace-already-owned' }));
      ctx.namespaces.lease(third);
    });
    expect(ownerOf(bus, third.name)).toEqual({ kind: 'extension', extension: 'second-extension' });

    coordinator.forExtension('first-extension', (_name, _pkg, ctx) => {
      ctx.namespaces.lease(second);
      expect(ownerOf(bus, second.name)).toEqual({ kind: 'extension', extension: 'first-extension' });
      releaseExtensionNamespaces(ctx.identity);
      expect(() => ctx.namespaces.lease(second)).toThrow(
        expect.objectContaining({ name: 'NamespaceCapabilityClosedError', code: 'namespace-capability-closed' }),
      );
    });
    expect(ownerOf(bus, first.name)).toBeUndefined();
    expect(ownerOf(bus, second.name)).toBeUndefined();
    expect(ownerOf(bus, third.name)).toEqual({ kind: 'extension', extension: 'second-extension' });
  } finally {
    await coordinator.shutdown();
  }
});

it('exposes namespace registration on host buses and keeps extension buses assignable to the bus operations type', () => {
  expectTypeOf<KernelExtensionContext['bus']>().toExtend<IMakaioBus>();
  expectTypeOf<Extract<keyof KernelExtensionContext['bus'], 'registerNamespace' | 'registerNamespaces'>>().toBeNever();
  expectTypeOf(createBusInstance().registerNamespace(first).subjects).toEqualTypeOf<typeof first.subjects>();
});

it.each([
  'registerNamespace',
  'registerNamespaces',
] as const)('shares a manifest claim with a legacy factory call to %s and releases it on shutdown', async (method) => {
  vi.stubEnv('MAKAIO_DEBUG', 'true');
  const debugLog = vi.fn();
  const bus = createBusInstance({ debugLog });
  const coordinator = new ExtensionCoordinator(bus, { extensionContextBase });
  coordinator.load([
    {
      name: 'factory',
      displayName: 'Factory',
      version: '1.0.0',
      critical: true,
      namespaces: [first],
      /**
       * Claim the declared namespace again through the legacy carrier.
       * @param ctx - Context supplied by the coordinator.
       */
      async create(ctx) {
        const legacyBus = ctx.bus as IHostMakaioBus;
        if (method === 'registerNamespace') {
          const namespace = legacyBus.registerNamespace(first);
          expect(namespace.subjects).toBe(first.subjects);
          expect((await namespace.scopedBus(ctx.bus)).namespace).toBe(first.name);
        } else {
          legacyBus.registerNamespaces([first, second]);
        }
        return {};
      },
    },
  ]);
  try {
    await coordinator.startAll();
    expect(coordinator.getInfo('factory')?.state).toBe('active');
    expect(debugLog).toHaveBeenCalledWith(expect.stringMatching(/factory.*example:first/));
    expect(ownerOf(bus, first.name)).toEqual({ kind: 'extension', extension: 'factory' });
    if (method === 'registerNamespaces') {
      expect(debugLog).toHaveBeenCalledWith(expect.stringMatching(/factory.*example:second/));
      expect(ownerOf(bus, second.name)).toEqual({ kind: 'extension', extension: 'factory' });
    }
  } finally {
    await coordinator.shutdown();
  }
  expect(ownerOf(bus, first.name)).toBeUndefined();
  expect(ownerOf(bus, second.name)).toBeUndefined();
});

it('rolls back a failed carrier bulk registration and preserves existing claims', async () => {
  vi.stubEnv('MAKAIO_DEBUG', 'false');
  const debugLog = vi.fn();
  const bus = createBusInstance({ debugLog });
  bus.registerNamespace(third);
  const coordinator = new ExtensionCoordinator(bus, { extensionContextBase });
  coordinator.load([{ name: 'factory', displayName: 'Factory', version: '1.0.0' }]);
  try {
    await coordinator.startAll();
    coordinator.forExtension('factory', (_name, _pkg, ctx) => {
      const existing = ctx.namespaces.lease(first);
      const legacyBus = ctx.bus as IHostMakaioBus;
      expect(() => legacyBus.registerNamespaces([first, second, third])).toThrow(
        expect.objectContaining({ code: 'namespace-already-owned' }),
      );
      expect(ownerOf(bus, second.name)).toBeUndefined();
      expect(ownerOf(bus, first.name)).toEqual({ kind: 'extension', extension: 'factory' });
      expect(ownerOf(bus, third.name)).toEqual({ kind: 'host' });
      existing.release();
      expect(ownerOf(bus, first.name)).toBeUndefined();
    });
    expect(debugLog).not.toHaveBeenCalledWith(expect.stringMatching(/factory.*example:/));
  } finally {
    await coordinator.shutdown();
  }
});
