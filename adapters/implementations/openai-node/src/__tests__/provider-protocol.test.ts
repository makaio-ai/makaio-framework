import { describe, expect, it } from 'vitest';
import { adapterDefinition } from '../definition.js';

describe('OpenAI Node provider protocols', () => {
  it('declares OpenAI protocol on every provider ref', () => {
    expect(new Set(adapterDefinition.providers.map(({ protocol }) => protocol))).toEqual(new Set(['openai']));
  });
});
