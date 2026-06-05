import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OBSERVABILITY_META_KEY,
  getObservabilityFieldPolicy,
  getObservabilitySchemaPolicy,
  observability,
} from '../observability/index.js';

describe('observability schema metadata', () => {
  it('stores schema policy in Zod metadata without replacing existing metadata', () => {
    const schema = observability.schema(z.object({ limit: z.number() }).meta({ owner: 'session' }), { traceAll: true });

    expect(schema.meta()).toMatchObject({
      owner: 'session',
      [OBSERVABILITY_META_KEY]: { kind: 'schema', traceAll: true },
    });
    expect(getObservabilitySchemaPolicy(schema)).toEqual({ traceAll: true });
  });

  it('stores field policy and recovers it through optional wrappers', () => {
    const field = observability.hidden(z.number().int().min(0)).optional();

    expect(getObservabilityFieldPolicy(field)).toEqual({ visibility: 'hidden' });
  });

  it('recovers field policy attached to an intermediate wrapper', () => {
    const field = observability.attribute(z.string().optional(), 'label').nullable().catch(null);

    expect(getObservabilityFieldPolicy(field)).toEqual({
      visibility: 'attribute',
      attributeName: 'label',
    });
  });

  it('lets wrapper-level metadata override inner metadata', () => {
    const field = observability.field(observability.hidden(z.string()).optional(), {
      visibility: 'attribute',
      attributeName: 'status',
    });

    expect(getObservabilityFieldPolicy(field)).toEqual({
      visibility: 'attribute',
      attributeName: 'status',
    });
  });

  it('stores attribute and count field policies', () => {
    expect(getObservabilityFieldPolicy(observability.attribute(z.string(), 'label'))).toEqual({
      visibility: 'attribute',
      attributeName: 'label',
    });
    expect(getObservabilityFieldPolicy(observability.count(z.array(z.string()), 'itemCount'))).toEqual({
      visibility: 'count',
      attributeName: 'itemCount',
    });
  });
});
