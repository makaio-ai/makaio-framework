import { describe, expect, it } from 'vitest';
import { adapterDefinition } from '../definition.js';

describe('Anthropic SDK provider protocols', () => {
  it('declares Anthropic protocol on every provider ref', () => {
    expect(new Set(adapterDefinition.providers.map(({ protocol }) => protocol))).toEqual(new Set(['anthropic']));
  });
});
