import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { FacetSubjects } from '@makaio/contracts/facet';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FacetNamespaceRegistry } from '../facet-namespace-registry.js';

describe('FacetNamespaceRegistry', () => {
  let bus: IMakaioBus;
  let registry: FacetNamespaceRegistry;

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new FacetNamespaceRegistry(bus);
    await registry.init();
  });

  afterEach(async () => {
    await registry.destroy();
  });

  it('registers and lists namespaces through the bus', async () => {
    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'status',
      cardinality: 'single',
      values: ['pending', 'completed'],
      authority: ['system'],
      appliesTo: ['workpiece'],
    });

    const result = await bus.request(FacetSubjects.namespace.list, {});
    expect(result.namespaces).toHaveLength(1);
    expect(result.namespaces[0]?.namespace).toBe('status');
  });

  it('returns registered:true on successful registration', async () => {
    const result = await bus.request(FacetSubjects.namespace.register, {
      namespace: 'priority',
      cardinality: 'single',
      values: ['low', 'medium', 'high'],
      authority: ['human', 'agent'],
      appliesTo: ['workpiece'],
    });
    expect(result.registered).toBe(true);
  });

  it('emits namespace.changed when a namespace is registered', async () => {
    const changed = new Promise<{ namespace: string }>((resolve) => {
      bus.on(FacetSubjects.namespace.changed, (ctx) => {
        resolve(ctx.payload);
      });
    });

    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'review-state',
      cardinality: 'single',
      values: 'open',
      authority: ['human'],
      appliesTo: ['artifact'],
    });

    await expect(changed).resolves.toEqual({ namespace: 'review-state' });
  });

  it('deregisters a namespace by namespace identifier and emits changed', async () => {
    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'status',
      cardinality: 'single',
      values: ['pending'],
      authority: ['system'],
      appliesTo: ['workpiece'],
    });

    const changed = new Promise<{ namespace: string }>((resolve) => {
      bus.on(FacetSubjects.namespace.changed, (ctx) => {
        resolve(ctx.payload);
      });
    });

    registry.deregisterNamespace('status');

    expect(registry.getNamespace('status')).toBeUndefined();
    await expect(changed).resolves.toEqual({ namespace: 'status' });
  });

  it('does not emit namespace.changed when deregistering an unknown namespace', async () => {
    let changedCount = 0;
    const cleanup = bus.on(FacetSubjects.namespace.changed, () => {
      changedCount += 1;
    });

    registry.deregisterNamespace('missing');

    expect(changedCount).toBe(0);
    cleanup();
  });

  it('silently accepts identical re-registration', async () => {
    const registration = {
      namespace: 'status',
      cardinality: 'single' as const,
      values: ['pending', 'completed'],
      authority: ['system' as const],
      appliesTo: ['workpiece' as const],
    };

    await bus.request(FacetSubjects.namespace.register, registration);
    await bus.request(FacetSubjects.namespace.register, registration);

    const result = await bus.request(FacetSubjects.namespace.list, {});
    expect(result.namespaces).toHaveLength(1);
  });

  it('rejects conflicting duplicate namespace registration with a different definition', async () => {
    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'status',
      cardinality: 'single',
      values: ['pending', 'completed'],
      authority: ['system'],
      appliesTo: ['workpiece'],
    });

    await expect(
      bus.request(FacetSubjects.namespace.register, {
        namespace: 'status',
        cardinality: 'multiple',
        values: ['pending', 'completed'],
        authority: ['system'],
        appliesTo: ['workpiece'],
      }),
    ).rejects.toThrow("Facet namespace 'status' is already registered with a different definition");
  });

  it('filters namespace.list results by namespace string', async () => {
    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'status',
      cardinality: 'single',
      values: ['pending'],
      authority: ['system'],
      appliesTo: ['workpiece'],
    });
    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'priority',
      cardinality: 'single',
      values: ['low', 'high'],
      authority: ['human'],
      appliesTo: ['workpiece'],
    });

    const result = await bus.request(FacetSubjects.namespace.list, { namespace: 'status' });
    expect(result.namespaces).toHaveLength(1);
    expect(result.namespaces[0]?.namespace).toBe('status');
  });

  it('returns an empty array when no namespaces are registered', async () => {
    const result = await bus.request(FacetSubjects.namespace.list, {});
    expect(result.namespaces).toEqual([]);
  });

  it('registers multiple distinct namespaces', async () => {
    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'status',
      cardinality: 'single',
      values: ['pending'],
      authority: ['system'],
      appliesTo: ['workpiece'],
    });
    await bus.request(FacetSubjects.namespace.register, {
      namespace: 'priority',
      cardinality: 'single',
      values: ['low'],
      authority: ['human'],
      appliesTo: ['workpiece'],
    });

    const result = await bus.request(FacetSubjects.namespace.list, {});
    expect(result.namespaces).toHaveLength(2);
  });
});
