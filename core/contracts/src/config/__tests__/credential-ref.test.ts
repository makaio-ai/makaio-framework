import { describe, expect, it } from 'vitest';
import {
  CredentialRefSchema,
  buildAccountManagerCredentialRef,
  buildStoredCredentialRef,
  isAccountManagerRef,
  parseStoredCredentialRef,
} from '../credential-ref.js';

describe('stored credential refs', () => {
  it('round-trips configId/key', () => {
    const ref = buildStoredCredentialRef('config-uuid-1', 'apiKey');

    expect(parseStoredCredentialRef(ref)).toEqual({
      configId: 'config-uuid-1',
      key: 'apiKey',
    });
  });

  it('round-trips configId containing colons', () => {
    const ref = buildStoredCredentialRef('github:oauth-default', 'pat');
    const parsed = parseStoredCredentialRef(ref);
    expect(parsed).toEqual({ configId: 'github:oauth-default', key: 'pat' });
  });

  it('returns null for non-stored refs', () => {
    const envRef = parseStoredCredentialRef(CredentialRefSchema.parse('env:MY_API_KEY'));
    expect(envRef).toBeNull();
  });

  it('uses the providerConfig namespace prefix', () => {
    const ref = buildStoredCredentialRef('my-config-id', 'secretKey');
    expect(ref.startsWith('stored:providerConfig:')).toBe(true);
  });

  it('accepts the supported non-stored credential-ref formats', () => {
    expect(CredentialRefSchema.safeParse('file:/tmp/secret.txt').success).toBe(true);
    expect(CredentialRefSchema.safeParse('keychain:makaio:work-account').success).toBe(true);
    expect(CredentialRefSchema.safeParse('account-manager:["claude-code","account-123"]').success).toBe(true);
  });

  it('rejects cleartext strings and malformed refs', () => {
    expect(CredentialRefSchema.safeParse('sk-ant-plaintext').success).toBe(false);
    expect(CredentialRefSchema.safeParse('env:').success).toBe(false);
    expect(CredentialRefSchema.safeParse('stored:providerConfig:config-only').success).toBe(false);
    expect(CredentialRefSchema.safeParse('account-manager:missing-account').success).toBe(false);
    expect(CredentialRefSchema.safeParse('account-manager:["missing-account"]').success).toBe(false);
  });
});

describe('account-manager credential refs', () => {
  it('preserves opaque client/account ids', () => {
    const ref = buildAccountManagerCredentialRef('claude:desktop', 'account:tenant-1');
    expect(ref).toBe('account-manager:["claude:desktop","account:tenant-1"]');
  });

  it('recognizes the JSON-tuple ref shape as account-manager owned', () => {
    expect(isAccountManagerRef('account-manager:["claude-code","account-123"]')).toBe(true);
  });
});
