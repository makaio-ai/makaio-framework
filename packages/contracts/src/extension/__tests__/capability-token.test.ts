import { describe, expect, it } from 'vitest';
import { ExtensionManifestSchema, type CapabilityToken, type ExtensionManifest } from '../index.js';
import { CapabilityTokenSchema } from '../capability-token.js';

declare module '../capability-token.js' {
  interface CapabilityTokenMap {
    readonly 'custom-capability': true;
  }
}

type IsNever<T> = [T] extends [never] ? true : false;

describe('CapabilityToken', () => {
  it('does not collapse to never', () => {
    expect(false satisfies IsNever<CapabilityToken>).toBe(false);
  });

  it('accepts core capability tokens', () => {
    const token: CapabilityToken = 'adapters';

    expect(token).toBe('adapters');
  });

  it('accepts declaration-merged capability tokens', () => {
    const token: CapabilityToken = 'custom-capability';

    expect(token).toBe('custom-capability');
  });

  it('applies canonical runtime validation', () => {
    expect(CapabilityTokenSchema.safeParse('').success).toBe(false);
    expect(CapabilityTokenSchema.safeParse('   ').success).toBe(false);
    expect(CapabilityTokenSchema.parse('  adapters  ')).toBe('adapters');
  });

  it('allows manifests to declare provided capabilities', () => {
    const manifest = {
      name: 'my-extension',
      displayName: 'My Extension',
      version: '0.1.0',
      provides: ['adapters'],
    } satisfies ExtensionManifest;

    const parsed = ExtensionManifestSchema.safeParse(manifest);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provides).toEqual(['adapters']);
    }
  });
});
