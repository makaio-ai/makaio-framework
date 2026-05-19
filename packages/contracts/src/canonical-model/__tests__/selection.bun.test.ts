import { describe, expect, it } from 'bun:test';
import { CanonicalModelSelectionSchema } from '../selection.js';

describe('CanonicalModelSelectionSchema', () => {
  it('accepts a canonical-model selection with a model reference', () => {
    const parsed = CanonicalModelSelectionSchema.parse({
      kind: 'canonical-model',
      model: 'anthropic-sdk::claude-sonnet-4-5',
      reasoningEffort: 'high',
    });

    expect(parsed.kind).toBe('canonical-model');
    expect(parsed.model).toBe('anthropic-sdk::claude-sonnet-4-5');
    expect(parsed.reasoningEffort).toBe('high');
  });

  it('rejects blank canonical-model references', () => {
    expect(() =>
      CanonicalModelSelectionSchema.parse({
        kind: 'canonical-model',
        model: '   ',
      }),
    ).toThrow();
  });
});
