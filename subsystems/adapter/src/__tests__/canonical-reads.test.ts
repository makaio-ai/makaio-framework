import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  CredentialRefSchema,
  buildStoredCredentialRef,
  type CredentialRef,
  type ProviderConfigFile,
} from '@makaio/contracts/config';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ClientStorageSubjects, ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { FileAdapterConfigRepository } from '../config-repository.js';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { buildProviderRuntimeContextFromRaw } from '../provider-runtime-view.js';
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
const nativeMethod = { id: 'native', mode: 'inferred' as const, label: 'Native login' };

interface Harness {
  readonly rootDir: string;
  readonly makaioDir: string;
  readonly service: AdapterSubsystemService;
  readonly cleanup: () => Promise<void>;
}

/**
 * Write one test fixture as formatted JSON.
 * @param filePath - Destination path for the JSON fixture.
 * @param value - JSON-safe fixture value.
 */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Build one explicit v2 provider config.
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

/** Create the file-backed canonical read harness and real definition handlers. */
async function createHarness(): Promise<Harness> {
  const rootDir = path.join(os.tmpdir(), `adapter-subsystem-canonical-${crypto.randomUUID()}`);
  const makaioDir = path.join(rootDir, '.makaio');
  await fs.mkdir(makaioDir, { recursive: true });

  await writeJsonFile(
    path.join(makaioDir, 'provider-configs', 'anthropic.work.json'),
    explicitConfig('anthropic', 'Anthropic Work', buildStoredCredentialRef('anthropic.work', 'apiKey'), {
      endpointOverrides: { anthropic: 'https://api.anthropic.test' },
      isDefault: true,
      enabled: true,
    }),
  );
  await writeJsonFile(
    path.join(makaioDir, 'provider-configs', 'openai.team.json'),
    explicitConfig('openai', 'OpenAI Team', CredentialRefSchema.parse('env:OPENAI_API_KEY'), { enabled: true }),
  );
  await writeJsonFile(path.join(makaioDir, 'provider-configs', 'anthropic.account.json'), {
    $schema: 'makaio/provider-config/v2',
    definitionId: 'anthropic',
    name: 'Anthropic Account',
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
      account: { managerId: 'account-manager', accountId: 'account-123' },
    },
    enabled: true,
  } satisfies ProviderConfigFile);
  await writeJsonFile(path.join(makaioDir, 'provider-configs', 'ghost.team.json'), {
    $schema: 'makaio/provider-config/v2',
    definitionId: 'missing-provider',
    name: 'Ghost Team',
    auth: {
      mode: 'none',
      method: { owner: 'provider', providerDefinitionId: 'missing-provider', methodId: 'none' },
    },
    enabled: true,
  } satisfies ProviderConfigFile);
  await writeJsonFile(path.join(makaioDir, 'adapters', 'claude-code.json'), {
    $schema: 'makaio/adapter-config/v1',
    enabled: true,
    displayName: 'Claude Code',
    settings: { maxConcurrency: 3 },
    bindings: [{ providerConfigId: 'anthropic.work', isDefault: true }],
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

  const anthropicProvider = {
    id: 'anthropic',
    packageName: '@makaio/provider-anthropic',
    name: 'Anthropic',
    endpoints: { anthropic: 'https://api.anthropic.com', openai: 'https://api.anthropic.com/v1/openai' },
    availableModels: [],
    authMethods: [
      {
        ...apiKeyMethod,
        fields: [
          {
            ...apiKeyMethod.fields[0]!,
            sourceHints: [{ kind: 'environment' as const, variable: 'ANTHROPIC_API_KEY' }],
          },
        ],
      },
    ],
    defaultModelFilterMode: 'show-all' as const,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const openaiProvider = {
    id: 'openai',
    packageName: '@makaio/provider-openai',
    name: 'OpenAI',
    endpoints: { openai: 'https://api.openai.com/v1' },
    availableModels: [],
    authMethods: [
      {
        ...apiKeyMethod,
        fields: [
          {
            ...apiKeyMethod.fields[0]!,
            sourceHints: [{ kind: 'environment' as const, variable: 'OPENAI_API_KEY' }],
          },
        ],
      },
    ],
    defaultModelFilterMode: 'show-all' as const,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  const cleanups = [
    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => ctx.setResult({ provider: anthropicProvider }), {
      filter: { id: 'anthropic' },
    }),
    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => ctx.setResult({ provider: openaiProvider }), {
      filter: { id: 'openai' },
    }),
    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => ctx.setResult({ provider: null }), {
      filter: { id: 'missing-provider' },
    }),
    MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
      ctx.setResult({
        client:
          ctx.payload.id === 'claude-code'
            ? {
                id: 'claude-code',
                packageName: '@makaio/client-claude-code',
                name: 'Claude Code',
                nativeTools: [],
                defaultApprovalPolicy: 'always-ask',
                authMethods: [nativeMethod],
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
              }
            : null,
      });
    }),
  ];

  return {
    rootDir,
    makaioDir,
    service,
    cleanup: async () => {
      cleanups.forEach((cleanup) => cleanup());
      await service.destroy();
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

/**
 * Resolve one atomic runtime snapshot or fail the test when it is absent.
 * @param providerConfigId - Config whose atomic runtime snapshot is required.
 */
async function resolveRuntime(providerConfigId: string) {
  const { snapshot } = await MakaioBus.request(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, {
    providerConfigId,
  });
  if (snapshot === null) {
    throw new Error(`Expected runtime snapshot for ${providerConfigId}`);
  }
  return snapshot;
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

  it('keeps safe reads and runtime snapshots detached from later file edits', async () => {
    harness = await createHarness();
    await writeJsonFile(path.join(harness.makaioDir, 'provider-configs', 'anthropic.work.json'), {
      ...explicitConfig('anthropic', 'Tampered Name', CredentialRefSchema.parse('env:TAMPERED_KEY')),
      enabled: false,
    });

    const { config } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
      id: 'anthropic.work',
    });
    const snapshot = await resolveRuntime('anthropic.work');
    const openai = await resolveRuntime('openai.team');

    expect(config).toMatchObject({
      id: 'anthropic.work',
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      isDefault: true,
      enabled: true,
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        hasCredentials: true,
      },
    });
    expect(config).not.toHaveProperty('credentialRefs');
    expect(snapshot.config).toEqual(config);
    expect(snapshot.context).toMatchObject({
      state: 'resolved',
      providerConfigId: 'anthropic.work',
      definitionId: 'anthropic',
      endpointOverrides: {
        anthropic: 'https://api.anthropic.test',
        openai: 'https://api.anthropic.com/v1/openai',
      },
      auth: {
        mode: 'explicit',
        credentialRefs: { apiKey: buildStoredCredentialRef('anthropic.work', 'apiKey') },
      },
    });
    expect(openai.context).toMatchObject({
      state: 'resolved',
      providerConfigId: 'openai.team',
      auth: {
        mode: 'explicit',
        credentialRefs: { apiKey: 'env:OPENAI_API_KEY' },
      },
    });
    await expect(resolveRuntime('ghost.team')).rejects.toThrow(/Provider definition not found/);
  });

  it('surfaces managed account selection only through the safe auth summary', async () => {
    harness = await createHarness();

    const { config } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
      id: 'anthropic.account',
    });

    expect(config).toMatchObject({
      id: 'anthropic.account',
      definitionId: 'anthropic',
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        account: { managerId: 'account-manager', accountId: 'account-123' },
        hasCredentials: false,
      },
    });
    expect(config).not.toHaveProperty('sourceRef');
    expect(config).not.toHaveProperty('credentialRefs');
  });

  it('builds from the selected definition without provider-list discovery', async () => {
    const offGetProvider = MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({
        provider: {
          id: 'anthropic',
          packageName: '@makaio/provider-anthropic',
          name: 'Anthropic',
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
          ],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    });
    const offListProviders = MakaioBus.on(ProviderStorageSubjects.list, () => {
      throw new Error('provider list must not be queried');
    });

    try {
      await expect(
        buildProviderRuntimeContextFromRaw(
          MakaioBus,
          'anthropic.work',
          explicitConfig('anthropic', 'Anthropic Work', CredentialRefSchema.parse('env:ANTHROPIC_API_KEY')),
        ),
      ).resolves.toMatchObject({
        context: {
          definitionId: 'anthropic',
          auth: { mode: 'explicit' },
        },
      });
    } finally {
      offGetProvider();
      offListProviders();
    }
  });
});
