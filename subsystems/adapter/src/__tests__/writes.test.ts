import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CredentialSubjects } from '@makaio/contracts';
import {
  buildStoredCredentialRef,
  type AdapterFile,
  type CredentialRef,
  type ProviderConfigFile,
} from '@makaio/contracts/config';
import { AdapterSubsystemNamespace, AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { FileAdapterConfigRepository } from '../config-repository.js';
import { rollbackSnapshotPersistenceOperation } from '../adapter-config-snapshot-persistence.js';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { createStubCoordinator, TEST_MACHINE_ID, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

interface Harness {
  readonly rootDir: string;
  readonly makaioDir: string;
  readonly service: AdapterSubsystemService;
  readonly cleanup: () => Promise<void>;
}

class TrackingRepository {
  public readonly providerWriteIds: string[] = [];

  public constructor(
    public readonly providerConfigs: Map<string, ProviderConfigFile>,
    private readonly adapters: Map<string, AdapterFile>,
  ) {}

  public async loadAdapterConfigs() {
    return { configs: new Map([...this.adapters.entries()].map(([name, config]) => [name, structuredClone(config)])) };
  }

  public async loadProviderConfigs() {
    return {
      configs: new Map([...this.providerConfigs.entries()].map(([id, config]) => [id, structuredClone(config)])),
    };
  }

  public async writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void> {
    this.providerWriteIds.push(id);
    this.providerConfigs.set(id, structuredClone(config));
  }

  public async deleteProviderConfig(id: string): Promise<boolean> {
    return this.providerConfigs.delete(id);
  }

  public async writeAdapterFile(name: string, config: AdapterFile): Promise<void> {
    this.adapters.set(name, structuredClone(config));
  }

  public async deleteAdapterFile(name: string): Promise<boolean> {
    return this.adapters.delete(name);
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((deferredResolve) => {
    resolve = deferredResolve;
  });
  return {
    promise,
    resolve: () => {
      resolve?.();
    },
  };
}

class GatedTrackingRepository extends TrackingRepository {
  private readonly releaseFirstWrite = createDeferred();
  private readonly firstWriteStarted = createDeferred();
  private gateConsumed = false;

  public async waitForFirstWrite(): Promise<void> {
    await this.firstWriteStarted.promise;
  }

  public unblockFirstWrite(): void {
    this.releaseFirstWrite.resolve();
  }

  public override async writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void> {
    if (!this.gateConsumed && id === 'anthropic.work') {
      this.gateConsumed = true;
      this.firstWriteStarted.resolve();
      await this.releaseFirstWrite.promise;
    }
    await super.writeProviderConfig(id, config);
  }
}

type FailureMode = 'before-write' | 'after-write';

class FailingTrackingRepository extends TrackingRepository {
  public constructor(
    providerConfigs: Map<string, ProviderConfigFile>,
    adapters: Map<string, AdapterFile>,
    private readonly providerWriteFailures: Map<string, FailureMode> = new Map(),
    private readonly adapterWriteFailures: Map<string, FailureMode> = new Map(),
    private readonly providerDeleteFailures: Set<string> = new Set(),
  ) {
    super(providerConfigs, adapters);
  }

  public override async writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void> {
    const failureMode = this.providerWriteFailures.get(id);
    if (failureMode === 'before-write') {
      this.providerWriteFailures.delete(id);
      throw new Error(`Injected provider config write failure: ${id}`);
    }

    await super.writeProviderConfig(id, config);

    if (failureMode === 'after-write') {
      this.providerWriteFailures.delete(id);
      throw new Error(`Injected provider config write failure: ${id}`);
    }
  }

  public override async writeAdapterFile(name: string, config: AdapterFile): Promise<void> {
    const failureMode = this.adapterWriteFailures.get(name);
    if (failureMode === 'before-write') {
      this.adapterWriteFailures.delete(name);
      throw new Error(`Injected adapter write failure: ${name}`);
    }

    await super.writeAdapterFile(name, config);

    if (failureMode === 'after-write') {
      this.adapterWriteFailures.delete(name);
      throw new Error(`Injected adapter write failure: ${name}`);
    }
  }

  public override async deleteProviderConfig(id: string): Promise<boolean> {
    if (this.providerDeleteFailures.has(id)) {
      throw new Error(`Injected provider config delete failure: ${id}`);
    }

    return await super.deleteProviderConfig(id);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
}

const noAuthMethod = { id: 'none', mode: 'none' as const, label: 'No authentication' };
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
      sourceHints: [{ kind: 'environment' as const, variable: 'ANTHROPIC_API_KEY' }],
    },
  ],
};

/**
 * Build a no-auth v2 fixture while retaining lifecycle/default overrides.
 * @param definitionId - Provider definition selected by the config.
 * @param name - Human-readable config name.
 * @param options - Optional lifecycle/default overrides.
 */
function noAuthConfig(
  definitionId: string,
  name: string,
  options: Omit<Partial<ProviderConfigFile>, '$schema' | 'definitionId' | 'name' | 'auth'> = {},
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
 * Build an explicit API-key v2 fixture while retaining lifecycle/default overrides.
 * @param definitionId - Provider definition selected by the config.
 * @param name - Human-readable config name.
 * @param credentialRef - Credential source reference stored by the config.
 * @param options - Optional lifecycle/default overrides.
 */
function explicitConfig(
  definitionId: string,
  name: string,
  credentialRef: CredentialRef,
  options: Omit<Partial<ProviderConfigFile>, '$schema' | 'definitionId' | 'name' | 'auth'> = {},
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

async function createHarness(
  seed: {
    readonly providerConfigs?: Record<string, ProviderConfigFile>;
    readonly adapters?: Record<string, AdapterFile>;
  } = {},
): Promise<Harness> {
  const rootDir = path.join(os.tmpdir(), `adapter-subsystem-writes-${crypto.randomUUID()}`);
  const makaioDir = path.join(rootDir, '.makaio');
  await fs.mkdir(makaioDir, { recursive: true });

  for (const [id, config] of Object.entries(seed.providerConfigs ?? {})) {
    await writeJsonFile(path.join(makaioDir, 'provider-configs', `${id}.json`), config);
  }
  for (const [name, config] of Object.entries(seed.adapters ?? {})) {
    await writeJsonFile(path.join(makaioDir, 'adapters', `${name}.json`), config);
  }

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

  return {
    rootDir,
    makaioDir,
    service,
    cleanup: async () => {
      await service.destroy();
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

describe('AdapterSubsystemService writes', () => {
  let harness: Harness;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.registerNamespace(AdapterSubsystemNamespace);
  });

  afterEach(async () => {
    await harness?.cleanup?.();
    MakaioBus.__resetHandlers?.();
  });

  it('creates and updates provider configs file-canonically while enforcing slug uniqueness', async () => {
    harness = await createHarness();

    const createdEvents: Array<Record<string, unknown>> = [];
    const updatedEvents: Array<Record<string, unknown>> = [];
    const offCreated = MakaioBus.on(AdapterSubsystemSubjects.providerConfig.created, (ctx) => {
      createdEvents.push(ctx.payload);
    });
    const offUpdated = MakaioBus.on(AdapterSubsystemSubjects.providerConfig.updated, (ctx) => {
      updatedEvents.push(ctx.payload);
    });
    const offAnthropicProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          provider: {
            id: 'anthropic',
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            defaultModelFilterMode: 'show-all',
            availableModels: [],
            authMethods: [apiKeyMethod, noAuthMethod],
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
      },
      { filter: { id: 'anthropic' } },
    );

    try {
      const created = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
        definitionId: 'anthropic',
        name: 'Anthropic Work',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic-work:apiKey' },
        },
        endpointOverrides: {
          anthropic: 'https://api.anthropic.com',
        },
      });

      const createdPath = path.join(harness.makaioDir, 'provider-configs', `${created.config.id}.json`);
      expect(created.config.id).toBe('anthropic-work');
      expect(await readJsonFile(createdPath)).toEqual({
        $schema: 'makaio/provider-config/v2',
        definitionId: 'anthropic',
        name: 'Anthropic Work',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic-work:apiKey' },
        },
        endpointOverrides: {
          anthropic: 'https://api.anthropic.com',
        },
        modelFilterMode: 'show-all',
        isDefault: true,
        enabled: true,
      });
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]).toMatchObject({
        id: created.config.id,
        definitionId: 'anthropic',
        name: 'Anthropic Work',
        auth: { mode: 'explicit', hasCredentials: true },
      });
      expect(createdEvents[0]).not.toHaveProperty('credentials');
      expect(createdEvents[0]).not.toHaveProperty('credentialRefs');

      const offProvider = MakaioBus.on(
        ProviderStorageSubjects.get,
        (ctx) => {
          ctx.setResult({
            provider: {
              id: 'openai',
              packageName: '@makaio/provider-openai',
              name: '  OpenAI / GPT  ',
              defaultModelFilterMode: 'show-all',
              availableModels: [],
              authMethods: [noAuthMethod],
              enabled: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          });
        },
        { filter: { id: 'openai' } },
      );

      try {
        const fallbackCreated = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
          definitionId: 'openai',
          auth: {
            mode: 'none',
            method: { owner: 'provider', providerDefinitionId: 'openai', methodId: 'none' },
          },
        });
        expect(fallbackCreated.config.id).toBe('openai');
        expect(fallbackCreated.config.name).toBe('openai');
        expect(fallbackCreated.config).not.toHaveProperty('credentials');
        expect(fallbackCreated.config).not.toHaveProperty('credentialRefs');
      } finally {
        offProvider();
      }

      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
          definitionId: 'anthropic',
          name: 'anthropic  work',
          auth: {
            mode: 'none',
            method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
          },
        }),
      ).rejects.toThrow(/conflicts with existing config/);

      await MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
        id: created.config.id,
        patch: {
          endpointOverrides: null,
          enabled: false,
        },
      });

      const { config: updated } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: created.config.id,
      });

      expect(updated).toMatchObject({
        id: created.config.id,
        definitionId: 'anthropic',
        name: 'Anthropic Work',
        enabled: false,
      });
      expect(updated).not.toHaveProperty('credentials');
      expect(updated).not.toHaveProperty('credentialRefs');
      expect(updated).not.toHaveProperty('endpointOverrides');
      expect(updatedEvents).toHaveLength(1);
      expect(updatedEvents[0]).toMatchObject({
        id: created.config.id,
        definitionId: 'anthropic',
        enabled: false,
      });
      expect(updatedEvents[0]).not.toHaveProperty('credentials');
      expect(updatedEvents[0]).not.toHaveProperty('credentialRefs');
    } finally {
      offCreated();
      offUpdated();
      offAnthropicProvider();
    }
  });

  it('removes newly created adapter files when adapter snapshot rollback unwinds a failed commit', async () => {
    const adapters = new Map<string, AdapterFile>([
      [
        'fresh-adapter',
        {
          $schema: 'makaio/adapter-config/v1',
          enabled: true,
        },
      ],
    ]);
    const repository = new TrackingRepository(new Map(), adapters);

    await rollbackSnapshotPersistenceOperation(repository, {
      kind: 'write-adapter',
      key: 'adapter:fresh-adapter',
      name: 'fresh-adapter',
      next: {
        $schema: 'makaio/adapter-config/v1',
        enabled: true,
      },
    });

    expect(adapters.has('fresh-adapter')).toBe(false);
  });

  it('clones provider patch payload objects before storing them in the snapshot', async () => {
    harness = await createHarness();

    const offProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          provider: {
            id: 'anthropic',
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            defaultModelFilterMode: 'show-all',
            availableModels: [],
            authMethods: [noAuthMethod],
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
      },
      { filter: { id: 'anthropic' } },
    );

    try {
      const endpointOverrides = { anthropic: 'https://initial.example.com' };
      const modelVisibility: Record<string, 'visible' | 'disabled'> = { sonnet: 'visible' };
      const created = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
        definitionId: 'anthropic',
        name: 'Anthropic Mutable',
        auth: {
          mode: 'none',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
        },
        endpointOverrides,
        modelVisibility,
      });

      endpointOverrides.anthropic = 'https://mutated.example.com';
      modelVisibility.sonnet = 'disabled';

      const { config } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, { id: created.config.id });
      expect(config).toMatchObject({
        endpointOverrides: { anthropic: 'https://initial.example.com' },
        modelVisibility: { sonnet: 'visible' },
      });

      const updateEndpointOverrides = { anthropic: 'https://updated.example.com' };
      const updateModelVisibility: Record<string, 'visible' | 'disabled'> = { sonnet: 'disabled' };
      await MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
        id: created.config.id,
        patch: {
          endpointOverrides: updateEndpointOverrides,
          modelVisibility: updateModelVisibility,
        },
      });

      updateEndpointOverrides.anthropic = 'https://mutated-again.example.com';
      updateModelVisibility.sonnet = 'visible';

      const { config: updated } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: created.config.id,
      });
      expect(updated).toMatchObject({
        endpointOverrides: { anthropic: 'https://updated.example.com' },
        modelVisibility: { sonnet: 'disabled' },
      });
    } finally {
      offProvider();
    }
  });

  it('rejects create when the provider definition is missing even if the caller supplies a name', async () => {
    harness = await createHarness();

    const offMissingProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({ provider: null });
      },
      { filter: { id: 'missing-provider' } },
    );

    try {
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
          definitionId: 'missing-provider',
          name: 'Missing Provider',
          auth: {
            mode: 'none',
            method: { owner: 'provider', providerDefinitionId: 'missing-provider', methodId: 'none' },
          },
        }),
      ).rejects.toThrow('Provider definition not found: missing-provider');
    } finally {
      offMissingProvider();
    }
  });

  it('rejects plaintext credentials on create and keeps credential vault ownership outside the subsystem', async () => {
    harness = await createHarness();

    const credentialBusCalls = {
      activate: 0,
      changed: 0,
      delete: 0,
      exists: 0,
      getChannelToken: 0,
    };
    const offAnthropicProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          provider: {
            id: 'anthropic',
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            defaultModelFilterMode: 'show-all',
            availableModels: [],
            authMethods: [apiKeyMethod],
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
      },
      { filter: { id: 'anthropic' } },
    );
    const offCredentialActivate = MakaioBus.on(CredentialSubjects.activate, (ctx) => {
      credentialBusCalls.activate += 1;
      ctx.setResult({ success: true });
    });
    const offCredentialChanged = MakaioBus.on(CredentialSubjects.changed, (ctx) => {
      credentialBusCalls.changed += 1;
      ctx.setResult({});
    });
    const offCredentialDelete = MakaioBus.on(CredentialSubjects.delete, (ctx) => {
      credentialBusCalls.delete += 1;
      ctx.setResult({ deleted: false });
    });
    const offCredentialExists = MakaioBus.on(CredentialSubjects.exists, (ctx) => {
      credentialBusCalls.exists += 1;
      ctx.setResult({ exists: false });
    });
    const offCredentialToken = MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
      credentialBusCalls.getChannelToken += 1;
      ctx.setResult({ token: 'unexpected-token' });
    });

    try {
      const plaintextPayload = JSON.parse(
        JSON.stringify({
          definitionId: 'anthropic',
          name: 'Anthropic Secret',
          credentials: {
            apiKey: 'sk-ant-plaintext',
          },
        }),
      );

      await expect(MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, plaintextPayload)).rejects.toThrow(
        /Validation failed|auth|credentials/,
      );

      const created = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
        definitionId: 'anthropic',
        name: 'Anthropic Secret',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: buildStoredCredentialRef('anthropic-secret', 'apiKey') },
        },
      });

      const createdPath = path.join(harness.makaioDir, 'provider-configs', `${created.config.id}.json`);
      expect(await readJsonFile<ProviderConfigFile>(createdPath)).toEqual({
        $schema: 'makaio/provider-config/v2',
        definitionId: 'anthropic',
        name: 'Anthropic Secret',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic-secret:apiKey' },
        },
        modelFilterMode: 'show-all',
        isDefault: true,
        enabled: true,
      });
      expect(credentialBusCalls).toEqual({
        activate: 0,
        changed: 0,
        delete: 0,
        exists: 0,
        getChannelToken: 0,
      });

      const { config } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: created.config.id,
      });
      expect(config).toMatchObject({
        id: created.config.id,
        definitionId: 'anthropic',
        auth: { mode: 'explicit', hasCredentials: true },
      });
      expect(config).not.toHaveProperty('credentialRefs');

      const { snapshot } = await MakaioBus.request(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, {
        providerConfigId: created.config.id,
      });
      expect(snapshot?.context).toMatchObject({
        state: 'resolved',
        providerConfigId: created.config.id,
        definitionId: 'anthropic',
        auth: {
          mode: 'explicit',
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic-secret:apiKey' },
        },
      });
    } finally {
      offCredentialActivate();
      offCredentialChanged();
      offCredentialDelete();
      offCredentialExists();
      offCredentialToken();
      offAnthropicProvider();
    }
  });

  it('replaces provider-config auth through the dedicated canonical write seam', async () => {
    harness = await createHarness({
      providerConfigs: {
        'anthropic.work': noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true }),
      },
    });

    const updatedEvents: Array<Record<string, unknown>> = [];
    const offUpdated = MakaioBus.on(AdapterSubsystemSubjects.providerConfig.updated, (ctx) => {
      updatedEvents.push(ctx.payload);
    });
    const offAnthropicProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          provider: {
            id: 'anthropic',
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            defaultModelFilterMode: 'show-all',
            availableModels: [],
            authMethods: [apiKeyMethod, noAuthMethod],
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
      },
      { filter: { id: 'anthropic' } },
    );

    try {
      const result = await MakaioBus.request(AdapterSubsystemSubjects.setProviderConfigAuth, {
        id: 'anthropic.work',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: buildStoredCredentialRef('anthropic.work', 'apiKey') },
        },
      });

      expect(result.config).toMatchObject({
        id: 'anthropic.work',
        auth: { mode: 'explicit', hasCredentials: true },
      });
      expect(result.config).not.toHaveProperty('credentialRefs');

      expect(
        await readJsonFile<ProviderConfigFile>(path.join(harness.makaioDir, 'provider-configs', 'anthropic.work.json')),
      ).toEqual({
        $schema: 'makaio/provider-config/v2',
        definitionId: 'anthropic',
        name: 'Anthropic Work',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic.work:apiKey' },
        },
        isDefault: true,
        enabled: true,
      });

      const { snapshot } = await MakaioBus.request(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, {
        providerConfigId: 'anthropic.work',
      });
      expect(snapshot?.context).toMatchObject({
        state: 'resolved',
        providerConfigId: 'anthropic.work',
        definitionId: 'anthropic',
        auth: {
          mode: 'explicit',
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic.work:apiKey' },
        },
      });

      expect(updatedEvents).toEqual([
        expect.objectContaining({
          id: 'anthropic.work',
          auth: expect.objectContaining({ mode: 'explicit', hasCredentials: true }),
        }),
      ]);
      expect(updatedEvents[0]).not.toHaveProperty('credentialRefs');
    } finally {
      offUpdated();
      offAnthropicProvider();
    }
  });

  it('promotes sibling defaults on delete and soft-deletes managed configs', async () => {
    harness = await createHarness({
      providerConfigs: {
        'anthropic.work': noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true }),
        'anthropic.personal': noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true }),
        'anthropic.zz-managed': noAuthConfig('anthropic', 'Anthropic Managed', {
          enabled: true,
          managedBy: { kind: 'client', clientId: 'claude-code' },
        }),
      },
    });

    const deletedEvents: Array<Record<string, unknown>> = [];
    const defaultChangedEvents: Array<Record<string, unknown>> = [];
    const updatedEvents: Array<Record<string, unknown>> = [];
    const offDeleted = MakaioBus.on(AdapterSubsystemSubjects.providerConfig.deleted, (ctx) => {
      deletedEvents.push(ctx.payload);
    });
    const offDefaultChanged = MakaioBus.on(AdapterSubsystemSubjects.providerConfig.defaultChanged, (ctx) => {
      defaultChangedEvents.push(ctx.payload);
    });
    const offUpdated = MakaioBus.on(AdapterSubsystemSubjects.providerConfig.updated, (ctx) => {
      updatedEvents.push(ctx.payload);
    });

    try {
      const deleted = await MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, {
        id: 'anthropic.work',
      });
      expect(deleted.deleted).toBe(true);

      const promoted = await MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigsByDefinition, {
        definitionId: 'anthropic',
      });
      expect(promoted.configs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'anthropic.personal',
            isDefault: true,
          }),
          expect.objectContaining({
            id: 'anthropic.zz-managed',
            managedBy: { kind: 'client', clientId: 'claude-code' },
          }),
        ]),
      );

      await expect(
        fs.access(path.join(harness.makaioDir, 'provider-configs', 'anthropic.work.json')),
      ).rejects.toThrow();
      expect(
        await readJsonFile<ProviderConfigFile>(
          path.join(harness.makaioDir, 'provider-configs', 'anthropic.personal.json'),
        ),
      ).toMatchObject({
        isDefault: true,
      });
      expect(deletedEvents).toEqual([{ id: 'anthropic.work' }]);
      expect(defaultChangedEvents).toEqual([
        {
          definitionId: 'anthropic',
          configId: 'anthropic.personal',
        },
      ]);

      const softDelete = await MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, {
        id: 'anthropic.zz-managed',
      });
      expect(softDelete.deleted).toBe(false);
      expect(updatedEvents).toHaveLength(1);
      expect(updatedEvents[0]).toMatchObject({
        id: 'anthropic.zz-managed',
        enabled: false,
        managedBy: { kind: 'client', clientId: 'claude-code' },
      });

      const managed = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.zz-managed',
      });
      expect(managed.config).toMatchObject({
        id: 'anthropic.zz-managed',
        enabled: false,
        managedBy: { kind: 'client', clientId: 'claude-code' },
      });
      expect(
        await readJsonFile<ProviderConfigFile>(
          path.join(harness.makaioDir, 'provider-configs', 'anthropic.zz-managed.json'),
        ),
      ).toMatchObject({
        enabled: false,
        managedBy: { kind: 'client', clientId: 'claude-code' },
      });
    } finally {
      offDeleted();
      offDefaultChanged();
      offUpdated();
    }
  });

  it('promotes only enabled provider configs as definition defaults', async () => {
    harness = await createHarness({
      providerConfigs: {
        'anthropic.work': noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true }),
        'anthropic.disabled': noAuthConfig('anthropic', 'Anthropic Disabled', { enabled: false }),
        'anthropic.team': noAuthConfig('anthropic', 'Anthropic Team', { enabled: true }),
      },
    });

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.setDefaultProviderConfig, {
        id: 'anthropic.disabled',
      }),
    ).rejects.toThrow('Disabled provider config cannot be default: anthropic.disabled');

    await MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, {
      id: 'anthropic.work',
    });

    const { configs } = await MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigsByDefinition, {
      definitionId: 'anthropic',
    });
    expect(configs).toEqual([
      expect.objectContaining({ id: 'anthropic.disabled', isDefault: false, enabled: false }),
      expect.objectContaining({ id: 'anthropic.team', isDefault: true, enabled: true }),
    ]);
  });

  it('performs best-effort credential cleanup after deleting a canonical provider config', async () => {
    harness = await createHarness({
      providerConfigs: {
        'anthropic.work': explicitConfig(
          'anthropic',
          'Anthropic Work',
          buildStoredCredentialRef('anthropic.work', 'apiKey'),
          { isDefault: true, enabled: true },
        ),
      },
    });

    const deleteCalls: string[] = [];
    const offCredentialDelete = MakaioBus.on(CredentialSubjects.delete, (ctx) => {
      deleteCalls.push(ctx.payload.configId);
      throw new Error('credential vault unavailable');
    });

    try {
      const deleted = await MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, {
        id: 'anthropic.work',
      });

      expect(deleted).toEqual({ deleted: true });
      expect(deleteCalls).toEqual(['anthropic.work']);
      await expect(
        fs.access(path.join(harness.makaioDir, 'provider-configs', 'anthropic.work.json')),
      ).rejects.toThrow();
      const { config } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.work',
      });
      expect(config).toBeNull();
    } finally {
      offCredentialDelete();
    }
  });

  it('persists only the affected provider definition slice when defaults change', async () => {
    const repository = new TrackingRepository(
      new Map<string, ProviderConfigFile>([
        ['anthropic.work', noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true })],
        ['anthropic.personal', noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true })],
        ['openai.team', noAuthConfig('openai', 'OpenAI Team', { isDefault: true, enabled: true })],
      ]),
      new Map<string, AdapterFile>(),
    );

    const localService = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await localService.init();

    try {
      await MakaioBus.request(AdapterSubsystemSubjects.setDefaultProviderConfig, {
        id: 'anthropic.personal',
      });

      expect(repository.providerWriteIds).toEqual(['anthropic.work', 'anthropic.personal']);
      expect(repository.providerConfigs.get('openai.team')).toMatchObject({
        isDefault: true,
      });
    } finally {
      await localService.destroy();
    }
  });

  it('serializes concurrent provider config snapshot mutations without losing either patch', async () => {
    const repository = new GatedTrackingRepository(
      new Map<string, ProviderConfigFile>([
        ['anthropic.work', noAuthConfig('anthropic', 'Anthropic Work', { enabled: true })],
      ]),
      new Map<string, AdapterFile>(),
    );
    const localService = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await localService.init();

    const offAnthropicProvider = MakaioBus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          provider: {
            id: 'anthropic',
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            defaultModelFilterMode: 'show-all',
            availableModels: [],
            authMethods: [apiKeyMethod, noAuthMethod],
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
      },
      { filter: { id: 'anthropic' } },
    );

    try {
      const authWrite = MakaioBus.request(AdapterSubsystemSubjects.setProviderConfigAuth, {
        id: 'anthropic.work',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic-work:apiKey' },
        },
      });
      await repository.waitForFirstWrite();
      const enabledWrite = MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
        id: 'anthropic.work',
        patch: { enabled: false },
      });

      repository.unblockFirstWrite();
      await Promise.all([authWrite, enabledWrite]);

      const stored = repository.providerConfigs.get('anthropic.work');
      expect(stored).toMatchObject({
        enabled: false,
        auth: {
          mode: 'explicit',
          credentialRefs: { apiKey: 'stored:providerConfig:anthropic-work:apiKey' },
        },
      });
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, { id: 'anthropic.work' }),
      ).resolves.toMatchObject({
        config: {
          enabled: false,
          auth: { mode: 'explicit', hasCredentials: true },
        },
      });
    } finally {
      repository.unblockFirstWrite();
      offAnthropicProvider();
      await localService.destroy();
    }
  });

  it('rolls back provider-slice writes when setDefault fails mid-slice', async () => {
    const repository = new FailingTrackingRepository(
      new Map<string, ProviderConfigFile>([
        ['anthropic.work', noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true })],
        ['anthropic.personal', noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true })],
      ]),
      new Map<string, AdapterFile>(),
      new Map([['anthropic.personal', 'before-write' satisfies FailureMode]]),
    );

    const localService = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await localService.init();

    try {
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.setDefaultProviderConfig, {
          id: 'anthropic.personal',
        }),
      ).rejects.toThrow('Injected provider config write failure: anthropic.personal');

      const { configs } = await MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigsByDefinition, {
        definitionId: 'anthropic',
      });
      expect(configs).toEqual([
        expect.objectContaining({
          id: 'anthropic.work',
          isDefault: true,
        }),
        expect.objectContaining({
          id: 'anthropic.personal',
          isDefault: false,
        }),
      ]);
      expect(repository.providerConfigs.get('anthropic.work')?.isDefault).toBe(true);
      expect(repository.providerConfigs.get('anthropic.personal')?.isDefault).toBeUndefined();
    } finally {
      await localService.destroy();
    }
  });

  it('rolls back provider-slice writes when setDefault fails after mutating disk', async () => {
    const repository = new FailingTrackingRepository(
      new Map<string, ProviderConfigFile>([
        ['anthropic.work', noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true })],
        ['anthropic.personal', noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true })],
      ]),
      new Map<string, AdapterFile>(),
      new Map([['anthropic.personal', 'after-write' satisfies FailureMode]]),
    );

    const localService = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await localService.init();

    try {
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.setDefaultProviderConfig, {
          id: 'anthropic.personal',
        }),
      ).rejects.toThrow('Injected provider config write failure: anthropic.personal');

      const { configs } = await MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigsByDefinition, {
        definitionId: 'anthropic',
      });
      expect(configs).toEqual([
        expect.objectContaining({
          id: 'anthropic.work',
          isDefault: true,
        }),
        expect.objectContaining({
          id: 'anthropic.personal',
          isDefault: false,
        }),
      ]);
      expect(repository.providerConfigs.get('anthropic.work')?.isDefault).toBe(true);
      expect(repository.providerConfigs.get('anthropic.personal')?.isDefault).toBeUndefined();
    } finally {
      await localService.destroy();
    }
  });

  it('rolls back provider and binding writes when delete fails before adapter persistence', async () => {
    const repository = new FailingTrackingRepository(
      new Map<string, ProviderConfigFile>([
        ['anthropic.work', noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true })],
        ['anthropic.personal', noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true })],
      ]),
      new Map<string, AdapterFile>([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            displayName: 'Claude Code',
            bindings: [
              { providerConfigId: 'anthropic.work', isDefault: true },
              { providerConfigId: 'anthropic.personal' },
            ],
          },
        ],
      ]),
      new Map(),
      new Map([['claude-code', 'before-write' satisfies FailureMode]]),
    );

    const localService = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await localService.init();

    try {
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, {
          id: 'anthropic.work',
        }),
      ).rejects.toThrow('Injected adapter write failure: claude-code');

      const { config: survivingDeletedConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.work',
      });
      expect(survivingDeletedConfig).toMatchObject({
        id: 'anthropic.work',
        isDefault: true,
      });

      const { config: promotedConfig } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.personal',
      });
      expect(promotedConfig).toMatchObject({
        id: 'anthropic.personal',
        isDefault: false,
      });

      const { bindings } = await MakaioBus.request(AdapterSubsystemSubjects.listBindings, {
        adapterName: 'claude-code',
      });
      expect(bindings).toEqual([
        expect.objectContaining({
          providerConfigId: 'anthropic.work',
          isDefault: true,
        }),
        expect.objectContaining({
          providerConfigId: 'anthropic.personal',
          isDefault: false,
        }),
      ]);
    } finally {
      await localService.destroy();
    }
  });

  it('rolls back provider and binding writes when delete fails at the final file removal step', async () => {
    const repository = new FailingTrackingRepository(
      new Map<string, ProviderConfigFile>([
        ['anthropic.work', noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true })],
        ['anthropic.personal', noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true })],
      ]),
      new Map<string, AdapterFile>([
        [
          'claude-code',
          {
            $schema: 'makaio/adapter-config/v1',
            enabled: true,
            displayName: 'Claude Code',
            bindings: [
              { providerConfigId: 'anthropic.work', isDefault: true },
              { providerConfigId: 'anthropic.personal' },
            ],
          },
        ],
      ]),
      new Map(),
      new Map(),
      new Set(['anthropic.work']),
    );

    const localService = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await localService.init();

    try {
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, {
          id: 'anthropic.work',
        }),
      ).rejects.toThrow('Injected provider config delete failure: anthropic.work');

      const { config: retainedDefault } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.work',
      });
      expect(retainedDefault).toMatchObject({
        id: 'anthropic.work',
        isDefault: true,
      });

      const { config: sibling } = await MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, {
        id: 'anthropic.personal',
      });
      expect(sibling).toMatchObject({
        id: 'anthropic.personal',
        isDefault: false,
      });

      expect(repository.providerConfigs.get('anthropic.work')?.isDefault).toBe(true);
      expect(repository.providerConfigs.get('anthropic.personal')?.isDefault).toBeUndefined();

      const { bindings } = await MakaioBus.request(AdapterSubsystemSubjects.listBindings, {
        adapterName: 'claude-code',
      });
      expect(bindings).toEqual([
        expect.objectContaining({
          providerConfigId: 'anthropic.work',
          isDefault: true,
        }),
        expect.objectContaining({
          providerConfigId: 'anthropic.personal',
          isDefault: false,
        }),
      ]);
    } finally {
      await localService.destroy();
    }
  });

  it('binds, unbinds, and reorders defaults idempotently', async () => {
    harness = await createHarness({
      providerConfigs: {
        'anthropic.work': noAuthConfig('anthropic', 'Anthropic Work', { isDefault: true, enabled: true }),
        'anthropic.personal': noAuthConfig('anthropic', 'Anthropic Personal', { enabled: true }),
      },
      adapters: {
        'claude-code': {
          $schema: 'makaio/adapter-config/v1',
          enabled: true,
          displayName: 'Claude Code',
          bindings: [],
        },
      },
    });

    const bindingCreatedEvents: Array<Record<string, unknown>> = [];
    const bindingDeletedEvents: Array<Record<string, unknown>> = [];
    const bindingDefaultChangedEvents: Array<Record<string, unknown>> = [];
    const offCreated = MakaioBus.on(AdapterSubsystemSubjects.binding.created, (ctx) => {
      bindingCreatedEvents.push(ctx.payload);
    });
    const offDeleted = MakaioBus.on(AdapterSubsystemSubjects.binding.deleted, (ctx) => {
      bindingDeletedEvents.push(ctx.payload);
    });
    const offDefaultChanged = MakaioBus.on(AdapterSubsystemSubjects.binding.defaultChanged, (ctx) => {
      bindingDefaultChangedEvents.push(ctx.payload);
    });

    try {
      const first = await MakaioBus.request(AdapterSubsystemSubjects.bind, {
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.work',
      });
      expect(first.binding).toMatchObject({
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.work',
        isDefault: true,
      });
      expect(bindingCreatedEvents).toEqual([
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
      ]);

      const duplicate = await MakaioBus.request(AdapterSubsystemSubjects.bind, {
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.work',
      });
      expect(duplicate.binding).toMatchObject(first.binding);
      expect(bindingCreatedEvents).toHaveLength(1);

      const second = await MakaioBus.request(AdapterSubsystemSubjects.bind, {
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.personal',
      });
      expect(second.binding).toMatchObject({
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.personal',
        isDefault: false,
      });
      expect(bindingCreatedEvents).toHaveLength(2);

      await MakaioBus.request(AdapterSubsystemSubjects.setDefaultBinding, {
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.personal',
      });
      const afterDefault = await MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, {
        adapterName: 'claude-code',
      });
      expect(afterDefault.binding).toMatchObject({
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.personal',
        isDefault: true,
      });
      expect(bindingDefaultChangedEvents).toEqual([
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.personal',
        },
      ]);

      await MakaioBus.request(AdapterSubsystemSubjects.unbind, {
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.personal',
      });

      const bindings = await MakaioBus.request(AdapterSubsystemSubjects.listBindings, {
        adapterName: 'claude-code',
      });
      expect(bindings.bindings).toEqual([
        expect.objectContaining({
          providerConfigId: 'anthropic.work',
          isDefault: true,
        }),
      ]);
      expect(bindingDeletedEvents).toEqual([
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.personal',
        },
      ]);
      expect(bindingDefaultChangedEvents).toEqual([
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.personal',
        },
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.work',
        },
      ]);

      const adapterFile = await readJsonFile<AdapterFile>(path.join(harness.makaioDir, 'adapters', 'claude-code.json'));
      expect(adapterFile).toEqual({
        $schema: 'makaio/adapter-config/v1',
        enabled: true,
        displayName: 'Claude Code',
        bindings: [
          {
            providerConfigId: 'anthropic.work',
            isDefault: true,
          },
        ],
      });
    } finally {
      offCreated();
      offDeleted();
      offDefaultChanged();
    }
  });

  it('uses only enabled provider configs for binding defaults', async () => {
    harness = await createHarness({
      providerConfigs: {
        'anthropic.disabled': noAuthConfig('anthropic', 'Anthropic Disabled', { enabled: false }),
        'anthropic.enabled': noAuthConfig('anthropic', 'Anthropic Enabled', { enabled: true }),
      },
      adapters: {
        'claude-code': {
          $schema: 'makaio/adapter-config/v1',
          enabled: true,
          bindings: [],
        },
      },
    });

    const disabled = await MakaioBus.request(AdapterSubsystemSubjects.bind, {
      adapterName: 'claude-code',
      providerConfigId: 'anthropic.disabled',
    });
    expect(disabled.binding).toMatchObject({ providerConfigId: 'anthropic.disabled', isDefault: false });
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.setDefaultBinding, {
        adapterName: 'claude-code',
        providerConfigId: 'anthropic.disabled',
      }),
    ).rejects.toThrow('Disabled provider config cannot be default binding: anthropic.disabled');

    const enabled = await MakaioBus.request(AdapterSubsystemSubjects.bind, {
      adapterName: 'claude-code',
      providerConfigId: 'anthropic.enabled',
    });
    expect(enabled.binding).toMatchObject({ providerConfigId: 'anthropic.enabled', isDefault: true });

    await MakaioBus.request(AdapterSubsystemSubjects.unbind, {
      adapterName: 'claude-code',
      providerConfigId: 'anthropic.enabled',
    });
    const bindings = await MakaioBus.request(AdapterSubsystemSubjects.listBindings, {
      adapterName: 'claude-code',
    });
    expect(bindings.bindings).toEqual([
      expect.objectContaining({ providerConfigId: 'anthropic.disabled', isDefault: false }),
    ]);
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.getDefaultBinding, { adapterName: 'claude-code' }),
    ).resolves.toEqual({ binding: null });
  });

  it('writes adapter configs through the repository without dropping existing bindings', async () => {
    harness = await createHarness({
      adapters: {
        'claude-code': {
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
        },
      },
    });

    const { config: patched } = await MakaioBus.request(AdapterSubsystemSubjects.setAdapterConfig, {
      name: 'claude-code',
      patch: {
        displayName: 'Claude Code Pro',
        settings: {
          maxConcurrency: 5,
        },
        enabled: false,
      },
    });

    expect(patched).toMatchObject({
      name: 'claude-code',
      enabled: false,
      displayName: 'Claude Code Pro',
      settings: {
        maxConcurrency: 5,
      },
      bindings: [
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
      ],
    });

    const patchedFile = await readJsonFile<AdapterFile>(path.join(harness.makaioDir, 'adapters', 'claude-code.json'));
    expect(patchedFile).toEqual({
      $schema: 'makaio/adapter-config/v1',
      enabled: false,
      displayName: 'Claude Code Pro',
      settings: {
        maxConcurrency: 5,
      },
      bindings: [
        {
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
      ],
    });

    await MakaioBus.request(AdapterSubsystemSubjects.setAdapterEnabled, {
      name: 'claude-code',
      enabled: true,
    });

    const reenabled = await MakaioBus.request(AdapterSubsystemSubjects.getAdapterConfig, {
      name: 'claude-code',
    });
    expect(reenabled.config).toMatchObject({
      name: 'claude-code',
      enabled: true,
      displayName: 'Claude Code Pro',
      bindings: [
        {
          adapterName: 'claude-code',
          providerConfigId: 'anthropic.work',
          isDefault: true,
        },
      ],
    });
  });

  it('keeps a keeper model visible when switching to allowlist mode', async () => {
    harness = await createHarness({
      providerConfigs: {
        'anthropic.work': noAuthConfig('anthropic', 'Anthropic Work', { enabled: true }),
      },
    });

    const offProvider = MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      expect(ctx.payload.id).toBe('anthropic');
      ctx.setResult({
        provider: {
          id: 'anthropic',
          packageName: '@makaio/provider-anthropic',
          name: 'Anthropic',
          availableModels: [
            { name: 'sonnet', friendlyName: 'Sonnet', contextWindowSize: 200000, labId: 'anthropic' },
            { name: 'haiku', friendlyName: 'Haiku', contextWindowSize: 200000, labId: 'anthropic' },
          ],
          authMethods: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
    });

    try {
      const result = await MakaioBus.request(AdapterSubsystemSubjects.setModelFilterMode, {
        id: 'anthropic.work',
        modelFilterMode: 'allowlist',
        preferredModel: 'sonnet',
      });

      expect(result.config).toMatchObject({
        id: 'anthropic.work',
        modelFilterMode: 'allowlist',
        modelVisibility: {
          sonnet: 'visible',
        },
      });
    } finally {
      offProvider();
    }
  });

  it('persists full adapter metadata when creating a canonical adapter file on first write', async () => {
    harness = await createHarness();

    const { config } = await MakaioBus.request(AdapterSubsystemSubjects.setAdapterConfig, {
      name: 'claude-code',
      patch: {
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
      },
    });

    expect(config).toMatchObject({
      name: 'claude-code',
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
      bindings: [],
    });

    expect(await readJsonFile<AdapterFile>(path.join(harness.makaioDir, 'adapters', 'claude-code.json'))).toEqual({
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
    });
  });

  it('clones adapter settings payloads before storing them in the snapshot', async () => {
    harness = await createHarness();

    const createSettings = {
      nested: {
        maxConcurrency: 3,
      },
    };

    await MakaioBus.request(AdapterSubsystemSubjects.setAdapterConfig, {
      name: 'claude-code',
      patch: {
        enabled: true,
        settings: createSettings,
      },
    });

    createSettings.nested.maxConcurrency = 9;

    let { config } = await MakaioBus.request(AdapterSubsystemSubjects.getAdapterConfig, {
      name: 'claude-code',
    });
    expect(config?.settings).toEqual({
      nested: {
        maxConcurrency: 3,
      },
    });

    const updateSettings = {
      nested: {
        maxConcurrency: 5,
      },
    };

    await MakaioBus.request(AdapterSubsystemSubjects.setAdapterConfig, {
      name: 'claude-code',
      patch: {
        settings: updateSettings,
      },
    });

    updateSettings.nested.maxConcurrency = 11;

    ({ config } = await MakaioBus.request(AdapterSubsystemSubjects.getAdapterConfig, {
      name: 'claude-code',
    }));
    expect(config?.settings).toEqual({
      nested: {
        maxConcurrency: 5,
      },
    });
  });
});
