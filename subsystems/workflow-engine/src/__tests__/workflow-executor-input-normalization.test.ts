import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../workflow-executor-input-normalization.js';

describe('normalizeConfig', () => {
  it('preserves omitted config so reruns can inherit from the original run context', () => {
    expect(normalizeConfig(undefined)).toBeUndefined();
  });

  it('accepts plain object and null-prototype records', () => {
    const plain = { strict: true };
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.strict = false;

    expect(normalizeConfig(plain)).toBe(plain);
    expect(normalizeConfig(nullPrototype)).toBe(nullPrototype);
  });

  it('coerces arrays, class instances, and non-object values to an empty config record', () => {
    class CustomConfig {
      public strict = true;
    }

    expect(normalizeConfig(['strict'])).toEqual({});
    expect(normalizeConfig(new Date())).toEqual({});
    expect(normalizeConfig(new Map([['strict', true]]))).toEqual({});
    expect(normalizeConfig(new CustomConfig())).toEqual({});
    expect(normalizeConfig(null)).toEqual({});
    expect(normalizeConfig('strict')).toEqual({});
  });
});
