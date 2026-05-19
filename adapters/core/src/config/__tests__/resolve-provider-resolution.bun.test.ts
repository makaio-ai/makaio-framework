/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createChannelEndpoint, MakaioBus } from '@makaio/bus-core';
import { CredentialSubjects } from '@makaio/contracts';
import { buildStoredCredentialRef, type AdapterFile, type ProviderConfigFile } from '@makaio/contracts/config';
import {
  AdapterSubsystemSubjects,
  type AdapterFileConfigSet,
  type IAdapterConfigRepository,
  type ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import type { ChannelEndpoint } from '@makaio/bus-core';
import { AdapterSubsystemService } from '@makaio/adapter-subsystem';
import type { ExtensionCoordinator } from '@makaio/kernel';
import { resolveProviderResolution } from '../resolve-provider-resolution.js';

const TEST_CHANNEL_TOKEN = 'resolve-provider-resolution-test-token';

let resolveStore: Map<string, string | null>;
let cleanupFns: Array<() => void | Promise<void>>;
let channelEndpoint: ChannelEndpoint | null;
let subsystemService: AdapterSubsystemService | null;

interface ProviderResolutionFixtureOptions {
  readonly providerConfigId?: string;
  readonly definitionId?: string;
  readonly endpointOverrides?: Record<string, string>;
  readonly credentialRefs?: Record<string, ReturnType<typeof buildStoredCredentialRef>>;
  readonly providerEndpoints?: Record<string, string>;
  readonly providerExists?: boolean;
  readonly onProviderLookup?: (providerId: string) => void;
}

class ProviderResolutionRepository implements IAdapterConfigRepository {
  public constructor(
    private readonly providerConfigs: Map<string, ProviderConfigFile>,
    private readonly adapters: Map<string, AdapterFile>,
  ) {}

  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    return { configs: new Map([...this.adapters.entries()].map(([name, config]) => [name, structuredClone(config)])) };
  }

  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    return {
      configs: new Map([...this.providerConfigs.entries()].map(([id, config]) => [id, structuredClone(config)])),
    };
  }

  public async writeProviderConfig(): Promise<void> {
    throw new Error('resolve-provider-resolution tests should not write provider configs');
  }

  public async deleteProviderConfig(): Promise<boolean> {
    throw new Error('resolve-provider-resolution tests should not delete provider configs');
  }

  public async writeAdapterFile(): Promise<void> {
    throw new Error('resolve-provider-resolution tests should not write adapter configs');
  }

  public async deleteAdapterFile(): Promise<boolean> {
    throw new Error('resolve-provider-resolution tests should not delete adapter configs');
  }
}

/**
 * Register the credential channel used by provider-resolution tests.
 * @returns Nothing. Installs channel cleanup into the shared cleanup list.
 */
function setupCredentialBus(): void {
  cleanupFns.push(
    MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
      ctx.setResult({ token: TEST_CHANNEL_TOKEN });
    }),
  );

  channelEndpoint = createChannelEndpoint(
    MakaioBus.getContext(),
    'credentials',
    (channel) => {
      channel.on(CredentialSubjects.resolve, (ctx) => {
        const { ref } = ctx.payload;
        if (!resolveStore.has(ref)) {
          ctx.setResult({ value: null, error: `Ref not found: ${ref}` });
          return;
        }
        ctx.setResult({ value: resolveStore.get(ref) ?? null });
      });
    },
    { token: TEST_CHANNEL_TOKEN },
  );

  cleanupFns.push(() => channelEndpoint?.close());
}

/**
 * Register a real adapter-subsystem service plus provider definition lookup.
 * @param options - Canonical provider-config/provider-definition fixture options.
 * @returns Nothing. Installs service cleanup into the shared cleanup list.
 */
