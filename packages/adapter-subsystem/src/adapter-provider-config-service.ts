import type { IMakaioBus } from '@makaio/bus-core';
import { CredentialSubjects } from '@makaio/contracts';
import { resolveModelVisibility, type ModelFilterMode } from '@makaio/contracts/provider';
import {
  PROVIDER_CONFIG_SCHEMA_VERSION,
  type ProviderConfigFile,
  brandCredentialRecord,
  resolveCanonicalProviderConfigName,
  slugifyProviderConfigName,
} from '@makaio/contracts/config';
import type { ProviderConfigFileRecord } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { AdapterSubsystemSubjects } from './namespace.js';
import type { AdapterConfigStore } from './adapter-config-store.js';
import {
  cloneProviderEndpointOverrides,
  cloneProviderModelVisibility,
  type ProviderConfigCreateInput,
  type ProviderConfigPatch,
  type ProviderConfigCredentialRefs,
  type RemoveBindingsResult,
} from './adapter-subsystem-types.js';

/**
 * Constructor options for {@link AdapterProviderConfigService}.
 */
export interface AdapterProviderConfigServiceOptions {
  /**
   * Config store that owns all snapshot mutations and read accessors.
   */
  readonly configStore: AdapterConfigStore;
  /**
   * Bus instance used for event emission and bus requests.
   */
  readonly bus: IMakaioBus;
}

/**
 * Focused service for provider config CRUD operations.
 *
 * All snapshot mutations and reads are delegated to the {@link AdapterConfigStore}.
 * After each mutation, the appropriate bus events are emitted via
 * {@link AdapterSubsystemSubjects}.
 */
export class AdapterProviderConfigService {
  private readonly configStore: AdapterConfigStore;
  private readonly bus: IMakaioBus;

  /**
   * Create a new provider config service.
   * @param options - Dependencies required by the service.
   */
  public constructor(options: AdapterProviderConfigServiceOptions) {
    this.configStore = options.configStore;
    this.bus = options.bus;
  }

