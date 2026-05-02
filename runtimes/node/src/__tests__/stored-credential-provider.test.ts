import { describe, expect, it, vi, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { StoredCredentialProvider } from '../credential-provider.js';

describe('StoredCredentialProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null and warns for account-manager refs', async () => {
    const provider = new StoredCredentialProvider(createBusInstance());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await provider.resolve(CredentialRefSchema.parse('account-manager:["claude-code","account-123"]'));

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      '[StoredCredentialProvider] account-manager: refs are account identifiers ' +
        'and cannot be resolved to credentials. The associated adapter should ' +
        'authenticate via its native credential store.',
    );
  });
});
