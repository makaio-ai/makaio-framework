import { describe, expect, it } from 'vitest';
import { normalizeBusSecret } from '../normalize-bus-secret.js';

describe('normalizeBusSecret', () => {
  it('returns undefined when the value is undefined (variable unset)', () => {
    expect(normalizeBusSecret(undefined)).toBeUndefined();
  });

  it('returns the secret unchanged when it has no surrounding whitespace', () => {
    expect(normalizeBusSecret('mysecret')).toBe('mysecret');
  });

  it('trims surrounding whitespace from a valid secret', () => {
    expect(normalizeBusSecret('  trimmed  ')).toBe('trimmed');
  });

  it.each(['', '   ', '\t\t'])('throws when the value is empty or whitespace (%j)', (value) => {
    expect(() => normalizeBusSecret(value)).toThrow(
      'MAKAIO_BUS_SECRET is set but empty after trimming; refusing to use an empty secret',
    );
  });
});
