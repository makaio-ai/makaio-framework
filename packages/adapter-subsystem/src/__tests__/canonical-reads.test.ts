import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { buildAccountManagerCredentialRef } from '@makaio/contracts/config';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { FileAdapterConfigRepository } from '../config-repository.js';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { createStubCoordinator, TEST_MACHINE_ID, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

interface Harness {
  readonly rootDir: string;
  readonly makaioDir: string;
  readonly service: AdapterSubsystemService;
  readonly cleanup: () => Promise<void>;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function createHarness(): Promise<Harness> {
  const rootDir = path.join(os.tmpdir(), `adapter-subsystem-canonical-${crypto.randomUUID()}`);
  const makaioDir = path.join(rootDir, '.makaio');
  await fs.mkdir(makaioDir, { recursive: true });

  await writeJsonFile(path.join(makaioDir, 'provider-configs', 'anthropic.work.json'), {
    $schema: 'makaio/provider-config/v1',
    definitionId: 'anthropic',
    name: 'Anthropic Work',
    credentials: {
      apiKey: 'stored:providerConfig:anthropic.work:apiKey',
    },
    endpointOverrides: {
      anthropic: 'https://api.anthropic.com',
    },
    isDefault: true,
    enabled: true,
  });

  await writeJsonFile(path.join(makaioDir, 'provider-configs', 'openai.team.json'), {
    $schema: 'makaio/provider-config/v1',
    definitionId: 'openai',
    name: 'OpenAI Team',
    credentials: {
      apiKey: 'env:OPENAI_API_KEY',
    },
    enabled: true,
  });

  await writeJsonFile(path.join(makaioDir, 'provider-configs', 'anthropic.account.json'), {
    $schema: 'makaio/provider-config/v1',
    definitionId: 'anthropic',
    name: 'Anthropic Account',
    credentials: {
      token: buildAccountManagerCredentialRef('claude-code', 'account-123'),
    },
    enabled: true,
  });

  await writeJsonFile(path.join(makaioDir, 'provider-configs', 'ghost.team.json'), {
    $schema: 'makaio/provider-config/v1',
    definitionId: 'missing-provider',
    name: 'Ghost Team',
    enabled: true,
  });

  await writeJsonFile(path.join(makaioDir, 'adapters', 'claude-code.json'), {
    $schema: 'makaio/adapter-config/v1',
    enabled: true,
    displayName: 'Claude Code',
    settings: {
      maxConcurrency: 3,
    },
    bindings: [
      {
        providerConfigId: 'anthropic.work',
        isDefault: true,
      },
    ],
  });

  const service = new AdapterSubsystemService({
    bus: MakaioBus,
    configRepository: new FileAdapterConfigRepository({
      providerConfigsDir: path.join(makaioDir, 'provider-configs'),
      adaptersDir: path.join(makaioDir, 'adapters'),
    }),
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

  return {
    rootDir,
    makaioDir,
    service,
    cleanup: async () => {
      offAnthropicProvider();
      offOpenaiProvider();
      offMissingProvider();
      await service.destroy();
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

describe('AdapterSubsystemService canonical reads', () => {
  let harness: Harness;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await harness?.cleanup?.();
    MakaioBus.__resetHandlers?.();
  });

  it('loads the startup snapshot during init and keeps Tier 1 reads detached from later file edits', async () => {
    harness = await createHarness();

    await writeJsonFile(path.join(harness.makaioDir, 'provider-configs', 'anthropic.work.json'), {
      $schema: 'makaio/provider-config/v1',
      definitionId: 'anthropic',
      name: 'Tampered Name',
      credentials: {
        apiKey: 'plaintext-secret',
      },
      enabled: false,
    });

    await writeJsonFile(path.join(harness.makaioDir, 'adapters', 'claude-code.json'), {
      $schema: 'makaio/adapter-config/v1',
      enabled: false,
      displayName: 'Tampered Display Name',
      bindings: [],
    });

    const { config: providerConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
      id: 'anthropic.work',
    });
    const { configs: providerConfigs } = await MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigs, {});
    const { config: adapterConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getAdapterConfig, {
      name: 'claude-code',
    });
    const { configs: adapterConfigs } = await MakaioBus.request(AdapterSubsystemSubjects.listAdapterConfigs, {});
    const { context } = await MakaioBus.request(AdapterSubsystemSubjects.buildProviderContext, {
      providerConfigId: 'anthropic.work',
    });
    const { config: openAiConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
      id: 'openai.team',
    });
    const { context: openAiContext } = await MakaioBus.request(AdapterSubsystemSubjects.buildProviderContext, {
      providerConfigId: 'openai.team',
    });

    expect(providerConfig).toMatchObject({
      id: 'anthropic.work',
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      endpointOverrides: {
        anthropic: 'https://api.anthropic.com',
      },
      isDefault: true,
      enabled: true,
      hasCredentials: true,
    });
    expect(providerConfig).not.toHaveProperty('credentials');
    expect(providerConfig).not.toHaveProperty('credentialRefs');
    expect(providerConfig).not.toHaveProperty('sourceRef');
    expect(providerConfigs.find((config) => config.id === 'anthropic.work')).toMatchObject({
      id: 'anthropic.work',
      name: 'Anthropic Work',
      enabled: true,
      hasCredentials: true,
    });
    expect(adapterConfig).toMatchObject({
      name: 'claude-code',
      enabled: true,
      displayName: 'Claude Code',
      settings: {
        maxConcurrency: 3,
      },
      bindings: [
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
      ],
    });
    expect(adapterConfigs[0]).toMatchObject({
      name: 'claude-code',
      displayName: 'Claude Code',
      bindings: [
        {
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
      ],
    });
    expect(context).toEqual({
      providerConfigId: 'anthropic.work',
      definitionId: 'anthropic',
      endpointOverrides: {
        anthropic: 'https://api.anthropic.com',
        openai: 'https://api.anthropic.com/v1/openai',
      },
      credentialRefs: {
        apiKey: 'stored:providerConfig:anthropic.work:apiKey',
      },
      credentialEnvVars: {
        apiKey: 'ANTHROPIC_API_KEY',
      },
    });
    expect(context).not.toHaveProperty('credentials');
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
        apiKey: 'env:OPENAI_API_KEY',
      },
      credentialEnvVars: {
        apiKey: 'OPENAI_API_KEY',
      },
    });
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.buildProviderContext, {
        providerConfigId: 'ghost.team',
      }),
    ).rejects.toThrow(/ProviderDefinition 'missing-provider' not found/);
  });

  it('surfaces account-manager source refs in canonical provider-config reads', async () => {
    harness = await createHarness();

    const { config } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
      id: 'anthropic.account',
    });

    expect(config).toMatchObject({
      id: 'anthropic.account',
      definitionId: 'anthropic',
      name: 'Anthropic Account',
      hasCredentials: true,
      sourceRef: 'account-manager:["claude-code","account-123"]',
    });
  });
});
