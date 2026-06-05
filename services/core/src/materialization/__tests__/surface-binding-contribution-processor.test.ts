import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { ExtensionToken } from '@makaio/contracts';
import { defineSurfaceBinding, MaterializationSubjects } from '@makaio/contracts/materialization';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { describe, expect, it } from 'vitest';
import { SurfaceBindingRegistryToken } from '../../framework-packages.js';
import { createSurfaceBindingContributionProcessor } from '../surface-binding-contribution-processor.js';
import { SurfaceBindingRegistry } from '../surface-binding-registry.js';

/**
 * Build a minimal extension context that shares the given bus and exposes an
 * optional registry via `getService`.
 *
 * The context must share the same bus as the registry so that RPCs emitted by
 * the contribution processor reach the handler registered by the registry.
 * @param bus - The shared bus instance used by both registry and context.
 * @param registry - Registry instance to expose, or `undefined` to simulate a
 *   missing service.
 * @returns Minimal kernel extension context stub.
 */
function makeContext(bus: IMakaioBus, registry?: SurfaceBindingRegistry): KernelExtensionContext {
  return {
    bus,
    identity: {
      extensionName: 'test-ext',
    } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/test-ext',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === SurfaceBindingRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

describe('createSurfaceBindingContributionProcessor', () => {
  it('registers surface binding contributions through the registry service', async () => {
    const bus = createBusInstance();
    const registry = new SurfaceBindingRegistry(bus);
    await registry.init();
    const processor = createSurfaceBindingContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('github-ext', pkg, makeContext(bus, registry));

    const listed = await bus.request(MaterializationSubjects.surfaceBinding.list, {});
    expect(listed.bindings.map((b) => b.id)).toEqual(['github.status.field']);

    await registry.destroy();
  });

  it('registers multiple surface bindings from a single extension', async () => {
    const bus = createBusInstance();
    const registry = new SurfaceBindingRegistry(bus);
    await registry.init();
    const processor = createSurfaceBindingContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
          defineSurfaceBinding({
            id: 'github.priority.label',
            provider: 'github',
            namespace: 'priority',
            target: { kind: 'label' },
            appliesTo: ['workpiece', 'artifact'],
          }),
        ],
      },
    };

    await processor.processActivated('github-ext', pkg, makeContext(bus, registry));

    const listed = await bus.request(MaterializationSubjects.surfaceBinding.list, {});
    expect(listed.bindings.map((b) => b.id).sort()).toEqual(['github.priority.label', 'github.status.field']);

    await registry.destroy();
  });

  it('ignores packages without surface binding contributions', () => {
    const processor = createSurfaceBindingContributionProcessor();

    const plain: KernelMakaioExtension = { name: 'plain', displayName: 'Plain', version: '0.1.0' };
    expect(processor.filter!(plain)).toBe(false);

    const withEmpty: KernelMakaioExtension = {
      name: 'empty',
      displayName: 'Empty',
      version: '0.1.0',
      surfaceBindings: { bindings: [] },
    };
    expect(processor.filter!(withEmpty)).toBe(false);

    const withBindings: KernelMakaioExtension = {
      name: 'contrib',
      displayName: 'Contrib',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    expect(processor.filter!(withBindings)).toBe(true);
  });

  it('throws a hard composition error when SurfaceBindingRegistry is missing', async () => {
    const bus = createBusInstance();
    const processor = createSurfaceBindingContributionProcessor();
    const pkg: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await expect(processor.processActivated('github-ext', pkg, makeContext(bus))).rejects.toThrow(
      'SurfaceBindingRegistry is not available',
    );
  });

  it('deregisters surface bindings on processStopped and restores them on re-enable', async () => {
    const bus = createBusInstance();
    const registry = new SurfaceBindingRegistry(bus);
    await registry.init();
    const processor = createSurfaceBindingContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('github-ext', pkg, makeContext(bus, registry));
    await processor.processStopped?.('github-ext');
    await expect(bus.request(MaterializationSubjects.surfaceBinding.list, {})).resolves.toEqual({ bindings: [] });

    await processor.processActivated('github-ext', pkg, makeContext(bus, registry));
    const listed = await bus.request(MaterializationSubjects.surfaceBinding.list, {});
    expect(listed.bindings.map((entry) => entry.id)).toEqual(['github.status.field']);

    await registry.destroy();
  });

  it('replaces prior surface binding contributions when the same package reactivates', async () => {
    const bus = createBusInstance();
    const registry = new SurfaceBindingRegistry(bus);
    await registry.init();
    const processor = createSurfaceBindingContributionProcessor();

    const first: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    const replacement: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.1',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'State' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('github-ext', first, makeContext(bus, registry));
    await processor.processActivated('github-ext', replacement, makeContext(bus, registry));

    expect(registry.getBinding('github.status.field')?.target).toEqual({ kind: 'field', name: 'State' });

    await registry.destroy();
  });

  it('rolls back partial surface binding registrations when activation fails', async () => {
    const bus = createBusInstance();
    const registry = new SurfaceBindingRegistry(bus);
    await registry.init();
    const processor = createSurfaceBindingContributionProcessor();

    registry.registerBinding({
      id: 'github.priority.label',
      provider: 'github',
      namespace: 'priority',
      target: { kind: 'label' },
      appliesTo: ['workpiece'],
    });

    const pkg: KernelMakaioExtension = {
      name: 'failing-ext',
      displayName: 'Failing Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
          defineSurfaceBinding({
            id: 'github.priority.label',
            provider: 'github',
            namespace: 'priority',
            target: { kind: 'field', name: 'Priority' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await expect(processor.processActivated('failing-ext', pkg, makeContext(bus, registry))).rejects.toThrow(
      "Surface binding 'github.priority.label' is already registered",
    );

    const listed = await bus.request(MaterializationSubjects.surfaceBinding.list, {});
    expect(listed.bindings.map((entry) => entry.id).sort()).toEqual(['github.priority.label']);
    expect(registry.getBinding('github.status.field')).toBeUndefined();
    expect(registry.getBinding('github.priority.label')?.target).toEqual({ kind: 'label' });

    await registry.destroy();
  });

  it('restores prior surface binding contributions when reactivation fails', async () => {
    const bus = createBusInstance();
    const registry = new SurfaceBindingRegistry(bus);
    await registry.init();
    const processor = createSurfaceBindingContributionProcessor();

    const first: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'Status' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    const conflicting: KernelMakaioExtension = {
      name: 'priority-ext',
      displayName: 'Priority Extension',
      version: '0.1.0',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.priority.label',
            provider: 'github',
            namespace: 'priority',
            target: { kind: 'label' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    const replacement: KernelMakaioExtension = {
      name: 'github-ext',
      displayName: 'GitHub Extension',
      version: '0.1.1',
      surfaceBindings: {
        bindings: [
          defineSurfaceBinding({
            id: 'github.status.field',
            provider: 'github',
            namespace: 'status',
            target: { kind: 'field', name: 'State' },
            appliesTo: ['workpiece'],
          }),
          defineSurfaceBinding({
            id: 'github.priority.label',
            provider: 'github',
            namespace: 'priority',
            target: { kind: 'field', name: 'Priority' },
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('github-ext', first, makeContext(bus, registry));
    await processor.processActivated('priority-ext', conflicting, makeContext(bus, registry));
    await expect(processor.processActivated('github-ext', replacement, makeContext(bus, registry))).rejects.toThrow(
      "Surface binding 'github.priority.label' is already registered",
    );

    expect(registry.getBinding('github.status.field')?.target).toEqual({ kind: 'field', name: 'Status' });
    expect(registry.getBinding('github.priority.label')?.target).toEqual({ kind: 'label' });

    await registry.destroy();
  });
});
