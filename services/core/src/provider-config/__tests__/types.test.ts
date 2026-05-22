import { describe, expect, it } from 'vitest';
import { CreateProviderConfigInputSchema, ProviderConfigPatchSchema } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a create payload with only the name field set (plus the required
 * `definitionId`) so name-validation tests stay focused.
 * @param name - The candidate name to validate.
 */
function parseCreate(name: string) {
  return CreateProviderConfigInputSchema.safeParse({ definitionId: 'anthropic', name });
}

/**
 * Parse a patch payload with only the name field set.
 * @param name - The candidate name to validate.
 */
function parsePatch(name: string) {
  return ProviderConfigPatchSchema.safeParse({ name });
}

// ---------------------------------------------------------------------------
// isValidProviderConfigName — names that must PASS
// ---------------------------------------------------------------------------

describe('isValidProviderConfigName — valid names', () => {
  it('accepts a simple lowercase word', () => {
    expect(parseCreate('work').success).toBe(true);
  });

  it('accepts a hyphenated lowercase name', () => {
    expect(parseCreate('my-config').success).toBe(true);
  });

  it('accepts a title-case name that slugifies cleanly', () => {
    expect(parseCreate('My Config').success).toBe(true);
  });

  it('accepts a multi-word name with extra internal spaces (slugifies to hyphens)', () => {
    expect(parseCreate('anthropic  work').success).toBe(true);
  });

  it('accepts a name with leading/trailing whitespace', () => {
    expect(parseCreate('  My Config  ').success).toBe(true);
  });

  it('accepts a name with digits', () => {
    expect(parseCreate('Config 2').success).toBe(true);
  });

  it('accepts a name that is already a valid slug with dots', () => {
    expect(parseCreate('open.ai').success).toBe(true);
  });

  it('accepts a name via patch with a valid slug', () => {
    expect(parsePatch('My Anthropic Config').success).toBe(true);
  });

  it('accepts an absent name in create (name is optional)', () => {
    const result = CreateProviderConfigInputSchema.safeParse({ definitionId: 'anthropic' });
    expect(result.success).toBe(true);
  });

  it('accepts an absent name in patch (name is optional)', () => {
    expect(ProviderConfigPatchSchema.safeParse({}).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isValidProviderConfigName — names that must FAIL
// ---------------------------------------------------------------------------

describe('isValidProviderConfigName — invalid names', () => {
  it('rejects a name containing "::"', () => {
    expect(parseCreate('bad::name').success).toBe(false);
  });

  it('rejects a name containing "~"', () => {
    expect(parseCreate('~virtual').success).toBe(false);
  });

  it('rejects a name containing "/"', () => {
    expect(parseCreate('a/b').success).toBe(false);
  });

  it('rejects a name with special characters that survive slugification — parentheses', () => {
    // "My Config (v2)" slugifies to "my-config-(v2)" which contains "(" and ")"
    expect(parseCreate('My Config (v2)').success).toBe(false);
  });

  it('rejects a name with an exclamation mark', () => {
    // "Test!" slugifies to "test!" — "!" is not in [a-z0-9._-]
    expect(parseCreate('Test!').success).toBe(false);
  });

  it('rejects a name with an @ symbol', () => {
    expect(parseCreate('user@work').success).toBe(false);
  });

  it('rejects a name whose slug starts with a hyphen', () => {
    // "-config" slugifies to "-config" — must start with [a-z0-9]
    expect(parseCreate('-config').success).toBe(false);
  });

  it('rejects a whitespace-only name (slug is empty after trim)', () => {
    expect(parseCreate('   ').success).toBe(false);
  });

  it('rejects an empty string (slug is empty)', () => {
    // Note: zod .string() allows empty unless .min(1) — the refinement catches it.
    expect(parseCreate('').success).toBe(false);
  });

  it('rejects a name with accented characters that survive slugification', () => {
    // "café" slugifies to "café" — "é" is not in [a-z0-9._-]
    expect(parseCreate('café').success).toBe(false);
  });

  it('reports the error on the "name" path', () => {
    const result = parseCreate('My Config (v2)');
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameError = result.error.issues.find((issue) => issue.path.includes('name'));
      expect(nameError).toBeDefined();
    }
  });

  it('rejects an invalid name via patch as well', () => {
    expect(parsePatch('Bad (Name)').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Other schema refinements
// ---------------------------------------------------------------------------

describe('provider-config schema refinements', () => {
  it('rejects create input that mixes raw credentials with credential refs', () => {
    const result = CreateProviderConfigInputSchema.safeParse({
      definitionId: 'provider-openai',
      credentials: { apiKey: 'secret' },
      credentialRefs: { apiKey: 'stored:providerConfig:config-1:apiKey' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Provide either credentials or credentialRefs');
  });

  it('rejects create input names that break canonical-model routing', () => {
    expect(
      CreateProviderConfigInputSchema.safeParse({
        definitionId: 'provider-openai',
        name: 'Bad/Name',
      }).success,
    ).toBe(false);

    expect(
      CreateProviderConfigInputSchema.safeParse({
        definitionId: 'provider-openai',
        name: '   ',
      }).success,
    ).toBe(false);
  });

  it('rejects patch names that break canonical-model routing', () => {
    const result = ProviderConfigPatchSchema.safeParse({
      name: 'bad::name',
    });

    expect(result.success).toBe(false);
  });

  it('accepts null endpointOverrides in patch input to clear stored overrides', () => {
    const result = ProviderConfigPatchSchema.safeParse({
      endpointOverrides: null,
    });

    expect(result.success).toBe(true);
    expect(result.data?.endpointOverrides).toBeNull();
  });
});
