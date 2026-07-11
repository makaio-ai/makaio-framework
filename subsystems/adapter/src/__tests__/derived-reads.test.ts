import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects } from '@makaio/contracts';
import {
  CredentialRefSchema,
  buildStoredCredentialRef,
  type AdapterFile,
  type CredentialRef,
  type ProviderConfigFile,
} from '@makaio/contracts/config';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { createStubCoordinator, TEST_MACHINE_ID, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

const apiKeyMethod = {
  id: 'api-key',
  mode: 'explicit' as const,
  label: 'API key',
  fields: [
    {
      id: 'apiKey',
      label: 'API key',
      required: true,
      secret: true,
      sourceHints: [] as Array<{ kind: 'environment'; variable: string }>,
    },
  ],
};

/**
 * Create one no-auth v2 config for read-model tests.
 * @param definitionId - Provider definition selected by the config.
 * @param name - Human-readable config name.
 * @param options - Optional lifecycle overrides.
 */
function noAuthConfig(
  definitionId: string,
  name: string,
  options: Pick<ProviderConfigFile, 'isDefault' | 'enabled'> = {},
): ProviderConfigFile {
  return {
    $schema: 'makaio/provider-config/v2',
    definitionId,
    name,
    auth: {
      mode: 'none',
      method: { owner: 'provider', providerDefinitionId: definitionId, methodId: 'none' },
    },
    ...options,
  };
}

/**
 * Create one explicit v2 config for read-model tests.
 * @param definitionId - Provider definition selected by the config.
 * @param name - Human-readable config name.
 * @param credentialRef - Credential source reference stored by the config.
 * @param options - Optional endpoint and lifecycle overrides.
 */
function explicitConfig(
  definitionId: string,
  name: string,
  credentialRef: CredentialRef,
  options: Pick<ProviderConfigFile, 'endpointOverrides' | 'isDefault' | 'enabled'> = {},
): ProviderConfigFile {
  return {
    $schema: 'makaio/provider-config/v2',
    definitionId,
    name,
    auth: {
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: definitionId, methodId: 'api-key' },
      credentialRefs: { apiKey: credentialRef },
    },
    ...options,
  };
}

class SnapshotRepository implements IAdapterConfigRepository {
  public providerLoads = 0;
  public adapterLoads = 0;
  public providerWrites = 0;
  public adapterWrites = 0;
  public providerDeletes = 0;

  public constructor(
    private readonly providerConfigs: Map<string, ProviderConfigFile>,
    private readonly adapters: Map<string, AdapterFile>,
  ) {}

  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    this.adapterLoads += 1;
    return { configs: new Map([...this.adapters.entries()].map(([name, config]) => [name, structuredClone(config)])) };
  }

  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    this.providerLoads += 1;
    return {
      configs: new Map([...this.providerConfigs.entries()].map(([id, config]) => [id, structuredClone(config)])),
    };
  }

  public async writeProviderConfig(): Promise<void> {
    this.providerWrites += 1;
    throw new Error('Unexpected provider config write during derived-read test');
  }

  public async deleteProviderConfig(): Promise<boolean> {
    this.providerDeletes += 1;
    throw new Error('Unexpected provider config delete during derived-read test');
  }

  public async writeAdapterFile(): Promise<void> {
    this.adapterWrites += 1;
    throw new Error('Unexpected adapter write during derived-read test');
  }

  public async deleteAdapterFile(): Promise<boolean> {
    throw new Error('Unexpected adapter delete during derived-read test');
  }
}

/**
 * Start the adapter subsystem around one immutable repository snapshot.
 * @param repository - Immutable repository snapshot used by the service.
 */
async function startService(repository: SnapshotRepository): Promise<AdapterSubsystemService> {
  const service = new AdapterSubsystemService({
    bus: MakaioBus,
    configRepository: repository,
    coordinator: createStubCoordinator(),
    machineId: TEST_MACHINE_ID,
    platformDefaults: TEST_PLATFORM_DEFAULTS,
  });
  await service.init();
  return service;
}

