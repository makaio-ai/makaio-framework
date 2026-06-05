import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { ExtensionToken } from '@makaio/contracts';
import { defineFacetNamespace, FacetSubjects } from '@makaio/contracts/facet';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { describe, expect, it } from 'vitest';
import { FacetNamespaceRegistryToken } from '../../framework-packages.js';
import { createFacetNamespaceContributionProcessor } from '../facet-contribution-processor.js';
import { FacetNamespaceRegistry } from '../facet-namespace-registry.js';

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
function makeContext(bus: IMakaioBus, registry?: FacetNamespaceRegistry): KernelExtensionContext {
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
      (token.name === FacetNamespaceRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

describe('createFacetNamespaceContributionProcessor', () => {
  it('registers executable facet namespace contributions through the registry service', async () => {
    const bus = createBusInstance();
    const registry = new FacetNamespaceRegistry(bus);
    await registry.init();
    const processor = createFacetNamespaceContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'status-ext',
      displayName: 'Status Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['pending', 'completed'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('status-ext', pkg, makeContext(bus, registry));

    const listed = await bus.request(FacetSubjects.namespace.list, {});
    expect(listed.namespaces.map((n) => n.namespace)).toEqual(['status']);

    await registry.destroy();
  });

  it('registers multiple facet namespaces from a single extension', async () => {
    const bus = createBusInstance();
    const registry = new FacetNamespaceRegistry(bus);
    await registry.init();
    const processor = createFacetNamespaceContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'multi-ext',
      displayName: 'Multi Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['pending'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
          defineFacetNamespace({
            namespace: 'priority',
            cardinality: 'single',
            values: ['low', 'high'],
            authority: ['human'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('multi-ext', pkg, makeContext(bus, registry));

    const listed = await bus.request(FacetSubjects.namespace.list, {});
    expect(listed.namespaces.map((n) => n.namespace).sort()).toEqual(['priority', 'status']);

    await registry.destroy();
  });

  it('ignores packages without facet namespace contributions', () => {
    const processor = createFacetNamespaceContributionProcessor();

    const plain: KernelMakaioExtension = { name: 'plain', displayName: 'Plain', version: '0.1.0' };
    expect(processor.filter!(plain)).toBe(false);

    const withEmpty: KernelMakaioExtension = {
      name: 'empty',
      displayName: 'Empty',
      version: '0.1.0',
      facetNamespaces: { namespaces: [] },
    };
    expect(processor.filter!(withEmpty)).toBe(false);

    const withNamespaces: KernelMakaioExtension = {
      name: 'contrib',
      displayName: 'Contrib',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['active'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    expect(processor.filter!(withNamespaces)).toBe(true);
  });

  it('throws a hard composition error when FacetNamespaceRegistry is missing', async () => {
    const bus = createBusInstance();
    const processor = createFacetNamespaceContributionProcessor();
    const pkg: KernelMakaioExtension = {
      name: 'status-ext',
      displayName: 'Status Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['pending'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await expect(processor.processActivated('status-ext', pkg, makeContext(bus))).rejects.toThrow(
      'FacetNamespaceRegistry is not available',
    );
  });

  it('deregisters facet namespaces on processStopped and restores them on re-enable', async () => {
    const bus = createBusInstance();
    const registry = new FacetNamespaceRegistry(bus);
    await registry.init();
    const processor = createFacetNamespaceContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'status-ext',
      displayName: 'Status Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['pending'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('status-ext', pkg, makeContext(bus, registry));
    await processor.processStopped?.('status-ext');
    await expect(bus.request(FacetSubjects.namespace.list, {})).resolves.toEqual({ namespaces: [] });

    await processor.processActivated('status-ext', pkg, makeContext(bus, registry));
    const listed = await bus.request(FacetSubjects.namespace.list, {});
    expect(listed.namespaces.map((entry) => entry.namespace)).toEqual(['status']);

    await registry.destroy();
  });

  it('replaces prior facet namespace contributions when the same package reactivates', async () => {
    const bus = createBusInstance();
    const registry = new FacetNamespaceRegistry(bus);
    await registry.init();
    const processor = createFacetNamespaceContributionProcessor();

    const first: KernelMakaioExtension = {
      name: 'status-ext',
      displayName: 'Status Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['pending'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    const replacement: KernelMakaioExtension = {
      name: 'status-ext',
      displayName: 'Status Extension',
      version: '0.1.1',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['active'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('status-ext', first, makeContext(bus, registry));
    await processor.processActivated('status-ext', replacement, makeContext(bus, registry));

    expect(registry.getNamespace('status')?.values).toEqual(['active']);

    await registry.destroy();
  });

  it('rolls back partial facet namespace registrations when activation fails', async () => {
    const bus = createBusInstance();
    const registry = new FacetNamespaceRegistry(bus);
    await registry.init();
    const processor = createFacetNamespaceContributionProcessor();

    registry.registerNamespace({
      namespace: 'priority',
      cardinality: 'single',
      values: ['low'],
      authority: ['human'],
      appliesTo: ['workpiece'],
    });

    const pkg: KernelMakaioExtension = {
      name: 'failing-ext',
      displayName: 'Failing Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['pending'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
          defineFacetNamespace({
            namespace: 'priority',
            cardinality: 'single',
            values: ['high'],
            authority: ['human'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await expect(processor.processActivated('failing-ext', pkg, makeContext(bus, registry))).rejects.toThrow(
      "Facet namespace 'priority' is already registered",
    );

    const listed = await bus.request(FacetSubjects.namespace.list, {});
    expect(listed.namespaces.map((entry) => entry.namespace).sort()).toEqual(['priority']);
    expect(registry.getNamespace('status')).toBeUndefined();
    expect(registry.getNamespace('priority')?.values).toEqual(['low']);

    await registry.destroy();
  });

  it('restores prior facet namespace contributions when reactivation fails', async () => {
    const bus = createBusInstance();
    const registry = new FacetNamespaceRegistry(bus);
    await registry.init();
    const processor = createFacetNamespaceContributionProcessor();

    const first: KernelMakaioExtension = {
      name: 'status-ext',
      displayName: 'Status Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['pending'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    const conflicting: KernelMakaioExtension = {
      name: 'other-ext',
      displayName: 'Other Extension',
      version: '0.1.0',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'priority',
            cardinality: 'single',
            values: ['low'],
            authority: ['human'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };
    const replacement: KernelMakaioExtension = {
      name: 'status-ext',
      displayName: 'Status Extension',
      version: '0.1.1',
      facetNamespaces: {
        namespaces: [
          defineFacetNamespace({
            namespace: 'status',
            cardinality: 'single',
            values: ['active'],
            authority: ['system'],
            appliesTo: ['workpiece'],
          }),
          defineFacetNamespace({
            namespace: 'priority',
            cardinality: 'single',
            values: ['high'],
            authority: ['human'],
            appliesTo: ['workpiece'],
          }),
        ],
      },
    };

    await processor.processActivated('status-ext', first, makeContext(bus, registry));
    await processor.processActivated('other-ext', conflicting, makeContext(bus, registry));
    await expect(processor.processActivated('status-ext', replacement, makeContext(bus, registry))).rejects.toThrow(
      "Facet namespace 'priority' is already registered",
    );

    expect(registry.getNamespace('status')?.values).toEqual(['pending']);
    expect(registry.getNamespace('priority')?.values).toEqual(['low']);

    await registry.destroy();
  });
});