  /**
   * Create a provider config and persist it through the repository.
   * @param input - Creation payload from the bus request.
   * @returns Newly created provider config read model.
   */
  public async createProviderConfig(input: ProviderConfigCreateInput): Promise<{ config: ProviderConfigFileRecord }> {
    const name = await this.resolveProviderConfigName(input.definitionId, input.name);
    const id = slugifyProviderConfigName(name);
    const credentials = this.cloneCreateCredentialRefs(input);
    const endpointOverrides = cloneProviderEndpointOverrides(input.endpointOverrides);
    const modelVisibility = cloneProviderModelVisibility(input.modelVisibility);
    const config = await this.configStore.commitSnapshotMutation(
      (nextSnapshot) => {
        this.configStore.assertProviderConfigNameUnique(name);
        if (nextSnapshot.providerConfigs.has(id)) {
          throw new Error(`Provider config already exists: ${id}`);
        }
        nextSnapshot.providerConfigs.set(id, {
          $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
          definitionId: input.definitionId,
          name,
          credentials,
          endpointOverrides,
          modelVisibility,
          modelFilterMode: input.modelFilterMode ?? 'show-all',
          isDefault: ![...nextSnapshot.providerConfigs.values()].some(
            (config) => config.definitionId === input.definitionId,
          ),
          enabled: true,
          isSentinel: input.isSentinel ?? false,
        });
      },
      () => this.configStore.requireProviderConfig(id, 'creation'),
    );
    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.created, config);
    return { config };
  }

  /**
   * Update a provider config.
   * @param id - Provider config ID.
   * @param patch - Partial mutation payload.
   * @returns Updated provider config read model.
   */
  public async updateProviderConfig(
    id: string,
    patch: ProviderConfigPatch,
  ): Promise<{ config: ProviderConfigFileRecord }> {
    const config = await this.configStore.commitSnapshotMutation(
      (nextSnapshot) => {
        const existing = nextSnapshot.providerConfigs.get(id);
        if (!existing) {
          throw new Error(`Provider config not found: ${id}`);
        }
        const nextName = patch.name ?? existing.name ?? existing.definitionId;
        if (patch.name !== undefined) {
          this.configStore.assertProviderConfigNameUnique(nextName, id);
        }
        nextSnapshot.providerConfigs.set(id, {
          ...existing,
          name: nextName,
          endpointOverrides:
            patch.endpointOverrides === null
              ? undefined
              : patch.endpointOverrides !== undefined
                ? cloneProviderEndpointOverrides(patch.endpointOverrides)
                : existing.endpointOverrides,
          modelVisibility:
            patch.modelVisibility !== undefined
              ? cloneProviderModelVisibility(patch.modelVisibility)
              : existing.modelVisibility,
          enabled: patch.enabled ?? existing.enabled,
        });
      },
      () => this.configStore.requireProviderConfig(id, 'update'),
    );
    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.updated, config);
    return { config };
  }

  /**
   * Replace the canonical credential refs for one provider config.
   * @param id - Provider config ID.
   * @param credentialRefs - Full replacement credential-ref map.
   * @returns Updated provider config read model.
   */
  public async setProviderConfigCredentialRefs(
    id: string,
    credentialRefs: ProviderConfigCredentialRefs,
  ): Promise<{ config: ProviderConfigFileRecord }> {
    const credentials = this.normalizeCredentialRefs(credentialRefs);
    const config = await this.configStore.commitSnapshotMutation(
      (nextSnapshot) => {
        const existing = nextSnapshot.providerConfigs.get(id);
        if (!existing) {
          throw new Error(`Provider config not found: ${id}`);
        }
        nextSnapshot.providerConfigs.set(id, { ...existing, credentials });
      },
      () => this.configStore.requireProviderConfig(id, 'credential update'),
    );

    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.updated, config);
    return { config };
  }

  /**
   * Delete or soft-delete a provider config.
   * @param id - Provider config ID.
   * @returns Deletion result payload.
   */
  public async deleteProviderConfig(id: string): Promise<{ deleted: boolean }> {
    let deleted = false;
    let updatedConfigId: string | undefined;
    let definitionId = '';
    let wasDefault = false;
    let promoted: string | null = null;
    let affectedBindings: RemoveBindingsResult = {
      changedAdapters: new Map(),
      deletedBindings: [],
      defaultChangedBindings: [],
    };
    const sentinelConfig = await this.configStore.commitSnapshotMutation(
      (nextSnapshot) => {
        const existing = nextSnapshot.providerConfigs.get(id);
        if (!existing) {
          return;
        }
        if (existing.isSentinel) {
          if (existing.enabled) {
            nextSnapshot.providerConfigs.set(id, { ...existing, enabled: false });
            updatedConfigId = id;
          }
          return;
        }
        affectedBindings = this.configStore.removeBindingsForConfig(
          id,
          nextSnapshot.adapters,
          nextSnapshot.providerConfigs,
        );
        wasDefault = existing.isDefault ?? false;
        definitionId = existing.definitionId;
        deleted = true;
        nextSnapshot.providerConfigs.delete(id);
        promoted = wasDefault
          ? this.configStore.promoteProviderConfigDefault(existing.definitionId, id, nextSnapshot.providerConfigs)
          : null;
        for (const [adapterName, raw] of affectedBindings.changedAdapters) {
          nextSnapshot.adapters.set(adapterName, raw);
        }
      },
      () => (updatedConfigId ? this.configStore.requireProviderConfig(id, 'sentinel disable') : null),
    );

    if (!deleted) {
      if (!updatedConfigId) {
        return { deleted: false };
      }
      await this.bus.emit(AdapterSubsystemSubjects.providerConfig.updated, sentinelConfig!);
      return { deleted: false };
    }
    await this.cleanupDeletedProviderCredentials(id);
    for (const binding of affectedBindings.deletedBindings) {
      await this.bus.emit(AdapterSubsystemSubjects.binding.deleted, binding);
    }
    for (const binding of affectedBindings.defaultChangedBindings) {
      await this.bus.emit(AdapterSubsystemSubjects.binding.defaultChanged, binding);
    }
    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.deleted, { id });
    if (wasDefault) {
      await this.bus.emit(AdapterSubsystemSubjects.providerConfig.defaultChanged, {
        definitionId,
        configId: promoted,
      });
    }
    return { deleted: true };
  }

  /**
   * Set the default provider config for its definition.
   * @param id - Provider config ID to promote.
   * @returns Updated config read model.
   */
  public async setDefaultProviderConfig(id: string): Promise<{ config: ProviderConfigFileRecord }> {
    let definitionId = '';
    const config = await this.configStore.commitSnapshotMutation(
      (nextSnapshot) => {
        const target = nextSnapshot.providerConfigs.get(id);
        if (!target) {
          throw new Error(`Provider config not found: ${id}`);
        }
        if (!(target.enabled ?? true)) {
          throw new Error(`Disabled provider config cannot be default: ${id}`);
        }
        definitionId = target.definitionId;
        for (const [candidateId, config] of nextSnapshot.providerConfigs) {
          if (config.definitionId === definitionId) {
            nextSnapshot.providerConfigs.set(candidateId, { ...config, isDefault: candidateId === id });
          }
        }
      },
      () => this.configStore.requireProviderConfig(id, 'setDefault'),
    );

    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.updated, config);
    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.defaultChanged, {
      definitionId,
      configId: id,
    });
    return { config };
  }

  /**
   * Update the model filter mode for a provider config.
   * @param id - Provider config ID.
   * @param modelFilterMode - Requested filter mode.
   * @param preferredModel - Optional keeper model name.
   * @returns Updated config read model.
   */
  public async setModelFilterMode(
    id: string,
    modelFilterMode: ModelFilterMode,
    preferredModel?: string,
  ): Promise<{ config: ProviderConfigFileRecord }> {
    const config = await this.configStore.commitSnapshotMutation(
      async (nextSnapshot) => {
        const existing = nextSnapshot.providerConfigs.get(id);
        if (!existing) {
          throw new Error(`Provider config not found: ${id}`);
        }
        let nextModelVisibility = existing.modelVisibility;
        if (modelFilterMode === 'allowlist') {
          const keeper = await this.selectAllowlistKeeper(existing.definitionId, existing, preferredModel);
          if (keeper) {
            nextModelVisibility = { ...(existing.modelVisibility ?? {}), [keeper]: 'visible' };
          }
        }
        nextSnapshot.providerConfigs.set(id, { ...existing, modelFilterMode, modelVisibility: nextModelVisibility });
      },
      () => this.configStore.requireProviderConfig(id, 'setModelFilterMode'),
    );

    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.updated, config);
    return { config };
  }

  /**
   * Normalize a credential-refs map into the snapshot-safe branded form.
   * @param credentialRefs - Raw credential refs from a bus payload.
   * @returns Branded credential record, or `undefined` when the map is empty.
   */
  public normalizeCredentialRefs(credentialRefs?: Record<string, string>): ProviderConfigFile['credentials'] {
    if (!credentialRefs || Object.keys(credentialRefs).length === 0) {
      return undefined;
    }

    return brandCredentialRecord(credentialRefs);
  }

  /**
   * Extract and normalize credential refs from a creation input payload.
   * @param input - Provider config creation payload.
   * @returns Branded credential record, or `undefined` when no refs are present.
   */
  public cloneCreateCredentialRefs(input: ProviderConfigCreateInput): ProviderConfigFile['credentials'] {
    return this.normalizeCredentialRefs(input.credentialRefs);
  }

  /**
   * Request deletion of stored credentials for a removed provider config.
   *
   * Failures are swallowed with a warning so that a missing credential
   * handler never blocks provider config deletion.
   * @param providerConfigId - Provider config ID whose credentials should be removed.
   */
  public async cleanupDeletedProviderCredentials(providerConfigId: string): Promise<void> {
    try {
      await this.bus.requestOptional(CredentialSubjects.delete, { configId: providerConfigId });
    } catch (error) {
      console.warn(
        `[AdapterProviderConfigService] Failed to delete credentials for removed provider config "${providerConfigId}":`,
        error,
      );
    }
  }

  /**
   * Resolve the canonical provider config name from the definition and caller input.
   * @param definitionId - Provider definition ID.
   * @param name - Caller-supplied display name.
   * @returns Trimmed name or a derived fallback from the provider definition.
   */
  public async resolveProviderConfigName(definitionId: string, name?: string): Promise<string> {
    const provider = await this.getProviderDefinitionOrThrow(definitionId);
    const resolvedName = resolveCanonicalProviderConfigName({
      requestedName: name,
      providerName: provider.name,
      definitionId,
    });
    if (resolvedName) {
      return resolvedName;
    }

    throw new Error(`Unable to derive a canonical provider config name for definition: ${definitionId}`);
  }

  /**
   * Fetch a provider definition from the bus or throw when not found.
   * @param definitionId - Provider definition ID.
   * @returns Provider definition record.
   */
  public async getProviderDefinitionOrThrow(definitionId: string) {
    const { provider } = await this.bus.request(ProviderStorageSubjects.get, { id: definitionId });
    if (!provider) {
      throw new Error(`Provider definition not found: ${definitionId}`);
    }

    return provider;
  }

  /**
   * Select a keeper model for allowlist mode.
   *
   * When switching to `allowlist` filter mode, at least one model must remain
   * visible. This method returns a keeper candidate if no existing visibility
   * entry already satisfies the requirement.
   * @param definitionId - Provider definition ID.
   * @param existing - Existing provider config file.
   * @param preferredModel - Optional preferred keeper model.
   * @returns Keeper model name, or `undefined` when no promotion is required.
   */
  public async selectAllowlistKeeper(
    definitionId: string,
    existing: ProviderConfigFile,
    preferredModel?: string,
  ): Promise<string | undefined> {
    const { provider } = await this.bus.request(ProviderStorageSubjects.get, { id: definitionId });
    const modelNames = provider?.availableModels?.map((model) => model.name) ?? [];
    const candidates = [preferredModel, ...modelNames, ...Object.keys(existing.modelVisibility ?? {})].filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );

    for (const candidate of candidates) {
      const visibility = resolveModelVisibility(candidate, 'allowlist', existing.modelVisibility);
      if (visibility === 'enabled' || visibility === 'visible') {
        return undefined;
      }
    }

    return candidates[0];
  }
}
