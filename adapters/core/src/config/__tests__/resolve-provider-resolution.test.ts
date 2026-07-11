import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { AuthCredentialRefSchema, type ProviderAuthMethodDefinition } from '@makaio/contracts/auth';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import {
  AdapterSubsystemSubjects,
  type AdapterFileConfigSet,
  type IAdapterConfigRepository,
  type ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects, type ProviderRecord } from '@makaio/services-core/settings/storage';
import { AdapterSubsystemService, ProviderConfigAuthValidationError } from '@makaio/subsystem-adapter';
import { ExtensionCoordinator } from '@makaio/kernel';
import { resolveProviderResolution, ProviderResolutionError } from '../resolve-provider-resolution.js';

const API_KEY_METHOD = {
  id: 'api-key',
  mode: 'explicit',
  label: 'API key',
  fields: [
    {
      id: 'apiKey',
      label: 'API key',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'PROVIDER_API_KEY' }],
    },
  ],
} satisfies ProviderAuthMethodDefinition;

const PROVIDER_CONFIG: ProviderConfigFile = {
  $schema: 'makaio/provider-config/v2',
  definitionId: 'provider-1',
  name: 'Provider Config',
  auth: {
    mode: 'explicit',
    method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'api-key' },
    credentialRefs: { apiKey: AuthCredentialRefSchema.parse('env:PROVIDER_API_KEY') },
  },
  endpointOverrides: { anthropic: 'https://override.example.com' },
  modelFilterMode: 'show-all',
  isDefault: true,
  enabled: true,
};

const PROVIDER_RECORD: ProviderRecord = {
  id: 'provider-1',
  packageName: '@makaio/provider-test',
  name: 'Provider',
  endpoints: { anthropic: 'https://default.example.com' },
  availableModels: [],
  authMethods: [API_KEY_METHOD],
  defaultModelFilterMode: 'show-all',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

let cleanupFns: Array<() => void | Promise<void>>;
let subsystemService: AdapterSubsystemService | null;

class ProviderResolutionRepository implements IAdapterConfigRepository {
  public constructor(private readonly providerConfigs: Map<string, ProviderConfigFile>) {}

  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    return { configs: new Map<string, AdapterFile>() };
  }

  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    return { configs: new Map([...this.providerConfigs].map(([id, config]) => [id, structuredClone(config)])) };
  }

  public async writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void> {
    this.providerConfigs.set(id, structuredClone(config));
  }

  public async deleteProviderConfig(): Promise<boolean> {
    throw new Error('Provider resolution tests must not delete provider configs.');
  }

  public async writeAdapterFile(): Promise<void> {
    throw new Error('Provider resolution tests must not write adapter configs.');
  }

  public async deleteAdapterFile(): Promise<boolean> {
    throw new Error('Provider resolution tests must not delete adapter configs.');
  }
}

/**
 * Register the real adapter subsystem and provider-definition read handler.
 * @param options - Optional provider configs and definition-read behavior
 * @returns Promise resolved after subsystem initialization
 */
async function setupResolution(options?: {
  readonly configs?: Map<string, ProviderConfigFile>;
  readonly resolveProvider?: (readIndex: number) => ProviderRecord | null | Promise<ProviderRecord | null>;
}): Promise<void> {
  subsystemService = new AdapterSubsystemService({
    bus: MakaioBus,
    configRepository: new ProviderResolutionRepository(
      options?.configs ?? new Map([['cfg-1', structuredClone(PROVIDER_CONFIG)]]),
    ),
    coordinator: new ExtensionCoordinator(MakaioBus),
    machineId: 'test-machine',
    platformDefaults: {},
  });
  cleanupFns.push(() => subsystemService?.destroy().catch(() => undefined));

  let readIndex = 0;
  cleanupFns.push(
    MakaioBus.on(ProviderStorageSubjects.get, async (ctx) => {
      readIndex += 1;
      ctx.setResult({
        provider: options?.resolveProvider ? await options.resolveProvider(readIndex) : PROVIDER_RECORD,
      });
    }),
  );
  await subsystemService.init();
}

beforeEach(() => {
  cleanupFns = [];
  subsystemService = null;
  MakaioBus.__resetHandlers?.();
});

afterEach(async () => {
  for (const cleanup of cleanupFns) {
    await cleanup();
  }
  MakaioBus.__resetHandlers?.();
});

describe('resolveProviderResolution', () => {
  it('returns the safe config, definition, endpoint, and refs-only normalized auth', async () => {
    await setupResolution();

    const result = await resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic');

    expect(result).toEqual({
      config: {
        id: 'cfg-1',
        definitionId: 'provider-1',
        name: 'Provider Config',
        endpointOverrides: { anthropic: 'https://override.example.com' },
        modelFilterMode: 'show-all',
        isDefault: true,
        enabled: true,
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'api-key' },
          hasCredentials: true,
        },
      },
      definition: PROVIDER_RECORD,
      baseUrl: 'https://override.example.com',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'api-key' },
        definition: API_KEY_METHOD,
        credentialRefs: { apiKey: 'env:PROVIDER_API_KEY' },
      },
    });
    expect(result).not.toHaveProperty('credentials');
  });

  it('uses the definition endpoint when the config has no override', async () => {
    const config = structuredClone(PROVIDER_CONFIG);
    delete config.endpointOverrides;
    await setupResolution({ configs: new Map([['cfg-1', config]]) });

    await expect(resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic')).resolves.toMatchObject({
      baseUrl: 'https://default.example.com',
    });
  });

  it('throws a typed error when the provider config cannot be found', async () => {
    await setupResolution();

    const error = await resolveProviderResolution(MakaioBus, 'missing', 'anthropic').catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ProviderResolutionError);
    expect((error as ProviderResolutionError).code).toBe('provider-config-not-found');
  });

  it('keeps config metadata and credential refs on one captured snapshot during concurrent mutation', async () => {
    await setupResolution({
      resolveProvider: async (readIndex) => {
        if (readIndex === 1) {
          await MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
            id: 'cfg-1',
            patch: { endpointOverrides: { anthropic: 'https://new.example.com' } },
          });
          await MakaioBus.request(AdapterSubsystemSubjects.setProviderConfigAuth, {
            id: 'cfg-1',
            auth: {
              mode: 'explicit',
              method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'api-key' },
              credentialRefs: { apiKey: 'env:NEW_PROVIDER_API_KEY' },
            },
          });
        }
        return PROVIDER_RECORD;
      },
    });

    const captured = await resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic');
    expect(captured.config.endpointOverrides).toEqual({ anthropic: 'https://override.example.com' });
    expect(captured.baseUrl).toBe('https://override.example.com');
    expect(captured.auth).toMatchObject({
      credentialRefs: { apiKey: 'env:PROVIDER_API_KEY' },
    });

    const { snapshot: current } = await MakaioBus.request(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, {
      providerConfigId: 'cfg-1',
    });
    expect(current?.config.endpointOverrides).toEqual({ anthropic: 'https://new.example.com' });
    expect(current?.context.auth).toMatchObject({
      credentialRefs: { apiKey: 'env:NEW_PROVIDER_API_KEY' },
    });
  });

  it('preserves the typed dangling-definition failure from snapshot assembly', async () => {
    await setupResolution({ resolveProvider: () => null });

    const error = await resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic').catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestError);
    const cause = (error as RequestError).cause;
    expect(cause).toBeInstanceOf(ProviderConfigAuthValidationError);
    expect((cause as ProviderConfigAuthValidationError).code).toBe('provider-definition-not-found');
  });
});
