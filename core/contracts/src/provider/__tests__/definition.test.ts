import { describe, expect, it } from 'vitest';
import { ProviderCapabilitiesSchema, ProviderDefinitionSchema } from '../definition.js';

describe('ProviderCapabilitiesSchema', () => {
  it('accepts nested JSON-safe provider capability hints', () => {
    expect(
      ProviderCapabilitiesSchema.parse({
        structuredOutput: {
          responseFormatWithTools: true,
          strict: true,
          modes: ['json_schema'],
        },
      }),
    ).toEqual({
      structuredOutput: {
        responseFormatWithTools: true,
        strict: true,
        modes: ['json_schema'],
      },
    });
  });

  it('rejects runtime-only values before provider definitions reach JSON-backed storage', () => {
    expect(
      ProviderDefinitionSchema.safeParse({
        id: 'invalid-provider',
        name: 'Invalid Provider',
        capabilities: {
          nested: {
            invalid: undefined,
          },
        },
      }).success,
    ).toBe(false);

    expect(
      ProviderDefinitionSchema.safeParse({
        id: 'invalid-provider',
        name: 'Invalid Provider',
        capabilities: {
          invalid: BigInt(1),
        },
      }).success,
    ).toBe(false);
  });
});
