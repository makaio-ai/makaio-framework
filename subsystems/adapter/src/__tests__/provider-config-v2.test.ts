import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import { AdapterSubsystemNamespace, AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ClientStorageSubjects, ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
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
      sourceHints: [{ kind: 'environment' as const, variable: 'ANTHROPIC_API_KEY' }],
    },
  ],
};

const noAuthMethod = {
  id: 'none',
  mode: 'none' as const,
  label: 'No authentication',
};

const nativeMethod = {
  id: 'native',
  mode: 'inferred' as const,
  label: 'Claude Code native authentication',
};

class MemoryRepository {
  public failNextProviderWriteAfterMutation = false;

  public constructor(
    public readonly providerConfigs = new Map<string, ProviderConfigFile>(),
    public readonly adapters = new Map<string, AdapterFile>(),
  ) {}

  public async loadAdapterConfigs() {
    return { configs: structuredClone(this.adapters) };
  }

  public async loadProviderConfigs() {
    return { configs: structuredClone(this.providerConfigs) };
  }

  public async writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void> {
    this.providerConfigs.set(id, structuredClone(config));
    if (this.failNextProviderWriteAfterMutation) {
      this.failNextProviderWriteAfterMutation = false;
      throw new Error('injected provider write failure');
    }
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

interface Harness {
  readonly repository: MemoryRepository;
  readonly service: AdapterSubsystemService;
  readonly cleanup: () => Promise<void>;
}

interface HarnessOptions {
  readonly providerEnabled?: boolean;
  readonly clientEnabled?: boolean;
}

/**
 * Create the service with definition storage handlers used by auth validation.
 * @param providerConfigs - Initial normalized provider configs.
 * @param options - Definition availability overrides.
 */
async function createHarness(
  providerConfigs = new Map<string, ProviderConfigFile>(),
  options: HarnessOptions = {},
): Promise<Harness> {
  const repository = new MemoryRepository(providerConfigs);
  const service = new AdapterSubsystemService({
    bus: MakaioBus,
    configRepository: repository,
    coordinator: createStubCoordinator(),
    machineId: TEST_MACHINE_ID,
    platformDefaults: TEST_PLATFORM_DEFAULTS,
  });
  await service.init();

  const offProvider = MakaioBus.on(
    ProviderStorageSubjects.get,
    (ctx) => {
      ctx.setResult({
        provider:
          ctx.payload.id === 'anthropic'
            ? {
                id: 'anthropic',
                packageName: '@makaio/provider-anthropic',
                name: 'Anthropic',
                availableModels: [],
                authMethods: [apiKeyMethod, noAuthMethod],
                defaultModelFilterMode: 'show-all',
                enabled: options.providerEnabled ?? true,
                createdAt: 1,
                updatedAt: 1,
              }
            : null,
      });
    },
    { priority: 100 },
  );
  const offClient = MakaioBus.on(
    ClientStorageSubjects.get,
    (ctx) => {
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
                enabled: options.clientEnabled ?? true,
                createdAt: 1,
                updatedAt: 1,
              }
            : null,
      });
    },
    { priority: 100 },
  );

  return {
    repository,
    service,
    cleanup: async () => {
      offClient();
      offProvider();
      await service.destroy();
    },
  };
}

