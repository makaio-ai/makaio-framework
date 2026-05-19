import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { CredentialRefSchema, PROVIDER_CONFIG_SCHEMA_VERSION } from '@makaio/contracts/config';
import { ProviderStorageSubjects, type ProviderRecord } from '@makaio/services-core/settings/storage';
import { buildProviderContextFromRaw } from './provider-runtime-view.js';

const BASE_PROVIDER: Omit<ProviderRecord, 'id' | 'packageName' | 'name' | 'credentialEnvVars'> = {
  availableModels: [],
  defaultModelFilterMode: 'show-all',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

/**
 * Build a provider storage record for runtime-view tests.
 * @param id - Provider definition id
 * @param credentialEnvVars - Optional credential env var mapping
 * @returns Provider storage record
 */
function providerRecord(id: string, credentialEnvVars?: Record<string, string>): ProviderRecord {
  return {
    ...BASE_PROVIDER,
    id,
    packageName: `@makaio/provider-${id}`,
    name: id,
    ...(credentialEnvVars ? { credentialEnvVars } : {}),
  };
}

describe('buildProviderContextFromRaw', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('includes all known provider credential env vars for subprocess sanitization', async () => {
    const anthropic = providerRecord('anthropic', { apiKey: 'ANTHROPIC_API_KEY' });
    const openai = providerRecord('openai', { apiKey: 'OPENAI_API_KEY' });
    const unsubGet = MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({ provider: anthropic });
    });
    const unsubList = MakaioBus.on(ProviderStorageSubjects.list, (ctx) => {
      ctx.setResult({ providers: [anthropic, openai] });
    });

    try {
      await expect(
        buildProviderContextFromRaw(MakaioBus, 'anthropic.work', {
          $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
          definitionId: 'anthropic',
          name: 'Anthropic Work',
          credentials: {
            apiKey: CredentialRefSchema.parse('stored:providerConfig:anthropic.work:apiKey'),
          },
          isDefault: true,
          enabled: true,
        }),
      ).resolves.toMatchObject({
        ambientCredentialEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      });
    } finally {
      unsubGet();
      unsubList();
    }
  });
});
