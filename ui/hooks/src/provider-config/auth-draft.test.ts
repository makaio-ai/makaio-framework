import { describe, expect, it } from 'vitest';
import type { CompatibleAuthOption } from '@makaio/services-core/adapter-subsystem';
import {
  authDraftRequiresStorage,
  buildProviderConfigAuthDraft,
  compileProviderConfigAuthDraft,
  createInitialAuthFieldDrafts,
} from './auth-draft.js';

const EXPLICIT_OPTION: CompatibleAuthOption = {
  definitionId: 'example',
  method: { owner: 'provider', providerDefinitionId: 'example', methodId: 'service-account' },
  mode: 'explicit',
  label: 'Service account',
  fields: [
    {
      id: 'clientSecret',
      label: 'Client secret',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'EXAMPLE_CLIENT_SECRET' }],
    },
    {
      id: 'tenantId',
      label: 'Tenant ID',
      required: false,
      secret: false,
      sourceHints: [{ kind: 'environment', variable: 'EXAMPLE_TENANT_ID' }],
    },
  ],
  compatibleAdapterNames: ['example-adapter'],
  portability: 'portable',
};

describe('provider config auth draft compiler', () => {
  it('builds strict explicit drafts while preserving optional omissions', () => {
    expect(createInitialAuthFieldDrafts(EXPLICIT_OPTION)).toEqual({
      clientSecret: { source: 'stored', value: '' },
      tenantId: { source: 'stored', value: '' },
    });
    expect(
      buildProviderConfigAuthDraft(EXPLICIT_OPTION, {
        clientSecret: { source: 'environment', variable: 'EXAMPLE_CLIENT_SECRET' },
        tenantId: { source: 'stored', value: '' },
      }),
    ).toEqual({
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: 'example', methodId: 'service-account' },
      fields: { clientSecret: { source: 'environment', variable: 'EXAMPLE_CLIENT_SECRET' } },
    });
  });

  it('rejects missing required fields and undeclared environment sources', () => {
    expect(() => buildProviderConfigAuthDraft(EXPLICIT_OPTION, {})).toThrow(
      'Complete the required field: Client secret.',
    );
    expect(() =>
      buildProviderConfigAuthDraft(EXPLICIT_OPTION, {
        clientSecret: { source: 'environment', variable: 'UNDECLARED_SECRET' },
      }),
    ).toThrow('Environment source "UNDECLARED_SECRET" is not declared for authentication field "clientSecret".');
  });

  it('compiles mixed multi-field sources into final refs and the stored plaintext subset', () => {
    const draft = {
      mode: 'explicit' as const,
      method: { owner: 'provider' as const, providerDefinitionId: 'example', methodId: 'service-account' },
      fields: {
        clientSecret: { source: 'stored' as const, value: 'secret-value' },
        tenantId: { source: 'environment' as const, variable: 'EXAMPLE_TENANT_ID' },
      },
    };

    expect(authDraftRequiresStorage(draft)).toBe(true);
    expect(compileProviderConfigAuthDraft(draft, 'example-work')).toEqual({
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'example', methodId: 'service-account' },
        credentialRefs: {
          clientSecret: 'stored:providerConfig:example-work:clientSecret',
          tenantId: 'env:EXAMPLE_TENANT_ID',
        },
      },
      storedCredentials: { clientSecret: 'secret-value' },
    });
  });

  it('preserves distinct inferred native-account and no-auth selections', () => {
    expect(
      compileProviderConfigAuthDraft({
        mode: 'inferred',
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        account: { managerId: 'account-manager', accountId: 'work' },
      }),
    ).toEqual({
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        account: { managerId: 'account-manager', accountId: 'work' },
      },
      storedCredentials: {},
    });
    expect(
      compileProviderConfigAuthDraft({
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'local', methodId: 'none' },
      }),
    ).toEqual({
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'local', methodId: 'none' },
      },
      storedCredentials: {},
    });
  });

  it('requires the final canonical ID before compiling stored refs', () => {
    expect(() =>
      compileProviderConfigAuthDraft({
        mode: 'explicit',
        method: { owner: 'client', clientId: 'claude-code', methodId: 'oauth-token' },
        fields: { oauthToken: { source: 'stored', value: 'oauth-secret' } },
      }),
    ).toThrow('Stored authentication fields require the final provider-config ID.');
  });
});
