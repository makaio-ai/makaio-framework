/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects } from '@makaio/contracts';
import {
  type CredentialRef,
  CredentialRefSchema,
  buildStoredCredentialRef,
  type AdapterFile,
  type ProviderConfigFile,
} from '@makaio/contracts/config';
import {
  type AdapterFileConfigSet,
  type IAdapterConfigRepository,
  type ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { createStubCoordinator, TEST_MACHINE_ID, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

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

  it('serves Tier 2 reads from in-memory state without reloading the repository', async () => {
    let capabilityRequests = 0;
    repository = new SnapshotRepository(
      new Map<string, ProviderConfigFile>([
        [
          'anthropic.work',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Work',
            credentials: {
              apiKey: buildStoredCredentialRef('anthropic.work', 'apiKey'),
            },
            endpointOverrides: {
              anthropic: 'https://api.anthropic.com',
            },
            isDefault: true,
            enabled: true,
          },
        ],
        [
          'anthropic.personal',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Personal',
            enabled: true,
          },
        ],
        [
          'openai.team',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'openai',
            name: 'OpenAI Team',
            credentials: {
              apiKey: CredentialRefSchema.parse('env:OPENAI_API_KEY'),
            },
            enabled: false,
          },
        ],
        [
          'ghost.team',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'missing-provider',
            name: 'Ghost Team',
            enabled: true,
          },
        ],
      ]),
      new Map<string, AdapterFile>([
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
            settings: {
              maxConcurrency: 3,
            },
            bindings: [
              {
                providerConfigId: 'anthropic.work',
                isDefault: true,
              },
              {
                providerConfigId: 'anthropic.personal',
              },
            ],
          },
        ],
        [
          'copilot',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: false,
            displayName: 'Copilot',
            description: 'GitHub Copilot adapter',
            helpLinks: [{ label: 'Docs', url: 'https://example.com/copilot' }],
            instructions: 'Use the Copilot CLI.',
            clientId: 'github-copilot-sdk',
            protocol: 'openai',
            providerDefinitionIds: ['openai'],
            bindings: [
              {
                providerConfigId: 'openai.team',
                isDefault: true,
              },
            ],
          },
        ],
      ]),
    );

    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const offAnthropicProvider = MakaioBus.on(
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
            defaultModelFilterMode: 'show-all',
            credentialEnvVars: {
              apiKey: 'ANTHROPIC_API_KEY',
            },
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        });
      },
      { filter: { id: 'anthropic' } },
    );
    const offOpenaiProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          provider: {
            id: 'openai',
            packageName: '@makaio/provider-openai',
            name: 'OpenAI',
            endpoints: {
              openai: 'https://api.openai.com/v1',
            },
            availableModels: [],
            defaultModelFilterMode: 'show-all',
            credentialEnvVars: {
              apiKey: 'OPENAI_API_KEY',
            },
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        });
      },
      { filter: { id: 'openai' } },
    );
    const offMissingProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({ provider: null });
      },
      { filter: { id: 'missing-provider' } },
    );

    const offCapabilityProviders = MakaioBus.on(CapabilitySubjects.listProviders, (ctx) => {
      capabilityRequests += 1;
      ctx.setResult({
        providers: [
          {
            id: 'log-import-provider',
            displayName: 'Log Import',
            providerKey: 'claude-code',
          },
        ],
      });
    });

    try {
      const { config: providerConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.work',
      });
      const { configs: providerConfigs } = await MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigs, {});
      const { configs: anthroConfigs } = await MakaioBus.request(
        AdapterSubsystemSubjects.listProviderConfigsByDefinition,
        {
          definitionId: 'anthropic',
        },
      );
      const { config: adapterConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getAdapterConfig, {
        name: 'claude-code',
      });
      const { configs: adapterConfigs } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapterConfigs, {});
      const { bindings: bindingsByAdapter } = await MakaioBus.request(AdapterSubsystemSubjects.listBindings, {
        adapterName: 'claude-code',
      });
      const { bindings: bindingsByConfig } = await MakaioBus.request(AdapterSubsystemSubjects.listBindingsByConfig, {
        providerConfigId: 'anthropic.work',
      });
      const { binding: defaultBinding } = await MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, {
        adapterName: 'claude-code',
      });
      const { config: boundConfig } = await MakaioBus.request(
        AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter,
        {
          definitionId: 'anthropic',
          adapterName: 'claude-code',
        },
      );
      const { context } = await MakaioBus.request(AdapterSubsystemSubjects.buildProviderContext, {
        providerConfigId: 'anthropic.work',
      });
      const { config: openAiConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'openai.team',
      });
      const { context: openAiContext } = await MakaioBus.request(AdapterSubsystemSubjects.buildProviderContext, {
        providerConfigId: 'openai.team',
      });
      const { adapters: effectiveAdapters } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      const { adapters: repeatedEffectiveAdapters } = await MakaioBus.request(
        AdapterSubsystemSubjects.listAdapters,
        {},
      );

      expect(providerConfig).toMatchObject({
        id: 'anthropic.work',
        definitionId: 'anthropic',
        name: 'Anthropic Work',
        hasCredentials: true,
      });
      expect(providerConfig).not.toHaveProperty('credentials');
      expect(providerConfig).not.toHaveProperty('credentialRefs');
      expect(providerConfigs).toEqual([
        expect.objectContaining({
          id: 'anthropic.work',
          name: 'Anthropic Work',
        }),
        expect.objectContaining({
          id: 'anthropic.personal',
          name: 'Anthropic Personal',
        }),
        expect.objectContaining({
          id: 'openai.team',
          name: 'OpenAI Team',
          enabled: false,
        }),
        expect.objectContaining({
          id: 'ghost.team',
          name: 'Ghost Team',
          enabled: true,
        }),
      ]);
      expect(anthroConfigs).toEqual([
        expect.objectContaining({
          id: 'anthropic.work',
          isDefault: true,
        }),
        expect.objectContaining({
          id: 'anthropic.personal',
        }),
      ]);
      expect(adapterConfig).toMatchObject({
        name: 'claude-code',
        displayName: 'Claude Code',
        description: 'Claude Code adapter',
        enabled: true,
        helpLinks: [{ label: 'Docs', url: 'https://example.com/claude' }],
        instructions: 'Use the Claude Code CLI.',
        clientId: 'claude-code-cli',
        protocol: 'anthropic',
        providerDefinitionIds: ['anthropic'],
        settings: {
          maxConcurrency: 3,
        },
        bindings: [
          {
            adapterName: 'claude-code',
            providerConfigId: 'anthropic.work',
            isDefault: true,
          },
          {
            adapterName: 'claude-code',
            providerConfigId: 'anthropic.personal',
            isDefault: false,
          },
        ],
      });
      expect(adapterConfigs).toEqual([
        expect.objectContaining({
          name: 'claude-code',
          bindings: [
            {
              adapterName: 'claude-code',
              providerConfigId: 'anthropic.work',
              isDefault: true,
            },
            {
              adapterName: 'claude-code',
              providerConfigId: 'anthropic.personal',
              isDefault: false,
            },
          ],
        }),
        expect.objectContaining({
          name: 'copilot',
          bindings: [
            {
              adapterName: 'copilot',
              providerConfigId: 'openai.team',
              isDefault: true,
            },
          ],
        }),
      ]);
      expect(bindingsByAdapter).toEqual([
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.personal',
          isDefault: false,
        },
      ]);
      expect(bindingsByConfig).toEqual([
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
      ]);
      expect(defaultBinding).toEqual({
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.work',
        isDefault: true,
      });
      expect(boundConfig).toMatchObject({
        id: 'anthropic.work',
        definitionId: 'anthropic',
        enabled: true,
      });
      expect(context).toEqual({
        providerConfigId: 'anthropic.work',
        definitionId: 'anthropic',
        endpointOverrides: {
          anthropic: 'https://api.anthropic.com',
          openai: 'https://api.anthropic.com/v1/openai',
        },
        credentialRefs: {
          apiKey: 'stored:providerConfig:anthropic.work:apiKey' as CredentialRef,
        },
        credentialEnvVars: {
          apiKey: 'ANTHROPIC_API_KEY',
        },
        ambientCredentialEnvVars: ['ANTHROPIC_API_KEY'],
      });
      expect(openAiConfig).toMatchObject({
        id: 'openai.team',
        definitionId: 'openai',
        name: 'OpenAI Team',
        hasCredentials: true,
      });
      expect(openAiConfig).not.toHaveProperty('credentials');
      expect(openAiConfig).not.toHaveProperty('credentialRefs');
      expect(openAiContext).toEqual({
        providerConfigId: 'openai.team',
        definitionId: 'openai',
        endpointOverrides: {
          openai: 'https://api.openai.com/v1',
        },
        credentialRefs: {
          apiKey: 'env:OPENAI_API_KEY' as CredentialRef,
        },
        credentialEnvVars: {
          apiKey: 'OPENAI_API_KEY',
        },
        ambientCredentialEnvVars: ['OPENAI_API_KEY'],
      });
      expect(effectiveAdapters).toEqual([
        expect.objectContaining({
          name: 'claude-code',
          displayName: 'Claude Code',
          description: 'Claude Code adapter',
          enabled: true,
          configCount: 2,
          readiness: 'ready',
          supportsLogImport: true,
          helpLinks: [{ label: 'Docs', url: 'https://example.com/claude' }],
          instructions: 'Use the Claude Code CLI.',
          clientId: 'claude-code-cli',
          protocol: 'anthropic',
          providerDefinitionIds: ['anthropic'],
        }),
        expect.objectContaining({
          name: 'copilot',
          displayName: 'Copilot',
          description: 'GitHub Copilot adapter',
          enabled: false,
          configCount: 1,
          readiness: 'needs-setup',
          supportsLogImport: false,
          helpLinks: [{ label: 'Docs', url: 'https://example.com/copilot' }],
          instructions: 'Use the Copilot CLI.',
          clientId: 'github-copilot-sdk',
          protocol: 'openai',
          providerDefinitionIds: ['openai'],
        }),
      ]);
      expect(repeatedEffectiveAdapters).toEqual(effectiveAdapters);
      expect(capabilityRequests).toBe(1);
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.buildProviderContext, {
          providerConfigId: 'ghost.team',
        }),
      ).rejects.toThrow(/ProviderDefinition 'missing-provider' not found/);
      expect(repository.providerLoads).toBe(1);
      expect(repository.adapterLoads).toBe(1);
      expect(repository.providerWrites).toBe(0);
      expect(repository.adapterWrites).toBe(0);
      expect(repository.providerDeletes).toBe(0);
    } finally {
      offAnthropicProvider();
      offOpenaiProvider();
      offMissingProvider();
      offCapabilityProviders();
    }
  });

  it('prefers the default provider config when resolving a definition and adapter pair', async () => {
    repository = new SnapshotRepository(
      new Map<string, ProviderConfigFile>([
        [
          'anthropic.personal',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Personal',
            enabled: true,
          },
        ],
        [
          'anthropic.work',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Work',
            isDefault: true,
            enabled: true,
          },
        ],
      ]),
      new Map<string, AdapterFile>([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            bindings: [
              {
                providerConfigId: 'anthropic.personal',
              },
              {
                providerConfigId: 'anthropic.work',
                isDefault: true,
              },
            ],
          },
        ],
      ]),
    );

    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const { config } = await MakaioBus.request(AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter, {
      definitionId: 'anthropic',
      adapterName: 'claude-code',
    });

    expect(config).toMatchObject({
      id: 'anthropic.work',
      isDefault: true,
      enabled: true,
    });
  });

  it('falls back to the first enabled binding when no adapter binding is marked default', async () => {
    repository = new SnapshotRepository(
      new Map<string, ProviderConfigFile>([
        [
          'anthropic.disabled',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Disabled',
            enabled: false,
          },
        ],
        [
          'anthropic.enabled',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Enabled',
            enabled: true,
          },
        ],
      ]),
      new Map<string, AdapterFile>([
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

    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const { binding } = await MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, {
      adapterName: 'claude-code',
    });

    expect(binding).toEqual({
      adapterName: 'claude-code',
      providerConfigId: 'anthropic.enabled',
      isDefault: false,
    });
  });

  it('ignores an explicit default binding when that provider config is disabled', async () => {
    repository = new SnapshotRepository(
      new Map<string, ProviderConfigFile>([
        [
          'anthropic.disabled',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Disabled',
            enabled: false,
          },
        ],
        [
          'anthropic.enabled',
          {
            $schema: 'makaio/provider-config/v1',
            definitionId: 'anthropic',
            name: 'Anthropic Enabled',
            enabled: true,
          },
        ],
      ]),
      new Map<string, AdapterFile>([
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

    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const { binding } = await MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, {
      adapterName: 'claude-code',
    });

    expect(binding).toEqual({
      adapterName: 'claude-code',
      providerConfigId: 'anthropic.enabled',
      isDefault: false,
    });
  });

  it('invalidates log-import capability cache when providers register or unregister', async () => {
    let capabilityProviders = [] as Array<{ id: string; displayName: string; providerKey?: string }>;
    let capabilityRequests = 0;
    repository = new SnapshotRepository(
      new Map<string, ProviderConfigFile>(),
      new Map<string, AdapterFile>([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            displayName: 'Claude Code',
            bindings: [],
          },
        ],
      ]),
    );

    const offCapabilityProviders = MakaioBus.on(CapabilitySubjects.listProviders, (ctx) => {
      capabilityRequests += 1;
      ctx.setResult({ providers: capabilityProviders });
    });

    try {
      service = new AdapterSubsystemService({
        bus: MakaioBus,
        configRepository: repository,
        coordinator: createStubCoordinator(),
        machineId: TEST_MACHINE_ID,
        platformDefaults: TEST_PLATFORM_DEFAULTS,
      });
      await service.init();

      const { adapters: beforeRegister } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(beforeRegister[0]).toMatchObject({ supportsLogImport: false });

      capabilityProviders = [{ id: 'provider-1', displayName: 'Claude Import', providerKey: 'claude-code' }];
      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'provider-1',
          displayName: 'Claude Import',
          providerKey: 'claude-code',
        },
      });

      const { adapters: afterRegister } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(afterRegister[0]).toMatchObject({ supportsLogImport: true });

      capabilityProviders = [];
      await MakaioBus.emit(CapabilitySubjects.unregister, {
        capabilityId: 'log-import',
        providerId: 'provider-1',
      });

      const { adapters: afterUnregister } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(afterUnregister[0]).toMatchObject({ supportsLogImport: false });
      expect(capabilityRequests).toBe(3);
    } finally {
      offCapabilityProviders();
    }
  });

  it('does not cache an empty log-import provider set before the capability service registers', async () => {
    let capabilityRequests = 0;
    repository = new SnapshotRepository(
      new Map<string, ProviderConfigFile>(),
      new Map<string, AdapterFile>([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            displayName: 'Claude Code',
            bindings: [],
          },
        ],
      ]),
    );

    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const { adapters: beforeCapabilityService } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
    expect(beforeCapabilityService[0]).toMatchObject({ supportsLogImport: false });

    const offCapabilityProviders = MakaioBus.on(CapabilitySubjects.listProviders, (ctx) => {
      capabilityRequests += 1;
      ctx.setResult({
        providers: [
          {
            id: 'provider-1',
            displayName: 'Claude Import',
            providerKey: 'claude-code',
          },
        ],
      });
    });

    try {
      const { adapters: afterCapabilityService } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapters, {});
      expect(afterCapabilityService[0]).toMatchObject({ supportsLogImport: true });
      expect(capabilityRequests).toBe(1);
    } finally {
      offCapabilityProviders();
    }
  });
});
