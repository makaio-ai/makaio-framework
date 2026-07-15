import { describe, expect, it } from 'vitest';
import {
  ArtifactProjectionPolicySchema,
  ArtifactViewAffordanceDeclarationSchema,
  defineSurfaceBinding,
  SurfaceBindingRegistrationSchema,
} from '../index.js';

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

  it('includes optional JSON-safe params in the registration', () => {
    const binding = defineSurfaceBinding({
      id: 'github.view.params',
      provider: 'github',
      namespace: 'view',
      target: { kind: 'field', name: 'View' },
      appliesTo: ['artifact'],
      params: { depth: 3, includeArchived: true },
    });

    const reg = SurfaceBindingRegistrationSchema.parse(binding.toRegistration());
    expect(reg.params).toEqual({ depth: 3, includeArchived: true });
  });

  it('omits params from registration when not supplied', () => {
    const binding = defineSurfaceBinding({
      id: 'github.no-params',
      provider: 'github',
      namespace: 'status',
      target: { kind: 'field', name: 'Status' },
      appliesTo: ['workpiece'],
    });

    const reg = binding.toRegistration();
    expect(reg.params).toBeUndefined();
  });

  it('toRegistration returns a detached params object', () => {
    const binding = defineSurfaceBinding({
      id: 'github.params.copy',
      provider: 'github',
      namespace: 'view',
      target: { kind: 'label' },
      appliesTo: ['workpiece'],
      params: { depth: 1 },
    });

    const reg1 = binding.toRegistration();
    (reg1.params as Record<string, unknown>)['depth'] = 99;

    const reg2 = binding.toRegistration();
    expect(reg2.params).toEqual({ depth: 1 });
  });

  it('validates params must be a JSON-safe object', () => {
    expect(
      SurfaceBindingRegistrationSchema.safeParse({
        id: 'github.bad-params',
        provider: 'github',
        namespace: 'view',
        target: { kind: 'label' },
        appliesTo: ['workpiece'],
        params: 'not-an-object',
      }).success,
    ).toBe(false);
  });
});

describe('ArtifactProjectionPolicy affordance declarations', () => {
  it('accepts a projection policy with affordance declarations', () => {
    const result = ArtifactProjectionPolicySchema.safeParse({
      mode: 'surface',
      affordances: [
        { kind: 'own-view' },
        { kind: 'inline', hostRelation: 'blocked-by', as: 'summary' },
        { kind: 'entry', via: 'dashboard' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts projection policy without affordances (legacy default)', () => {
    const result = ArtifactProjectionPolicySchema.safeParse({
      mode: 'surface',
    });

    expect(result.success).toBe(true);
    expect(result.data?.affordances).toBeUndefined();
  });

  it('accepts an empty affordances array (renders nowhere)', () => {
    const result = ArtifactProjectionPolicySchema.safeParse({
      mode: 'surface',
      affordances: [],
    });

    expect(result.success).toBe(true);
    expect(result.data?.affordances).toEqual([]);
  });

  it('rejects entry affordance with both via and collection', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'entry',
      via: 'dashboard',
      collection: 'recent',
    });

    expect(result.success).toBe(false);
  });

  it('rejects entry affordance with neither via nor collection', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'entry',
    });

    expect(result.success).toBe(false);
  });
});

describe('affordance-defaults truth table', () => {
  it('mode none + absent affordances = not rendered', () => {
    const policy = ArtifactProjectionPolicySchema.parse({ mode: 'none' });

    expect(policy.mode).toBe('none');
    expect(policy.affordances).toBeUndefined();
  });

  it('mode surface + absent affordances = legacy own-view/full', () => {
    const policy = ArtifactProjectionPolicySchema.parse({ mode: 'surface' });

    expect(policy.mode).toBe('surface');
    expect(policy.affordances).toBeUndefined();
  });

  it('mode comment + absent affordances = legacy caller-supplied inline/summary', () => {
    const policy = ArtifactProjectionPolicySchema.parse({ mode: 'comment' });

    expect(policy.mode).toBe('comment');
    expect(policy.affordances).toBeUndefined();
  });

  it('present empty affordances = no rendering regardless of mode', () => {
    const surface = ArtifactProjectionPolicySchema.parse({
      mode: 'surface',
      affordances: [],
    });
    const comment = ArtifactProjectionPolicySchema.parse({
      mode: 'comment',
      affordances: [],
    });

    expect(surface.affordances).toEqual([]);
    expect(comment.affordances).toEqual([]);
  });

  it('present non-empty affordances are authoritative and exact', () => {
    const policy = ArtifactProjectionPolicySchema.parse({
      mode: 'surface',
      affordances: [{ kind: 'own-view' }, { kind: 'entry', via: 'dashboard' }],
    });

    expect(policy.affordances).toHaveLength(2);
    expect(policy.affordances![0]).toEqual({ kind: 'own-view' });
    expect(policy.affordances![1]).toEqual({ kind: 'entry', via: 'dashboard' });
  });

  it('omitted inline.as means only request-level full matches', () => {
    const policy = ArtifactProjectionPolicySchema.parse({
      mode: 'surface',
      affordances: [{ kind: 'inline', hostRelation: 'contains' }],
    });

    expect(policy.affordances![0]).toEqual({
      kind: 'inline',
      hostRelation: 'contains',
    });
  });

  it('inline.as declared at summary is preserved as declaration policy', () => {
    const policy = ArtifactProjectionPolicySchema.parse({
      mode: 'surface',
      affordances: [{ kind: 'inline', hostRelation: 'depends-on', as: 'summary' }],
    });

    expect(policy.affordances![0]).toEqual({
      kind: 'inline',
      hostRelation: 'depends-on',
      as: 'summary',
    });
  });
});
