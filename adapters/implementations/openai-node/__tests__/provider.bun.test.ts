import { ProviderDefinitionSchema } from '@makaio/contracts';
import { describe, expect, it } from 'bun:test';
import { defaultPresetId, testPresetId } from '../src/provider.js';
import { providerDefinition as nanogptDefinition } from '@makaio/provider-nanogpt';
import { providerDefinition as openrouterDefinition } from '@makaio/provider-openrouter';
import { openaiProviderDefinition as opencodeGoDefinition } from '@makaio/provider-opencode-go';

describe('openai-node provider defaults', () => {
  it('uses OpenAI as the host default provider', () => {
    expect(defaultPresetId).toBe('openai');
  });

  it('uses OpenCode Go as the test provider', () => {
    expect(testPresetId).toBe('opencode-go');
  });

  it('declares the OpenCode Go definition with an OpenAI-compatible endpoint', () => {
    expect(opencodeGoDefinition.endpoints?.openai).toBe('https://opencode.ai/zen/go/v1');
    expect(opencodeGoDefinition.credentialEnvVars).toEqual({ apiKey: 'OPENCODE_GO_API_KEY' });
    expect(opencodeGoDefinition.defaultModel).toBe('kimi-k2.5');
    expect(opencodeGoDefinition.fastModel).toBe('glm-5.1');
    // Model catalog is now YAML-sourced — availableModels is populated by the registry service at boot time.
  });
});

describe('NanoGPT definition schema conformance', () => {
  it('definition is present in provider package', () => {
    expect(nanogptDefinition).toBeDefined();
  });

  it('parses against ProviderDefinitionSchema without errors', () => {
    const result = ProviderDefinitionSchema.safeParse(nanogptDefinition);

    expect(result.success).toBe(true);
  });

  // Model catalog data (TTS, STT, pricing) is YAML-sourced and no longer declared
  // in static provider definitions. These are populated by the registry service at
  // boot time from providers/providers/nanogpt.yaml.
});

describe('OpenRouter definition schema conformance', () => {
  it('definition is present in provider package', () => {
    expect(openrouterDefinition).toBeDefined();
  });

  it('parses against ProviderDefinitionSchema without errors', () => {
    const result = ProviderDefinitionSchema.safeParse(openrouterDefinition);

    expect(result.success).toBe(true);
  });

  it('uses the canonical OpenRouter API key environment variable', () => {
    expect(openrouterDefinition.credentialEnvVars).toEqual({ apiKey: 'OPENROUTER_API_KEY' });
  });
});