function registerProviderResolutionHandlers(options: ProviderResolutionFixtureOptions = {}): void {
  const definitionId = options.definitionId ?? 'provider-1';
  const providerConfigId = options.providerConfigId ?? 'cfg-1';
  const repository = new ProviderResolutionRepository(
    new Map<string, ProviderConfigFile>([
      [
        providerConfigId,
        {
          $schema: 'makaio/provider-config/v1',
          definitionId,
          name: 'Provider Config',
          ...(options.endpointOverrides ? { endpointOverrides: options.endpointOverrides } : {}),
          ...(options.credentialRefs ? { credentials: options.credentialRefs } : {}),
          modelFilterMode: 'show-all',
          isDefault: true,
          enabled: true,
          isSentinel: false,
        },
      ],
    ]),
    new Map(),
  );
  subsystemService = new AdapterSubsystemService({
    bus: MakaioBus,
    configRepository: repository,
    coordinator: { registerContributionProcessor: () => () => {} } as unknown as ExtensionCoordinator,
    machineId: 'test-machine',
    platformDefaults: {},
  });
  cleanupFns.push(() => subsystemService?.destroy().catch(() => undefined));

  cleanupFns.push(
    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      options.onProviderLookup?.(ctx.payload.id);
      if (options.providerExists === false) {
        ctx.setResult({ provider: null });
        return;
      }
      ctx.setResult({
        provider: {
          id: ctx.payload.id,
          packageName: '@makaio/provider-test',
          name: 'Provider',
          endpoints: options.providerEndpoints ?? {
            anthropic: 'https://default.example.com',
          },
          availableModels: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }),
  );
}

beforeEach(() => {
  resolveStore = new Map();
  cleanupFns = [];
  channelEndpoint = null;
  subsystemService = null;
  MakaioBus.__resetHandlers?.();
});

afterEach(async () => {
  for (const cleanup of cleanupFns) {
    await cleanup();
  }
  cleanupFns = [];
  channelEndpoint = null;
  subsystemService = null;
  MakaioBus.__resetHandlers?.();
});

describe('resolveProviderResolution', () => {
  it('combines the canonical config read with runtime context assembly', async () => {
    setupCredentialBus();
    resolveStore.set(buildStoredCredentialRef('cfg-1', 'apiKey'), 'sk-test-123');
    let requestedProviderId: string | null = null;

    registerProviderResolutionHandlers({
      endpointOverrides: {
        anthropic: 'https://override.example.com',
      },
      credentialRefs: {
        apiKey: buildStoredCredentialRef('cfg-1', 'apiKey'),
      },
      onProviderLookup: (providerId) => {
        requestedProviderId = providerId;
      },
    });
    await subsystemService?.init();

    await expect(resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic')).resolves.toEqual({
      config: {
        id: 'cfg-1',
        definitionId: 'provider-1',
        name: 'Provider Config',
        endpointOverrides: {
          anthropic: 'https://override.example.com',
        },
        modelFilterMode: 'show-all',
        isDefault: true,
        enabled: true,
        isSentinel: false,
        hasCredentials: true,
      },
      definition: {
        id: 'provider-1',
        packageName: '@makaio/provider-test',
        name: 'Provider',
        endpoints: {
          anthropic: 'https://default.example.com',
        },
        availableModels: [],
        defaultModelFilterMode: 'show-all',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      baseUrl: 'https://override.example.com',
      credentials: {
        apiKey: 'sk-test-123',
      },
    });
    expect(requestedProviderId!).toBe('provider-1');
  });

  it('uses separate canonical config and runtime context reads', async () => {
    setupCredentialBus();
    resolveStore.set(buildStoredCredentialRef('cfg-1', 'apiKey'), 'sk-test-123');
    let providerConfigReads = 0;
    let providerContextReads = 0;

    registerProviderResolutionHandlers({
      credentialRefs: {
        apiKey: buildStoredCredentialRef('cfg-1', 'apiKey'),
      },
    });
    await subsystemService?.init();

    cleanupFns.push(
      MakaioBus.on(
        AdapterSubsystemSubjects.getProviderConfig,
        async (ctx) => {
          providerConfigReads += 1;
          await ctx.next();
        },
        { priority: 100 },
      ),
    );
    cleanupFns.push(
      MakaioBus.on(
        AdapterSubsystemSubjects.buildProviderContext,
        async (ctx) => {
          providerContextReads += 1;
          await ctx.next();
        },
        { priority: 100 },
      ),
    );

    await resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic');

    expect(providerConfigReads).toBe(1);
    expect(providerContextReads).toBe(1);
  });

  it('falls back to the provider definition endpoint when no override is present', async () => {
    setupCredentialBus();
    resolveStore.set(buildStoredCredentialRef('cfg-1', 'apiKey'), 'sk-test-123');

    registerProviderResolutionHandlers({
      credentialRefs: {
        apiKey: buildStoredCredentialRef('cfg-1', 'apiKey'),
      },
    });
    await subsystemService?.init();

    await expect(resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic')).resolves.toEqual({
      config: {
        id: 'cfg-1',
        definitionId: 'provider-1',
        name: 'Provider Config',
        modelFilterMode: 'show-all',
        isDefault: true,
        enabled: true,
        isSentinel: false,
        hasCredentials: true,
      },
      definition: {
        id: 'provider-1',
        packageName: '@makaio/provider-test',
        name: 'Provider',
        endpoints: {
          anthropic: 'https://default.example.com',
        },
        availableModels: [],
        defaultModelFilterMode: 'show-all',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      baseUrl: 'https://default.example.com',
      credentials: {
        apiKey: 'sk-test-123',
      },
    });
  });

  it('throws when the provider config cannot be found', async () => {
    registerProviderResolutionHandlers({ providerConfigId: 'cfg-1' });
    await subsystemService?.init();
    await expect(resolveProviderResolution(MakaioBus, 'missing-config', 'anthropic')).rejects.toThrow(
      "ProviderConfig 'missing-config' not found",
    );
  });

  it('preserves the provider-config error contract when context building observes a missing config', async () => {
    registerProviderResolutionHandlers({ providerConfigId: 'cfg-1' });
    await subsystemService?.init();
    cleanupFns.push(
      MakaioBus.on(
        AdapterSubsystemSubjects.buildProviderContext,
        (ctx) => {
          ctx.setResult({ context: null });
        },
        { priority: 100 },
      ),
    );

    await expect(resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic')).rejects.toThrow(
      "ProviderConfig 'cfg-1' not found",
    );
  });

  it('rejects mismatched config and context snapshots during resolution', async () => {
    let providerLookups = 0;
    registerProviderResolutionHandlers({
      definitionId: 'provider-1',
      onProviderLookup: () => {
        providerLookups += 1;
      },
    });
    await subsystemService?.init();
    cleanupFns.push(
      MakaioBus.on(
        AdapterSubsystemSubjects.buildProviderContext,
        (ctx) => {
          ctx.setResult({
            context: {
              providerConfigId: ctx.payload.providerConfigId,
              definitionId: 'provider-2',
              credentialRefs: {},
            },
          });
        },
        { priority: 100 },
      ),
    );

    await expect(resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic')).rejects.toThrow(
      "ProviderConfig 'cfg-1' changed during resolution; retry",
    );
    expect(providerLookups).toBe(0);
  });

  it('throws when the provider definition cannot be found', async () => {
    registerProviderResolutionHandlers({
      definitionId: 'missing-provider',
      providerExists: false,
    });
    await subsystemService?.init();

    await expect(resolveProviderResolution(MakaioBus, 'cfg-1', 'anthropic')).rejects.toThrow(
      "ProviderDefinition 'missing-provider' not found for config 'cfg-1'",
    );
  });
});
