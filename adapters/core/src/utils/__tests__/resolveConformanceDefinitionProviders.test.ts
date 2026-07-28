import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAdapterProviderAuth, type AdapterProviderRef, type ProviderDefinitionInput } from '@makaio/contracts';
import { resolveConformanceDefinitionProviders } from '../resolveConformanceDefinitionProviders.js';

const anthropicProvider: ProviderDefinitionInput = {
  id: 'anthropic',
  name: 'Anthropic API',
  authMethods: [],
  defaultModel: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5',
};

const openaiProvider: ProviderDefinitionInput = {
  id: 'openai',
  name: 'OpenAI API',
  authMethods: [],
  defaultModel: 'gpt-5',
  fastModel: 'gpt-5-mini',
};

const anthropicAuth = defineAdapterProviderAuth({
  bindings: [
    {
      method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
      deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
    },
  ],
  scrubEnvVars: ['ANTHROPIC_API_KEY'],
});

describe('resolveConformanceDefinitionProviders', () => {
  it('pairs each preset provider with its declaration and preserves preset order', () => {
    const resolved = resolveConformanceDefinitionProviders({
      adapterName: 'test-adapter',
      providers: [openaiProvider, anthropicProvider],
      adapterProviders: [
        { definitionId: 'anthropic', protocol: 'anthropic', auth: anthropicAuth },
        { definitionId: 'openai', protocol: 'openai' },
      ],
    });

    expect(resolved).toHaveLength(2);
    expect(resolved.map((entry) => entry.definition.id)).toEqual(['openai', 'anthropic']);
    expect(resolved[0]).toEqual({ definition: openaiProvider, protocol: 'openai' });
    expect(resolved[1]).toEqual({ definition: anthropicProvider, protocol: 'anthropic', auth: anthropicAuth });
  });

  it('omits protocol and auth entirely when the declaration does not carry them', () => {
    const [resolved] = resolveConformanceDefinitionProviders({
      adapterName: 'test-adapter',
      providers: [anthropicProvider],
      adapterProviders: [{ definitionId: 'anthropic' }],
    });

    // Absent keys rather than explicit `undefined`, so the paired entry is
    // structurally equal to one the adapter subsystem builds at boot.
    expect(Object.keys(resolved)).toEqual(['definition']);
  });

  it('does not carry the per-provider config schema, which only the booted settings surface reads', () => {
    const declaration: AdapterProviderRef = {
      definitionId: 'anthropic',
      configSchema: z.object({ region: z.string() }),
    };

    const [resolved] = resolveConformanceDefinitionProviders({
      adapterName: 'test-adapter',
      providers: [anthropicProvider],
      adapterProviders: [declaration],
    });

    // Asserted over the key set rather than with `toEqual`, which treats an
    // absent key and an explicit `undefined` as equal and so cannot tell a
    // dropped field from one carried through as undefined.
    expect(Object.keys(resolved)).toEqual(['definition']);
  });

  it('reports the adapter, the undeclared provider, and the declared IDs', () => {
    expect(() =>
      resolveConformanceDefinitionProviders({
        adapterName: 'test-adapter',
        providers: [anthropicProvider, openaiProvider],
        adapterProviders: [{ definitionId: 'anthropic' }],
      }),
    ).toThrow(
      "[test-adapter] Conformance provider 'openai' is not declared by the adapter. Declared providers: anthropic.",
    );
  });

  it('reports no declared providers rather than an empty list when the adapter declares none', () => {
    expect(() =>
      resolveConformanceDefinitionProviders({
        adapterName: 'test-adapter',
        providers: [anthropicProvider],
        adapterProviders: [],
      }),
    ).toThrow(
      "[test-adapter] Conformance provider 'anthropic' is not declared by the adapter. Declared providers: none.",
    );
  });

  it('returns an empty pairing when the preset accepted no providers', () => {
    expect(
      resolveConformanceDefinitionProviders({
        adapterName: 'test-adapter',
        providers: [],
        adapterProviders: [{ definitionId: 'anthropic' }],
      }),
    ).toEqual([]);
  });
});
