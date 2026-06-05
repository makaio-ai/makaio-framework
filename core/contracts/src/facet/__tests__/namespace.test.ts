import { describe, expect, it } from 'vitest';
import { FacetSchemas, FacetSubjects } from '../index.js';

describe('Facet namespace', () => {
  it('registers facet bus subjects', () => {
    expect(FacetSubjects.namespace.register.subject).toBe('namespace.register');
    expect(FacetSubjects.namespace.list.subject).toBe('namespace.list');
    expect(FacetSubjects.namespace.changed.subject).toBe('namespace.changed');
  });

  it('exposes the expected schema keys', () => {
    expect(Object.keys(FacetSchemas).sort()).toEqual(
      ['namespace.register', 'namespace.list', 'namespace.changed'].sort(),
    );
  });

  describe('namespace.register contract', () => {
    it('accepts a valid registration request', () => {
      const schema = FacetSchemas['namespace.register'].request;
      const valid = {
        namespace: 'status',
        cardinality: 'single',
        values: ['pending', 'completed'],
        authority: ['system'],
        appliesTo: ['workpiece'],
      };
      expect(schema.safeParse(valid).success).toBe(true);
    });

    it('accepts an open-values registration', () => {
      const schema = FacetSchemas['namespace.register'].request;
      const valid = {
        namespace: 'tag',
        cardinality: 'multiple',
        values: 'open',
        authority: ['human'],
        appliesTo: ['artifact'],
      };
      expect(schema.safeParse(valid).success).toBe(true);
    });

    it('rejects an invalid authority value', () => {
      const schema = FacetSchemas['namespace.register'].request;
      const invalid = {
        namespace: 'status',
        cardinality: 'single',
        values: ['pending'],
        authority: ['unknown-actor'],
        appliesTo: ['workpiece'],
      };
      expect(schema.safeParse(invalid).success).toBe(false);
    });
  });

  describe('namespace.list contract', () => {
    it('accepts an empty request', () => {
      const schema = FacetSchemas['namespace.list'].request;
      expect(schema.safeParse({}).success).toBe(true);
    });

    it('accepts a filtered request by namespace', () => {
      const schema = FacetSchemas['namespace.list'].request;
      expect(schema.safeParse({ namespace: 'status' }).success).toBe(true);
    });
  });

  describe('namespace.changed contract', () => {
    it('accepts a valid changed event', () => {
      const schema = FacetSchemas['namespace.changed'];
      expect(schema.safeParse({ namespace: 'status' }).success).toBe(true);
    });

    it('rejects an empty namespace string', () => {
      const schema = FacetSchemas['namespace.changed'];
      expect(schema.safeParse({ namespace: '' }).success).toBe(false);
    });
  });
});
