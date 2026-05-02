import { describe, expect, it } from 'vitest';
import { extractCredentialExpiry } from '../handlers/extract-credential-expiry.js';

describe('extractCredentialExpiry', () => {
  it('prefers the claudeAiOauth envelope expiry when present', () => {
    const token = JSON.stringify({
      expiresAt: 1_000,
      claudeAiOauth: {
        expiresAt: 2_000,
      },
    });

    expect(extractCredentialExpiry(token)).toBe(2_000);
  });

  it('falls back to the top-level expiry when no envelope exists', () => {
    expect(extractCredentialExpiry(JSON.stringify({ expiresAt: 1_000 }))).toBe(1_000);
  });

  it('returns null for invalid JSON', () => {
    expect(extractCredentialExpiry('{not-json')).toBeNull();
  });

  it('returns null for non-finite expiry values', () => {
    expect(extractCredentialExpiry(JSON.stringify({ expiresAt: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it('falls back to top-level expiry when envelope expiry is null', () => {
    expect(
      extractCredentialExpiry(
        JSON.stringify({
          expiresAt: 1_000,
          claudeAiOauth: { expiresAt: null },
        }),
      ),
    ).toBe(1_000);
  });
});
