import { describe, expect, it } from 'vitest';
import type { ProviderDefinitionInput } from '@makaio/contracts';
import {
  MAKAIO_CONFORMANCE_PRIMARY_MODEL_ENV,
  MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV,
  MAKAIO_CONFORMANCE_PROVIDER_ENV,
  MAKAIO_CONFORMANCE_SECONDARY_MODEL_ENV,
  resolveConformanceTestPreset,
} from '../resolveConformanceTestPreset.js';

const anthropicOAuthProvider: ProviderDefinitionInput = {
  id: 'anthropic-oauth',
  name: 'Anthropic OAuth',
  defaultModel: 'sonnet',
  fastModel: 'haiku',
};

const anthropicApiProvider: ProviderDefinitionInput = {
  id: 'anthropic',
  name: 'Anthropic API',
  defaultModel: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5',
  credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
};

const opencodeGoAnthropicProvider: ProviderDefinitionInput = {
  id: 'opencode-go-anthropic',
  name: 'OpenCode Go Anthropic',
  endpoints: { anthropic: 'https://opencode.example.test/anthropic' },
  defaultModel: 'minimax-m2.5',
  fastModel: 'minimax-m2.7',
  credentialEnvVars: { apiKey: 'OPENCODE_GO_API_KEY' },
};

function resolveWithEnv(env: Record<string, string | undefined>) {
  return resolveConformanceTestPreset({
    adapterName: 'claude-code',
    defaultProviderId: 'anthropic-oauth',
    providerIds: ['anthropic-oauth', 'anthropic', 'opencode-go-anthropic'],
    providerDefinitions: [anthropicOAuthProvider, anthropicApiProvider, opencodeGoAnthropicProvider],
    reasoningEffort: 'low',
    readEnv: (name) => env[name],
  });
}

describe('resolveConformanceTestPreset', () => {
  it('uses the adapter default provider when no env override is set', () => {
    const preset = resolveWithEnv({});

    expect(preset.provider.id).toBe('anthropic-oauth');
    expect(preset.primaryModel).toEqual({
      definitionId: 'anthropic-oauth',
      modelName: 'haiku',
      reasoningEffort: 'low',
    });
    expect(preset.secondaryModel).toEqual({
      definitionId: 'anthropic-oauth',
      modelName: 'sonnet',
      reasoningEffort: 'low',
    });
    expect(preset.providerContext).toMatchObject({
      definitionId: 'anthropic-oauth',
      credentialRefs: {},
    });
  });

  it('resolves provider credentials and endpoint overrides from MAKAIO_CONFORMANCE_PROVIDER', () => {
    const preset = resolveWithEnv({
      [MAKAIO_CONFORMANCE_PROVIDER_ENV]: 'opencode-go-anthropic',
    });

    expect(preset.provider.id).toBe('opencode-go-anthropic');
    expect(preset.primaryModel).toMatchObject({
      definitionId: 'opencode-go-anthropic',
      modelName: 'minimax-m2.7',
    });
    expect(preset.secondaryModel).toMatchObject({
      definitionId: 'opencode-go-anthropic',
      modelName: 'minimax-m2.5',
    });
    expect(preset.providerContext).toMatchObject({
      definitionId: 'opencode-go-anthropic',
      credentialEnvVars: { apiKey: 'OPENCODE_GO_API_KEY' },
      credentialRefs: { apiKey: 'env:OPENCODE_GO_API_KEY' },
      endpointOverrides: { anthropic: 'https://opencode.example.test/anthropic' },
    });
    expect(preset.providerContext.ambientCredentialEnvVars).toEqual(['ANTHROPIC_API_KEY', 'OPENCODE_GO_API_KEY']);
  });

  it('allows primary and secondary model overrides on the selected provider', () => {
    const preset = resolveWithEnv({
      [MAKAIO_CONFORMANCE_PROVIDER_ENV]: 'opencode-go-anthropic',
      [MAKAIO_CONFORMANCE_PRIMARY_MODEL_ENV]: 'cheap-model',
      [MAKAIO_CONFORMANCE_SECONDARY_MODEL_ENV]: 'switch-model',
    });

    expect(preset.primaryModel).toMatchObject({
      definitionId: 'opencode-go-anthropic',
      modelName: 'cheap-model',
    });
    expect(preset.secondaryModel).toMatchObject({
      definitionId: 'opencode-go-anthropic',
      modelName: 'switch-model',
    });
  });

  it('ignores blank env overrides', () => {
    const preset = resolveWithEnv({
      [MAKAIO_CONFORMANCE_PROVIDER_ENV]: '   ',
      [MAKAIO_CONFORMANCE_PRIMARY_MODEL_ENV]: '',
      [MAKAIO_CONFORMANCE_SECONDARY_MODEL_ENV]: ' ',
    });

    expect(preset.provider.id).toBe('anthropic-oauth');
    expect(preset.primaryModel.modelName).toBe('haiku');
    expect(preset.secondaryModel.modelName).toBe('sonnet');
  });

  it('fails with accepted provider IDs when the provider override is unknown', () => {
    expect(() =>
      resolveWithEnv({
        [MAKAIO_CONFORMANCE_PROVIDER_ENV]: 'missing-provider',
      }),
    ).toThrow(
      "[claude-code] Unknown conformance provider 'missing-provider' from MAKAIO_CONFORMANCE_PROVIDER. Available providers: anthropic-oauth, anthropic, opencode-go-anthropic",
    );
  });

  it('can read provider definitions from the conformance worker environment', () => {
    const preset = resolveConformanceTestPreset({
      adapterName: 'claude-code',
      defaultProviderId: 'anthropic-oauth',
      providerIds: ['anthropic-oauth', 'opencode-go-anthropic'],
      reasoningEffort: 'low',
      readEnv: (name) =>
        name === MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV
          ? JSON.stringify([anthropicOAuthProvider, opencodeGoAnthropicProvider])
          : undefined,
    });

    expect(preset.provider.id).toBe('anthropic-oauth');
    expect(preset.providerContext.ambientCredentialEnvVars).toEqual(['OPENCODE_GO_API_KEY']);
  });

  it('adds env-var context to malformed provider definition JSON errors', () => {
    expect(() =>
      resolveConformanceTestPreset({
        adapterName: 'claude-code',
        defaultProviderId: 'anthropic-oauth',
        providerIds: ['anthropic-oauth'],
        readEnv: (name) => (name === MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV ? '{' : undefined),
      }),
    ).toThrow(`${MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV} must contain valid JSON:`);
  });

  it('fails with env-var context when provider definitions are malformed', () => {
    expect(() =>
      resolveConformanceTestPreset({
        adapterName: 'claude-code',
        defaultProviderId: 'anthropic-oauth',
        providerIds: ['anthropic-oauth'],
        readEnv: (name) =>
          name === MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV ? JSON.stringify([{ name: 'Missing ID' }]) : undefined,
      }),
    ).toThrow(`${MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV}[0] must be a provider object with an id`);
  });
});
