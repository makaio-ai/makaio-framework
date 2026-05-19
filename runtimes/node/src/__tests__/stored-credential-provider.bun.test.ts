import { describe, expect, it, spyOn, afterEach, mock } from 'bun:test';
import { createBusInstance } from '@makaio/bus-core';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { StoredCredentialProvider } from '../credential-provider.js';

describe('StoredCredentialProvider', () => {
  afterEach(() => {
    mock.restore();
  });

  it('returns null and warns for account-manager refs', async () => {
    const provider = new StoredCredentialProvider(createBusInstance());
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

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
