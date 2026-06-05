import { describe, expect, it } from 'vitest';
import { defineSurfaceBinding, SurfaceBindingRegistrationSchema } from '../index.js';

describe('defineSurfaceBinding', () => {
  it('creates a serializable provider binding', () => {
    const binding = defineSurfaceBinding({
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
      valueMapping: { pending: 'Pending', completed: 'Done' },
    });

    expect(SurfaceBindingRegistrationSchema.parse(binding.toRegistration())).toMatchObject({
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
    });
  });

  it('exposes the id directly', () => {
    const binding = defineSurfaceBinding({
      id: 'github.label',
      provider: 'github',
      namespace: 'label',
      target: { kind: 'label' },
      appliesTo: ['workpiece', 'artifact'],
    });

    expect(binding.id).toBe('github.label');
  });

  it('toRegistration includes optional valueMapping and description', () => {
    const binding = defineSurfaceBinding({
      id: 'github.issue-type',
      provider: 'github',
      namespace: 'type',
      target: { kind: 'issue-type', name: 'Bug' },
      appliesTo: ['workpiece'],
      valueMapping: { bug: 'Bug', feature: 'Feature' },
      description: 'Maps internal type to GitHub issue type.',
    });

    const reg = binding.toRegistration();
    expect(reg.valueMapping).toEqual({ bug: 'Bug', feature: 'Feature' });
    expect(reg.description).toBe('Maps internal type to GitHub issue type.');
  });

  it('toRegistration returns independent copies on each call', () => {
    const binding = defineSurfaceBinding({
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });

    const reg1 = binding.toRegistration();
    (reg1.appliesTo as string[]).push('surface');
    expect(reg1.appliesTo).toHaveLength(2);

    const reg2 = binding.toRegistration();
    expect(reg2.appliesTo).toHaveLength(1);
  });

  it('validates that appliesTo must have at least one entry', () => {
    expect(
      SurfaceBindingRegistrationSchema.safeParse({
        id: 'github.status.field',
        provider: 'github',
        namespace: 'status',
        target: { kind: 'field', name: 'Status' },
        appliesTo: [],
      }).success,
    ).toBe(false);
  });

  it('validates discriminated target kinds', () => {
    expect(
      SurfaceBindingRegistrationSchema.safeParse({
        id: 'github.body',
        provider: 'github',
        namespace: 'body',
        target: { kind: 'body-fragment', slot: 'header' },
        appliesTo: ['artifact'],
      }).success,
    ).toBe(true);

    // Missing required slot
    expect(
      SurfaceBindingRegistrationSchema.safeParse({
        id: 'github.body',
        provider: 'github',
        namespace: 'body',
        target: { kind: 'body-fragment' },
        appliesTo: ['artifact'],
      }).success,
    ).toBe(false);
  });
});