describe('canonical provider config v2 writes and reads', () => {
  let harness: Harness;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.registerNamespace(AdapterSubsystemNamespace);
  });

  afterEach(async () => {
    await harness?.cleanup?.();
    MakaioBus.__resetHandlers?.();
  });

  it('creates required auth and exposes only the fixed safe summary', async () => {
    harness = await createHarness();

    const result = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
      },
      managedBy: { kind: 'client', clientId: 'claude-code' },
    });

    expect(result.config).toEqual({
      id: 'anthropic-work',
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      modelFilterMode: 'show-all',
      isDefault: true,
      enabled: true,
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        hasCredentials: true,
      },
      managedBy: { kind: 'client', clientId: 'claude-code' },
    });
    expect(result.config).not.toHaveProperty('credentials');
    expect(result.config).not.toHaveProperty('credentialRefs');
    expect(result.config).not.toHaveProperty('sourceRef');
    expect(result.config).not.toHaveProperty('isSentinel');
    expect(harness.repository.providerConfigs.get('anthropic-work')).toMatchObject({
      $schema: 'makaio/provider-config/v2',
      auth: {
        credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
      },
    });
  });

  it('validates method ownership, mode, and exact credential fields from definition storage', async () => {
    harness = await createHarness();

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
        definitionId: 'anthropic',
        name: 'Missing Key',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { unexpected: 'env:ANTHROPIC_API_KEY' },
        },
      }),
    ).rejects.toThrow(/missing required fields \[apiKey\].*unexpected fields \[unexpected\]/);

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
        definitionId: 'anthropic',
        name: 'Wrong Mode',
        auth: {
          mode: 'none',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        },
      }),
    ).rejects.toThrow(/declares mode "explicit", not "none"/);

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
        definitionId: 'anthropic',
        name: 'Missing Method',
        auth: {
          mode: 'none',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'missing' },
        },
      }),
    ).rejects.toThrow(/is not declared/);
  });

  it('accepts a definition-backed client native method with explicit account selection', async () => {
    harness = await createHarness();

    const { config } = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Claude Native Work',
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        account: { managerId: 'claude-code', accountId: 'work' },
      },
    });

    expect(config.auth).toEqual({
      mode: 'inferred',
      method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
      account: { managerId: 'claude-code', accountId: 'work' },
      hasCredentials: false,
    });
  });

  it('replaces auth atomically and rolls disk plus reads back on persistence failure', async () => {
    const original: ProviderConfigFile = {
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
      isDefault: true,
      enabled: true,
    };
    harness = await createHarness(new Map([['anthropic-work', original]]));
    harness.repository.failNextProviderWriteAfterMutation = true;

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.setProviderConfigAuth, {
        id: 'anthropic-work',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
        },
      }),
    ).rejects.toThrow('injected provider write failure');

    expect(harness.repository.providerConfigs.get('anthropic-work')).toEqual(original);
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, { id: 'anthropic-work' }),
    ).resolves.toMatchObject({
      config: { auth: { mode: 'none', hasCredentials: false } },
    });
  });

  it('keeps disabled reservations out of defaults and promotes atomically on finalize/disable', async () => {
    harness = await createHarness();

    const reserved = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Reserved',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: 'stored:providerConfig:reserved:apiKey' },
      },
      enabled: false,
    });
    expect(reserved.config).toMatchObject({ enabled: false, isDefault: false });

    const sibling = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Sibling',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
    });
    expect(sibling.config).toMatchObject({ enabled: true, isDefault: true });

    const finalized = await MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
      id: reserved.config.id,
      patch: { enabled: true },
    });
    expect(finalized.config).toMatchObject({ enabled: true, isDefault: false });

    const disabled = await MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
      id: sibling.config.id,
      patch: { enabled: false },
    });
    expect(disabled.config).toMatchObject({ enabled: false, isDefault: false });
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, { id: reserved.config.id }),
    ).resolves.toMatchObject({ config: { enabled: true, isDefault: true } });
  });

  it('stores a structurally valid disabled draft but rejects enabling it while its provider is disabled', async () => {
    harness = await createHarness(new Map(), { providerEnabled: false });

    const draft = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Disabled Provider Draft',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
      enabled: false,
    });

    expect(draft.config).toMatchObject({ enabled: false, isDefault: false, auth: { mode: 'none' } });
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
        id: draft.config.id,
        patch: { enabled: true },
      }),
    ).rejects.toThrow('Provider definition is disabled for auth selection: anthropic');
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, { id: draft.config.id }),
    ).resolves.toMatchObject({ config: { enabled: false, isDefault: false } });

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, {
        adapterName: 'missing-adapter',
        providerConfigId: draft.config.id,
      }),
    ).resolves.toEqual({ status: 'error', code: 'provider-config-disabled' });
  });

  it('does not convert unexpected runtime snapshot failures into disabled status', async () => {
    const raw: ProviderConfigFile = {
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      name: 'Enabled Config',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
      enabled: true,
    };
    harness = await createHarness(new Map([['enabled-config', raw]]));
    const offFailure = MakaioBus.on(
      ProviderStorageSubjects.get,
      () => {
        throw new Error('catalog I/O failed');
      },
      { priority: 200 },
    );

    try {
      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, {
          adapterName: 'missing-adapter',
          providerConfigId: 'enabled-config',
        }),
      ).rejects.toThrow('catalog I/O failed');
    } finally {
      offFailure();
    }
  });

  it('stores disabled client-native auth but rejects enabling it while the client definition is disabled', async () => {
    harness = await createHarness(new Map(), { clientEnabled: false });

    const draft = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Disabled Client Draft',
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
      },
      enabled: false,
    });

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.updateProviderConfig, {
        id: draft.config.id,
        patch: { enabled: true },
      }),
    ).rejects.toThrow('Client definition is disabled for auth selection: claude-code');
  });

  it('rolls a failed disabled reservation out of storage and default derivation', async () => {
    harness = await createHarness();
    harness.repository.failNextProviderWriteAfterMutation = true;

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
        definitionId: 'anthropic',
        name: 'Failed Reservation',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          credentialRefs: { apiKey: 'stored:providerConfig:failed-reservation:apiKey' },
        },
        enabled: false,
      }),
    ).rejects.toThrow('injected provider write failure');

    expect(harness.repository.providerConfigs.size).toBe(0);
    const created = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Healthy',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
    });
    expect(created.config).toMatchObject({ id: 'healthy', isDefault: true, enabled: true });
  });

  it('applies lifecycle management independently from explicit authentication', async () => {
    harness = await createHarness();
    const created = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
      definitionId: 'anthropic',
      name: 'Managed Explicit',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
      },
      managedBy: { kind: 'client', clientId: 'claude-code' },
    });

    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, { id: created.config.id }),
    ).resolves.toEqual({ deleted: false });
    await expect(
      MakaioBus.request(AdapterSubsystemSubjects.getProviderConfig, { id: created.config.id }),
    ).resolves.toMatchObject({
      config: {
        enabled: false,
        isDefault: false,
        managedBy: { kind: 'client', clientId: 'claude-code' },
        auth: { mode: 'explicit', hasCredentials: true },
      },
    });
  });
});
