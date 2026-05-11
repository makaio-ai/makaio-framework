import { describe, expect, it } from 'vitest';
import {
  mergeSourceAccountMetadata,
  mergeSourceAccountMetadataWithIdentityCheck,
  sanitizeSourceAccountMetadata,
} from '../utils/source-account-metadata.js';

describe('mergeSourceAccountMetadata', () => {
  it('preserves account-manager overlay keys from existing metadata', () => {
    const merged = mergeSourceAccountMetadata(
      {
        plan: 'pro',
        usageAuthState: 'reauth-required',
        usageAuthFingerprint: 'old-fingerprint',
      },
      {
        plan: 'team',
      },
    );

    expect(merged).toEqual({
      plan: 'team',
      usageAuthState: 'reauth-required',
      usageAuthFingerprint: 'old-fingerprint',
    });
  });

  it('strips reserved account-manager keys from source-owned metadata', () => {
    const merged = mergeSourceAccountMetadata(
      {},
      {
        plan: 'team',
        usageAuthState: 'source-owned',
        usageAuthMessage: 'should not leak',
      },
    );

    expect(merged).toEqual({
      plan: 'team',
    });
  });
});

describe('sanitizeSourceAccountMetadata', () => {
  it('removes all account-manager overlay keys from source metadata', () => {
    const result = sanitizeSourceAccountMetadata({
      email: 'user@example.com',
      usageAuthState: 'reauth-required',
      usageAuthFingerprint: 'fp',
      usageAuthMessage: 'msg',
      usageAuthCode: 'TRANSIENT_USAGE_FETCH_FAILURES',
      usageAuthDetectedAt: '2024-01-01',
    });

    expect(result).toEqual({ email: 'user@example.com' });
  });

  it('returns an unchanged copy when no overlay keys are present', () => {
    const source = { email: 'user@example.com', name: 'Alice' };
    const result = sanitizeSourceAccountMetadata(source);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });
});

describe('mergeSourceAccountMetadataWithIdentityCheck', () => {
  it('returns identityChanged: false when email and name are unchanged', () => {
    const { metadata, identityChanged } = mergeSourceAccountMetadataWithIdentityCheck(
      { email: 'user@example.com', name: 'Alice', plan: 'pro' },
      { email: 'user@example.com', name: 'Alice', plan: 'team' },
    );

    expect(identityChanged).toBe(false);
    expect(metadata).toEqual({ email: 'user@example.com', name: 'Alice', plan: 'team' });
  });

  it('returns identityChanged: true when email differs', () => {
    const { identityChanged } = mergeSourceAccountMetadataWithIdentityCheck(
      { email: 'old@example.com', name: 'Alice' },
      { email: 'new@example.com', name: 'Alice' },
    );

    expect(identityChanged).toBe(true);
  });

  it('returns identityChanged: true when name differs', () => {
    const { identityChanged } = mergeSourceAccountMetadataWithIdentityCheck(
      { email: 'user@example.com', name: 'Alice' },
      { email: 'user@example.com', name: 'Bob' },
    );

    expect(identityChanged).toBe(true);
  });

  it('returns identityChanged: false when existing metadata has no email (first population)', () => {
    const { identityChanged } = mergeSourceAccountMetadataWithIdentityCheck(
      { plan: 'pro' },
      { email: 'user@example.com', name: 'Alice' },
    );

    expect(identityChanged).toBe(false);
  });

  it('returns identityChanged: false when incoming source has no email', () => {
    const { identityChanged } = mergeSourceAccountMetadataWithIdentityCheck(
      { email: 'user@example.com', name: 'Alice' },
      { plan: 'pro' },
    );

    expect(identityChanged).toBe(false);
  });

  it('returns identityChanged: true when organization differs', () => {
    const { identityChanged } = mergeSourceAccountMetadataWithIdentityCheck(
      { email: 'user@example.com', name: 'Alice', organization: 'Acme Corp' },
      { email: 'user@example.com', name: 'Alice', organization: 'New Corp' },
    );

    expect(identityChanged).toBe(true);
  });

  it('returns identityChanged: false when organization is absent in incoming source (first population)', () => {
    const { identityChanged } = mergeSourceAccountMetadataWithIdentityCheck(
      { email: 'user@example.com', name: 'Alice' },
      { email: 'user@example.com', name: 'Alice', organization: 'Acme Corp' },
    );

    expect(identityChanged).toBe(false);
  });

  it('returns metadata identical to mergeSourceAccountMetadata output', () => {
    const existing = {
      email: 'user@example.com',
      name: 'Alice',
      usageAuthState: 'reauth-required',
    };
    const source = {
      email: 'user@example.com',
      name: 'Alice',
      plan: 'team',
    };

    const { metadata } = mergeSourceAccountMetadataWithIdentityCheck(existing, source);
    const expected = mergeSourceAccountMetadata(existing, source);

    expect(metadata).toEqual(expected);
  });
});
