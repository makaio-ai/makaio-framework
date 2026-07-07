import { describe, expect, it } from 'vitest';
import { ENRICHMENT_VERSION, EmbeddableUnitSchema, ResolvedTypeShapeSchema } from './schemas.js';

describe('enrichment schemas', () => {
  it('accepts an object shape with properties', () => {
    const shape = {
      kind: 'object',
      properties: [{ name: 'id', type: 'string', optional: false }],
    };
    expect(ResolvedTypeShapeSchema.parse(shape)).toEqual(shape);
  });

  it('accepts an omitted shape with reason', () => {
    const shape = { kind: 'omitted', reason: 'above property limit' };
    expect(ResolvedTypeShapeSchema.parse(shape)).toEqual(shape);
  });

  it('rejects an embeddable unit without version', () => {
    expect(() => EmbeddableUnitSchema.parse({ text: 'x' })).toThrow();
  });

  it('pins the current enrichment version', () => {
    expect(ENRICHMENT_VERSION).toBe('v1');
  });
});