describe('AdapterSubsystemService derived reads', () => {
  let service: AdapterSubsystemService;
  let repository: SnapshotRepository;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await service?.destroy?.();
    MakaioBus.__resetHandlers?.();
  });

  it('serves derived reads from one in-memory v2 snapshot without repository reloads', async () => {
    let capabilityRequests = 0;
    repository = new SnapshotRepository(
      new Map([
        [
          'anthropic.work',
          explicitConfig('anthropic', 'Anthropic Work', buildStoredCredentialRef('anthropic.work', 'apiKey'), {
            endpointOverrides: { anthropic: 'https://api.anthropic.test' },
            isDefault: true,
            enabled: true,
          }),
        ],
        ['anthropic.personal', noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true })],
        [
          'openai.team',
          explicitConfig('openai', 'OpenAI Team', CredentialRefSchema.parse('env:OPENAI_API_KEY'), {
            enabled: false,
          }),
        ],
        ['ghost.team', noAuthConfig('missing-provider', 'Ghost Team', { enabled: true })],
      ]),
      new Map([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            displayName: 'Claude Code',
            description: 'Claude Code adapter',
            helpLinks: [{ label: 'Docs', url: 'https://example.com/claude' }],
            instructions: 'Use the Claude Code CLI.',
            clientId: 'claude-code-cli',
            protocol: 'anthropic',
            providerDefinitionIds: ['anthropic'],
            settings: { maxConcurrency: 3 },
            bindings: [
              { providerConfigId: 'anthropic.work', isDefault: true },
              { providerConfigId: 'anthropic.personal' },
            ],
          },
        ],
        [
          'copilot',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: false,
            displayName: 'Copilot',
            clientId: 'github-copilot-sdk',
            protocol: 'openai',
            providerDefinitionIds: ['openai'],
            bindings: [{ providerConfigId: 'openai.team', isDefault: true }],
          },
        ],
      ]),
    );
    service = await startService(repository);

    const cleanups = [
      MakaioBus.on(
        ProviderStorageSubjects.get,
        (ctx) => {
          ctx.setResult({
            provider: {
              id: 'anthropic',
              packageName: '@makaio/provider-anthropic',
              name: 'Anthropic',
              endpoints: {
                anthropic: 'https://api.anthropic.com',
                openai: 'https://api.anthropic.com/v1/openai',
              },
              availableModels: [],
              authMethods: [
                {
                  ...apiKeyMethod,
                  fields: [
                    {
                      ...apiKeyMethod.fields[0]!,
                      sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_API_KEY' }],
                    },
                  ],
                },
                { id: 'none', mode: 'none', label: 'No authentication' },
              ],
              defaultModelFilterMode: 'show-all',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          });
        },
        { filter: { id: 'anthropic' } },
      ),
      MakaioBus.on(ProviderStorageSubjects.get, (ctx) => ctx.setResult({ provider: null }), {
        filter: { id: 'missing-provider' },
      }),
      MakaioBus.on(CapabilitySubjects.listProviders, (ctx) => {
        capabilityRequests += 1;
        ctx.setResult({
          providers: [{ id: 'log-import-provider', displayName: 'Log Import', providerKey: 'claude-code' }],
        });
      }),
    ];

    try {
      const { config: providerConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.work',
      });
      const { configs: providerConfigs } = await MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigs, {});
      const { configs: anthroConfigs } = await MakaioBus.request(
        AdapterSubsystemSubjects.listProviderConfigsByDefinition,
        { definitionId: 'anthropic' },
      );
      const { configs: adapterConfigs } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapterConfigs, {});
      const { bindings: bindingsByConfig } = await MakaioBus.request(AdapterSubsystemSubjects.listBindingsByConfig, {
        providerConfigId: 'anthropic.work',
      });
      const { binding: defaultBinding } = await MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, {
        adapterName: 'claude-code',
      });
      const { config: boundConfig } = await MakaioBus.request(
        AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter,
        { definitionId: 'anthropic', adapterName: 'claude-code' },
      );
      const { snapshot } = await MakaioBus.request(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, {
        providerConfigId: 'anthropic.work',
      });
      const { adapters: effectiveAdapters } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      const { adapters: repeatedEffectiveAdapters } = await MakaioBus.request(
        AdapterSubsystemSubjects.listAdapters,
        {},
      );

      expect(providerConfig).toMatchObject({
        id: 'anthropic.work',
        auth: { mode: 'explicit', hasCredentials: true },
      });
      expect(providerConfig).not.toHaveProperty('credentialRefs');
      expect(providerConfigs.map(({ id }) => id)).toEqual([
        'anthropic.work',
        'anthropic.personal',
        'openai.team',
        'ghost.team',
      ]);
      expect(anthroConfigs).toEqual([
        expect.objectContaining({ id: 'anthropic.work', isDefault: true }),
        expect.objectContaining({ id: 'anthropic.personal' }),
      ]);
      expect(adapterConfigs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'claude-code', bindings: expect.arrayContaining([expect.any(Object)]) }),
          expect.objectContaining({ name: 'copilot' }),
        ]),
      );
      expect(bindingsByConfig).toEqual([
        { adapterName: 'claude-code', providerConfigId: 'anthropic.work', isDefault: true },
      ]);
      expect(defaultBinding).toEqual({
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.work',
        isDefault: true,
      });
      expect(boundConfig).toMatchObject({ id: 'anthropic.work', enabled: true });
      expect(snapshot).toMatchObject({
        config: { id: 'anthropic.work', auth: { mode: 'explicit', hasCredentials: true } },
        context: {
          state: 'resolved',
          providerConfigId: 'anthropic.work',
          auth: {
            credentialRefs: { apiKey: buildStoredCredentialRef('anthropic.work', 'apiKey') },
          },
        },
      });
      expect(effectiveAdapters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'claude-code',
            configCount: 2,
            readiness: 'ready',
            supportsLogImport: true,
          }),
          expect.objectContaining({
            name: 'copilot',
            configCount: 1,
            readiness: 'needs-setup',
            supportsLogImport: false,
          }),
        ]),
      );
      expect(repeatedEffectiveAdapters).toEqual(effectiveAdapters);
      expect(capabilityRequests).toBe(1);
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, {
          providerConfigId: 'ghost.team',
        }),
      ).rejects.toThrow(/Provider definition not found/);
      expect(repository.providerLoads).toBe(1);
      expect(repository.adapterLoads).toBe(1);
      expect(repository.providerWrites).toBe(0);
      expect(repository.adapterWrites).toBe(0);
      expect(repository.providerDeletes).toBe(0);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('prefers the default provider config when resolving a definition and adapter pair', async () => {
    repository = new SnapshotRepository(
      new Map([
        ['anthropic.personal', noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true })],
        ['anthropic.work', noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true })],
      ]),
      new Map([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            bindings: [
              { providerConfigId: 'anthropic.personal' },
              { providerConfigId: 'anthropic.work', isDefault: true },
            ],
          },
        ],
      ]),
    );
    service = await startService(repository);

    const { config } = await MakaioBus.request(AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter, {
      definitionId: 'anthropic',
      adapterName: 'claude-code',
    });
    expect(config).toMatchObject({ id: 'anthropic.work', isDefault: true, enabled: true });
  });

  it('falls back to the first enabled binding when no adapter binding is marked default', async () => {
    repository = new SnapshotRepository(
      new Map([
        ['anthropic.disabled', noAuthConfig('anthropic', 'Anthropic Disabled', { enabled: false })],
        ['anthropic.enabled', noAuthConfig('anthropic', 'Anthropic Enabled', { enabled: true })],
      ]),
      new Map([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            bindings: [{ providerConfigId: 'anthropic.disabled' }, { providerConfigId: 'anthropic.enabled' }],
          },
        ],
      ]),
    );
    service = await startService(repository);

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, { adapterName: 'claude-code' }),
    ).resolves.toEqual({
      binding: { adapterName: 'claude-code', providerConfigId: 'anthropic.enabled', isDefault: false },
    });
  });

  it('ignores an explicit default binding when that provider config is disabled', async () => {
    repository = new SnapshotRepository(
      new Map([
        ['anthropic.disabled', noAuthConfig('anthropic', 'Anthropic Disabled', { enabled: false })],
        ['anthropic.enabled', noAuthConfig('anthropic', 'Anthropic Enabled', { enabled: true })],
      ]),
      new Map([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            bindings: [
              { providerConfigId: 'anthropic.disabled', isDefault: true },
              { providerConfigId: 'anthropic.enabled' },
            ],
          },
        ],
      ]),
    );
    service = await startService(repository);

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, { adapterName: 'claude-code' }),
    ).resolves.toEqual({
      binding: { adapterName: 'claude-code', providerConfigId: 'anthropic.enabled', isDefault: false },
    });
  });

  it('invalidates log-import capability cache when providers register or unregister', async () => {
    let capabilityProviders: Array<{ id: string; displayName: string; providerKey?: string }> = [];
    let capabilityRequests = 0;
    repository = new SnapshotRepository(
      new Map(),
      new Map([
        [
          'claude-code',
          { $schema: 'makaio/adapter-config/v1', enabled: true, displayName: 'Claude Code', bindings: [] },
        ],
      ]),
    );
    const offCapabilityProviders = MakaioBus.on(CapabilitySubjects.listProviders, (ctx) => {
      capabilityRequests += 1;
      ctx.setResult({ providers: capabilityProviders });
    });

    try {
      service = await startService(repository);
      const beforeRegister = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(beforeRegister.adapters[0]).toMatchObject({ supportsLogImport: false });

      capabilityProviders = [{ id: 'provider-1', displayName: 'Claude Import', providerKey: 'claude-code' }];
      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: capabilityProviders[0]!,
      });
      const afterRegister = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(afterRegister.adapters[0]).toMatchObject({ supportsLogImport: true });

      capabilityProviders = [];
      await MakaioBus.emit(CapabilitySubjects.unregister, {
        capabilityId: 'log-import',
        providerId: 'provider-1',
      });
      const afterUnregister = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(afterUnregister.adapters[0]).toMatchObject({ supportsLogImport: false });
      expect(capabilityRequests).toBe(3);
    } finally {
      offCapabilityProviders();
    }
  });

  it('does not cache an empty log-import provider set before the capability service registers', async () => {
    let capabilityRequests = 0;
    repository = new SnapshotRepository(
      new Map(),
      new Map([
        [
          'claude-code',
          { $schema: 'makaio/adapter-config/v1', enabled: true, displayName: 'Claude Code', bindings: [] },
        ],
      ]),
    );
    service = await startService(repository);
    const beforeCapabilityService = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
    expect(beforeCapabilityService.adapters[0]).toMatchObject({ supportsLogImport: false });

    const offCapabilityProviders = MakaioBus.on(CapabilitySubjects.listProviders, (ctx) => {
      capabilityRequests += 1;
      ctx.setResult({
        providers: [{ id: 'provider-1', displayName: 'Claude Import', providerKey: 'claude-code' }],
      });
    });
    try {
      const afterCapabilityService = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(afterCapabilityService.adapters[0]).toMatchObject({ supportsLogImport: true });
      expect(capabilityRequests).toBe(1);
    } finally {
      offCapabilityProviders();
    }
  });
});
