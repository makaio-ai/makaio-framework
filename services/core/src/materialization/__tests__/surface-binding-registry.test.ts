import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { MaterializationSubjects } from '@makaio/contracts/materialization';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SurfaceBindingRegistry } from '../surface-binding-registry.js';

describe('SurfaceBindingRegistry', () => {
  let bus: IMakaioBus;
  let registry: SurfaceBindingRegistry;

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new SurfaceBindingRegistry(bus);
    await registry.init();
  });

  afterEach(async () => {
    await registry.destroy();
  });

  it('registers and lists bindings through the bus', async () => {
    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });

    const result = await bus.request(MaterializationSubjects.surfaceBinding.list, {});
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.id).toBe('github.status.field');
  });

  it('returns registered:true on successful registration', async () => {
    const result = await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.label',
      provider: 'github',
      namespace: 'label',
      target: { kind: 'label' },
      appliesTo: ['workpiece', 'artifact'],
    });
    expect(result.registered).toBe(true);
  });

  it('emits surfaceBinding.changed when a binding is registered', async () => {
    const changed = new Promise<{ id: string; provider: string }>((resolve) => {
      bus.on(MaterializationSubjects.surfaceBinding.changed, (ctx) => {
        resolve(ctx.payload);
      });
    });

    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });

    await expect(changed).resolves.toEqual({
      id: 'github.status.field',
      provider: 'github',
    });
  });

  it('deregisters a binding by id and emits changed', async () => {
    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });

    const changed = new Promise<{ id: string; provider: string }>((resolve) => {
      bus.on(MaterializationSubjects.surfaceBinding.changed, (ctx) => {
        resolve(ctx.payload);
      });
    });

    registry.deregisterBinding('github.status.field');

    expect(registry.getBinding('github.status.field')).toBeUndefined();
    await expect(changed).resolves.toEqual({
      id: 'github.status.field',
      provider: 'github',
    });
  });

  it('does not emit surfaceBinding.changed when deregistering an unknown binding', async () => {
    let changedCount = 0;
    const cleanup = bus.on(MaterializationSubjects.surfaceBinding.changed, () => {
      changedCount += 1;
    });

    registry.deregisterBinding('missing');

    expect(changedCount).toBe(0);
    cleanup();
  });

  it('silently accepts identical re-registration', async () => {
    const registration = {
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field' as const, name: 'Status' },
      appliesTo: ['workpiece' as const],
    };

    await bus.request(MaterializationSubjects.surfaceBinding.register, registration);
    await bus.request(MaterializationSubjects.surfaceBinding.register, registration);

    const result = await bus.request(MaterializationSubjects.surfaceBinding.list, {});
    expect(result.bindings).toHaveLength(1);
  });

  it('rejects conflicting duplicate binding registration', async () => {
    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });

    await expect(
      bus.request(MaterializationSubjects.surfaceBinding.register, {
        id: 'github.status.field',
        provider: 'github',
        namespace: 'status',
        target: { kind: 'field', name: 'DifferentField' },
        appliesTo: ['workpiece'],
      }),
    ).rejects.toThrow("Surface binding 'github.status.field' is already registered with a different definition");
  });

  it('filters list results by provider', async () => {
    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });
    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'jira.status.field',
      provider: 'jira',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });

    const result = await bus.request(MaterializationSubjects.surfaceBinding.list, { provider: 'github' });
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.provider).toBe('github');
  });

  it('filters list results by namespace', async () => {
    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });
    await bus.request(MaterializationSubjects.surfaceBinding.register, {
      id: 'github.priority.field',
      provider: 'github',
      namespace: 'priority',
      target: { kind: 'field', name: 'Priority' },
      appliesTo: ['workpiece'],
    });

    const result = await bus.request(MaterializationSubjects.surfaceBinding.list, { namespace: 'status' });
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.namespace).toBe('status');
  });

  it('returns an empty array when no bindings are registered', async () => {
    const result = await bus.request(MaterializationSubjects.surfaceBinding.list, {});
    expect(result.bindings).toEqual([]);
  });

  it('getBinding returns a clone of the stored registration', () => {
    registry.registerBinding({
      id: 'github.label',
      provider: 'github',
      namespace: 'label',
      target: { kind: 'label' },
      appliesTo: ['workpiece'],
    });

    const binding = registry.getBinding('github.label');
    expect(binding?.id).toBe('github.label');

    // Mutation of returned value must not affect stored registration.
    if (binding) {
      (binding.appliesTo as string[]).push('artifact');
    }
    const again = registry.getBinding('github.label');
    expect(again?.appliesTo).toHaveLength(1);
  });

  it('returns undefined for an unknown binding id', () => {
    expect(registry.getBinding('nonexistent')).toBeUndefined();
  });
});
