import { describe, it, expect, vi } from 'vitest';
import type { ResolvableCanonicalModel } from '@makaio/contracts';
import { CanonicalModelResolver } from '../resolver.js';
import type { CanonicalModelResolverDeps, DefaultModelResolution } from '../resolver-deps.js';
import { CanonicalModelResolutionError } from '../errors.js';
import { makeBinding, makeConfigRecord, makeDefinition } from './fixtures.js';

function createStubDeps(overrides: Partial<CanonicalModelResolverDeps> = {}): CanonicalModelResolverDeps {
  return {
    listEnabledAdapterNames: vi.fn().mockResolvedValue([]),
    getDefaultBinding: vi.fn().mockResolvedValue(undefined),
    findProviderConfigByName: vi.fn().mockResolvedValue(undefined),
    findProviderDefinition: vi.fn().mockResolvedValue(undefined),
    listBindingsForConfig: vi.fn().mockResolvedValue([]),
    findDefaultConfigForDefinition: vi.fn().mockResolvedValue(undefined),
    findConfigForDefinitionAndAdapter: vi.fn().mockResolvedValue(undefined),
    resolveDefaultModelTarget: vi.fn().mockResolvedValue({ kind: 'not-found' } satisfies DefaultModelResolution),
    ...overrides,
  };
}

describe('CanonicalModelResolver', () => {
  it('resolves bare models through the default target seam', async () => {
    const deps = createStubDeps({
      resolveDefaultModelTarget: vi.fn().mockResolvedValue({
        kind: 'resolved',
        target: {
          adapterName: 'anthropic-sdk',
          providerConfigId: 'config-1',
          definitionId: 'def-1',
          model: 'sonnet',
        },
      } satisfies DefaultModelResolution),
    });

    await expect(new CanonicalModelResolver(deps).resolve({ kind: 'bare', model: 'sonnet' })).resolves.toEqual({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      providerConfigId: 'config-1',
      model: 'sonnet',
    });
  });

  it('throws ambiguous-model when bare resolution yields multiple matches', async () => {
    const deps = createStubDeps({
      resolveDefaultModelTarget: vi.fn().mockResolvedValue({
        kind: 'ambiguous',
        matches: [
          { adapterName: 'anthropic-sdk', definitionId: 'def-1', qualifiedName: 'anthropic-sdk::sonnet' },
          {
            adapterName: 'openai-node',
            definitionId: 'def-2',
            qualifiedName: 'openai-node/openrouter::sonnet',
          },
        ],
      } satisfies DefaultModelResolution),
    });

    const error = await new CanonicalModelResolver(deps)
      .resolve({ kind: 'bare', model: 'sonnet' })
      .catch((value) => value);

    expect(error).toBeInstanceOf(CanonicalModelResolutionError);
    expect(error.code).toBe('ambiguous-model');
    expect(error.suggestions).toContain('anthropic-sdk::sonnet');
    expect(error.suggestions).toContain('openai-node/openrouter::sonnet');
  });

  it('prefers adapter-name resolution over provider-config-name resolution', async () => {
    const deps = createStubDeps({
      listEnabledAdapterNames: vi.fn().mockResolvedValue(['anthropic-sdk']),
      getDefaultBinding: vi
        .fn()
        .mockResolvedValue(makeBinding({ adapterName: 'anthropic-sdk', providerConfigId: 'config-via-adapter' })),
      findProviderConfigByName: vi.fn().mockResolvedValue(makeConfigRecord({ id: 'config-via-name' })),
      listBindingsForConfig: vi
        .fn()
        .mockResolvedValue([makeBinding({ adapterName: 'other-adapter', providerConfigId: 'config-via-name' })]),
    });

    await expect(
      new CanonicalModelResolver(deps).resolve({
        kind: 'qualified',
        segment1: 'anthropic-sdk',
        segment2: undefined,
        model: 'sonnet',
      }),
    ).resolves.toEqual({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      providerConfigId: 'config-via-adapter',
      model: 'sonnet',
    });
    expect(deps.findProviderConfigByName).not.toHaveBeenCalled();
  });

  it('resolves provider definition IDs via the default config and binding', async () => {
    const deps = createStubDeps({
      listEnabledAdapterNames: vi.fn().mockResolvedValue(['anthropic-sdk']),
      findProviderDefinition: vi.fn().mockResolvedValue(makeDefinition({ id: 'def-1' })),
      findDefaultConfigForDefinition: vi.fn().mockResolvedValue(makeConfigRecord({ id: 'config-1' })),
      listBindingsForConfig: vi
        .fn()
        .mockResolvedValue([makeBinding({ adapterName: 'anthropic-sdk', providerConfigId: 'config-1' })]),
    });

    await expect(
      new CanonicalModelResolver(deps).resolve({
        kind: 'qualified',
        segment1: 'def-1',
        segment2: undefined,
        model: 'claude-sonnet',
      }),
    ).resolves.toEqual({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      providerConfigId: 'config-1',
      model: 'claude-sonnet',
    });
  });

  it('requires a binding for two-segment adapter/provider references', async () => {
    const deps = createStubDeps({
      listEnabledAdapterNames: vi.fn().mockResolvedValue(['anthropic-sdk']),
      findProviderConfigByName: vi.fn().mockResolvedValue(makeConfigRecord({ id: 'config-1' })),
      listBindingsForConfig: vi
        .fn()
        .mockResolvedValue([makeBinding({ adapterName: 'openai-node', providerConfigId: 'config-1' })]),
    });

    const error = await new CanonicalModelResolver(deps)
      .resolve({
        kind: 'qualified',
        segment1: 'anthropic-sdk',
        segment2: 'my-provider',
        model: 'sonnet',
      })
      .catch((value) => value);

    expect(error).toBeInstanceOf(CanonicalModelResolutionError);
    expect(error.code).toBe('no-binding');
  });

  it('rejects unknown segments', async () => {
    const parsed: ResolvableCanonicalModel = {
      kind: 'qualified',
      segment1: 'no-such-thing',
      segment2: undefined,
      model: 'sonnet',
    };

    const error = await new CanonicalModelResolver(createStubDeps()).resolve(parsed).catch((value) => value);

    expect(error).toBeInstanceOf(CanonicalModelResolutionError);
    expect(error.code).toBe('adapter-not-found');
  });
});
