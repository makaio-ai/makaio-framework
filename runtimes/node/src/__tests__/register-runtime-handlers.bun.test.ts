import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { MakaioBus, NoHandlerError } from '@makaio/bus-core';
import type { AIModel } from '@makaio/contracts';
import type { AdapterInstance, LoadedAdapter } from '@makaio/adapter-subsystem';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderRuntimeSubjects } from '@makaio/services-core/provider-runtime';
import { SettingsSubjects } from '@makaio/services-core/settings/namespace';
import { registerRuntimeHandlers } from '../register-runtime-handlers.js';

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('registers extension config schema lookup through framework boot handlers', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) =>
        name === 'configured-extension'
          ? {
              configSchema: z.object({ enabled: z.boolean().default(true) }),
              uiConfig: { editMode: 'slidePanel' },
            }
          : undefined,
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'configured-extension',
    });

    expect(result).toMatchObject({
      hasSchema: true,
      uiConfig: { editMode: 'slidePanel' },
    });
    expect(result.schema).not.toHaveProperty('$schema');

    cleanup();
    await expect(
      MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
        extensionName: 'configured-extension',
      }),
    ).rejects.toBeInstanceOf(NoHandlerError);
  });

  it('omits extension config schema lookup when no coordinator lookup is supplied', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
    );

    await expect(
      MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
        extensionName: 'configured-extension',
      }),
    ).rejects.toBeInstanceOf(NoHandlerError);

    cleanup();
  });

  it('fetches models from the adapter bound to the provider config when definition IDs are duplicated', async () => {
    const providerDefinition = {
      id: 'shared-provider',
      name: 'Shared Provider',
      availableModels: [],
      defaultModelFilterMode: 'show-all' as const,
    };
    const wrongFetchModels = mock(
      async (_baseUrl: string | undefined, _credentials: Record<string, string> | undefined): Promise<AIModel[]> => [
        { name: 'wrong-model', contextWindowSize: 1, labId: 'test-lab' },
      ],
    );
    const boundFetchModels = mock(
      async (_baseUrl: string | undefined, _credentials: Record<string, string> | undefined): Promise<AIModel[]> => [
        { name: 'bound-model', contextWindowSize: 2, labId: 'test-lab' },
      ],
    );
    const wrongInstance: AdapterInstance & { fetchModels: typeof wrongFetchModels } = {
      adapterId: 'wrong-adapter-id',
      fetchModels: wrongFetchModels,
    };
    const boundInstance: AdapterInstance & { fetchModels: typeof boundFetchModels } = {
      adapterId: 'bound-adapter-id',
      fetchModels: boundFetchModels,
    };
    const adapters: LoadedAdapter[] = [
      {
        name: 'wrong-adapter',
        packageName: 'wrong-package',
        factory: async () => ({ adapterId: 'wrong-adapter-id' }),
        options: { adapterId: 'wrong-adapter-id' },
        providers: [{ definition: providerDefinition }],
      },
      {
        name: 'bound-adapter',
        packageName: 'bound-package',
        factory: async () => ({ adapterId: 'bound-adapter-id' }),
        options: { adapterId: 'bound-adapter-id' },
        providers: [{ definition: providerDefinition }],
      },
    ];
    const instances = new Map<string, AdapterInstance>([
      ['wrong-adapter-id', wrongInstance],
      ['bound-adapter-id', boundInstance],
    ]);

    const offProviderConfig = MakaioBus.on(AdapterSubsystemSubjects.getProviderConfig, ({ payload, setResult }) => {
      expect(payload.id).toBe('shared.work');
      setResult({
        config: {
          id: 'shared.work',
          definitionId: 'shared-provider',
          name: 'Shared Work',
          modelFilterMode: 'show-all',
          isDefault: true,
          enabled: true,
          isSentinel: false,
          hasCredentials: false,
        },
      });
    });
    const offBindings = MakaioBus.on(AdapterSubsystemSubjects.listBindingsByConfig, ({ payload, setResult }) => {
      expect(payload.providerConfigId).toBe('shared.work');
      setResult({
        bindings: [{ adapterName: 'bound-adapter', providerConfigId: 'shared.work', isDefault: true }],
      });
    });
    const offContext = MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, ({ payload, setResult }) => {
      expect(payload.providerConfigId).toBe('shared.work');
      setResult({
        context: {
          providerConfigId: 'shared.work',
          definitionId: 'shared-provider',
          endpointOverrides: { openai: 'https://bound.example/v1' },
          credentialRefs: {},
        },
      });
    });
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => adapters,
      () => instances,
    );

    const result = await MakaioBus.request(ProviderRuntimeSubjects.fetchModels, { providerConfigId: 'shared.work' });

    expect(result.models).toEqual([{ name: 'bound-model', contextWindowSize: 2, labId: 'test-lab' }]);
    expect(wrongFetchModels).not.toHaveBeenCalled();
    expect(boundFetchModels).toHaveBeenCalledWith('https://bound.example/v1', {});

    cleanup();
    offContext();
    offBindings();
    offProviderConfig();
  });
});
