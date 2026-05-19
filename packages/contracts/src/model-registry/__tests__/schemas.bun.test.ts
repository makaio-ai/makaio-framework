import { describe, expect, it } from 'bun:test';
import { ModelRegistrySupportedModelSchema } from '../schemas.js';

describe('ModelRegistrySupportedModelSchema', () => {
  const supportedModel = {
    name: 'model-1',
    contextWindowSize: 200_000,
    provider: 'provider-1',
  };

  it('accepts integer nonnegative context window token counts', () => {
    expect(ModelRegistrySupportedModelSchema.safeParse(supportedModel).success).toBe(true);
    expect(ModelRegistrySupportedModelSchema.safeParse({ ...supportedModel, contextWindowSize: 0 }).success).toBe(true);
  });

  it('rejects fractional or negative context window token counts', () => {
    expect(ModelRegistrySupportedModelSchema.safeParse({ ...supportedModel, contextWindowSize: 1.5 }).success).toBe(
      false,
    );
    expect(ModelRegistrySupportedModelSchema.safeParse({ ...supportedModel, contextWindowSize: -1 }).success).toBe(
      false,
    );
  });
});
