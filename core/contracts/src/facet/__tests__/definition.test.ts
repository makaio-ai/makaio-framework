import { describe, expect, it } from 'vitest';
import { defineFacetNamespace, FacetNamespaceRegistrationSchema } from '../index.js';

describe('defineFacetNamespace', () => {
  it('creates a serializable registration', () => {
    const definition = defineFacetNamespace({
      namespace: 'status',
      cardinality: 'single',
      values: ['pending', 'processing', 'blocked', 'completed'] as const,
      authority: ['system'],
      appliesTo: ['workpiece'],
    });

    expect(definition.namespace).toBe('status');
    expect(definition.toRegistration()).toEqual({
      namespace: 'status',
      cardinality: 'single',
      values: ['pending', 'processing', 'blocked', 'completed'],
      authority: ['system'],
      appliesTo: ['workpiece'],
    });
    expect(FacetNamespaceRegistrationSchema.parse(definition.toRegistration()).namespace).toBe('status');
  });

  it('creates a registration with open values', () => {
    const definition = defineFacetNamespace({
      namespace: 'label',
      cardinality: 'multiple',
      values: 'open',
      authority: ['human', 'agent'],
      appliesTo: ['artifact', 'workpiece'],
      description: 'Freeform labels applied by humans or agents.',
    });

    expect(definition.namespace).toBe('label');
    const registration = definition.toRegistration();
    expect(registration.values).toBe('open');
    expect(registration.description).toBe('Freeform labels applied by humans or agents.');
    expect(FacetNamespaceRegistrationSchema.parse(registration).namespace).toBe('label');
  });

  it('toRegistration returns independent copies of arrays', () => {
    const authority = ['human'] as const;
    const appliesTo = ['workpiece'] as const;
    const definition = defineFacetNamespace({
      namespace: 'priority',
      cardinality: 'single',
      values: ['low', 'medium', 'high'] as const,
      authority,
      appliesTo,
    });

    const reg1 = definition.toRegistration();
    // Mutate the returned copy to prove it is not shared with the definition.
    (reg1.authority as string[]).push('system');
    expect(reg1.authority).toHaveLength(2);

    // A fresh call must still return the original, unmodified data.
    const reg2 = definition.toRegistration();
    expect(reg2.authority).toEqual(['human']);
    expect(reg2.authority).toHaveLength(1);
  });

  it('validates namespace pattern via schema', () => {
    const invalidNamespace = {
      namespace: 'My Namespace',
      cardinality: 'single' as const,
      values: ['a'] as const,
      authority: ['human'] as const,
      appliesTo: ['workpiece'] as const,
    };
    expect(FacetNamespaceRegistrationSchema.safeParse(invalidNamespace).success).toBe(false);
  });

  it('validates authority has at least one entry', () => {
    const noAuthority = {
      namespace: 'status',
      cardinality: 'single' as const,
      values: ['a'] as const,
      authority: [] as const,
      appliesTo: ['workpiece'] as const,
    };
    expect(FacetNamespaceRegistrationSchema.safeParse(noAuthority).success).toBe(false);
  });
});
