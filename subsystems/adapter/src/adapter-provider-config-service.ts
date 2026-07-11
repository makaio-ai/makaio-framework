import type { IMakaioBus } from '@makaio/bus-core';
import { CredentialSubjects } from '@makaio/contracts';
import { ProviderConfigAuthSchema } from '@makaio/contracts/auth';
import { resolveModelVisibility, type ModelFilterMode } from '@makaio/contracts/provider';
import {
  PROVIDER_CONFIG_SCHEMA_VERSION,
  type ProviderConfigFile,
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
  type ProviderConfigAuthInput,
  type ProviderConfigCreateInput,
  type ProviderConfigPatch,
  type RemoveBindingsResult,
  type SnapshotState,
} from './adapter-subsystem-types.js';

type ProviderConfigDefaultChange = { definitionId: string; configId: string | null };

/**
 * Resolve default status after an enabled-state patch.
 * @param configs - Snapshot provider configs.
 * @param id - Config being updated.
 * @param existing - Existing config value.
 * @param nextEnabled - Patched enabled state.
 * @returns Whether the updated config should be the definition default.
 */
function resolveUpdatedDefault(
  configs: ReadonlyMap<string, ProviderConfigFile>,
  id: string,
  existing: ProviderConfigFile,
  nextEnabled: boolean,
): boolean {
  const wasDefault = existing.isDefault ?? false;
  if (!nextEnabled) return false;
  if (wasDefault) return true;
  return ![...configs.entries()].some(
    ([candidateId, candidate]) =>
      candidateId !== id &&
      candidate.definitionId === existing.definitionId &&
      (candidate.enabled ?? true) &&
      (candidate.isDefault ?? false),
  );
}
import {
  assertProviderConfigAuthDefinitionsEnabled,
  validateProviderConfigAuth,
} from './provider-config-auth-validation.js';

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
    const provider = await this.getProviderDefinitionOrThrow(input.definitionId);
    const auth = ProviderConfigAuthSchema.parse(input.auth);
    const enabled = input.enabled ?? true;
    const validatedAuth = await validateProviderConfigAuth(this.bus, input.definitionId, auth, provider);
    if (enabled) {
      assertProviderConfigAuthDefinitionsEnabled(validatedAuth);
    }
    const name = this.resolveProviderConfigNameFromDefinition(input.definitionId, provider.name, input.name);
    const id = slugifyProviderConfigName(name);
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
          auth: structuredClone(auth),
          ...(input.managedBy ? { managedBy: { ...input.managedBy } } : {}),
          endpointOverrides,
          modelVisibility,
          modelFilterMode: input.modelFilterMode ?? 'show-all',
          isDefault:
            enabled &&
            ![...nextSnapshot.providerConfigs.values()].some(
              (config) =>
                config.definitionId === input.definitionId && (config.enabled ?? true) && (config.isDefault ?? false),
            ),
          enabled,
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
    let defaultChanged: ProviderConfigDefaultChange | undefined;
    const config = await this.configStore.commitSnapshotMutation(
      async (nextSnapshot) => {
        defaultChanged = await this.applyProviderConfigPatch(nextSnapshot, id, patch);
      },
      () => this.configStore.requireProviderConfig(id, 'update'),
    );
    await this.bus.emit(AdapterSubsystemSubjects.providerConfig.updated, config);
    if (defaultChanged) {
      await this.bus.emit(AdapterSubsystemSubjects.providerConfig.defaultChanged, defaultChanged);
    }
    return { config };
  }

  /**
   * Apply one normalized provider-config patch to a captured snapshot.
   * @param snapshot - Mutable snapshot owned by the serialized mutation.
   * @param id - Provider config being updated.
   * @param patch - Validated patch payload.
   * @returns Default-change event payload when default ownership changed.
   */
  private async applyProviderConfigPatch(
    snapshot: SnapshotState,
    id: string,
    patch: ProviderConfigPatch,
  ): Promise<ProviderConfigDefaultChange | undefined> {
    const existing = snapshot.providerConfigs.get(id);
    if (!existing) throw new Error(`Provider config not found: ${id}`);
    const nextName = patch.name ?? existing.name ?? existing.definitionId;
    if (patch.name !== undefined) this.configStore.assertProviderConfigNameUnique(nextName, id);
    const nextEnabled = patch.enabled ?? existing.enabled ?? true;
    if (nextEnabled && !(existing.enabled ?? true)) {
      const validatedAuth = await validateProviderConfigAuth(this.bus, existing.definitionId, existing.auth);
      assertProviderConfigAuthDefinitionsEnabled(validatedAuth);
    }
    const nextIsDefault = resolveUpdatedDefault(snapshot.providerConfigs, id, existing, nextEnabled);
    snapshot.providerConfigs.set(id, {
      ...existing,
      name: nextName,
      endpointOverrides:
        patch.endpointOverrides === null
          ? undefined
          : patch.endpointOverrides === undefined
            ? existing.endpointOverrides
            : cloneProviderEndpointOverrides(patch.endpointOverrides),
      modelVisibility:
        patch.modelVisibility === undefined
          ? existing.modelVisibility
          : cloneProviderModelVisibility(patch.modelVisibility),
      enabled: nextEnabled,
      isDefault: nextIsDefault,
    });
    if ((existing.isDefault ?? false) && !nextIsDefault) {
      return {
        definitionId: existing.definitionId,
        configId: this.configStore.promoteProviderConfigDefault(existing.definitionId, id, snapshot.providerConfigs),
      };
    }
    return !(existing.isDefault ?? false) && nextIsDefault
      ? { definitionId: existing.definitionId, configId: id }
      : undefined;
  }

  /**
   * Replace the complete normalized auth selection for one provider config.
   * @param id - Provider config ID.
   * @param authInput - Full replacement authentication selection.
   * @returns Updated provider config read model.
   */
  public async setProviderConfigAuth(
    id: string,
    authInput: ProviderConfigAuthInput,
  ): Promise<{ config: ProviderConfigFileRecord }> {
    const auth = ProviderConfigAuthSchema.parse(authInput);
    const config = await this.configStore.commitSnapshotMutation(
      async (nextSnapshot) => {
        const existing = nextSnapshot.providerConfigs.get(id);
        if (!existing) {
          throw new Error(`Provider config not found: ${id}`);
        }
        const validatedAuth = await validateProviderConfigAuth(this.bus, existing.definitionId, auth);
        if (existing.enabled ?? true) {
          assertProviderConfigAuthDefinitionsEnabled(validatedAuth);
        }
        nextSnapshot.providerConfigs.set(id, { ...existing, auth: structuredClone(auth) });
      },
      () => this.configStore.requireProviderConfig(id, 'auth update'),
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
    const managedConfig = await this.configStore.commitSnapshotMutation(
      (nextSnapshot) => {
        const existing = nextSnapshot.providerConfigs.get(id);
        if (!existing) {
          return;
        }
        if (existing.managedBy) {
          if (existing.enabled ?? true) {
            wasDefault = existing.isDefault ?? false;
            definitionId = existing.definitionId;
            nextSnapshot.providerConfigs.set(id, { ...existing, enabled: false, isDefault: false });
            promoted = wasDefault
              ? this.configStore.promoteProviderConfigDefault(existing.definitionId, id, nextSnapshot.providerConfigs)
              : null;
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
      () => (updatedConfigId ? this.configStore.requireProviderConfig(id, 'managed config disable') : null),
    );

    if (!deleted) {
      if (!updatedConfigId) {
        return { deleted: false };
      }
      await this.bus.emit(AdapterSubsystemSubjects.providerConfig.updated, managedConfig!);
      if (wasDefault) {
        await this.bus.emit(AdapterSubsystemSubjects.providerConfig.defaultChanged, {
          definitionId,
          configId: promoted,
        });
      }
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
    return this.resolveProviderConfigNameFromDefinition(definitionId, provider.name, name);
  }

  /**
   * Resolve a canonical provider-config name from an already loaded definition.
   * @param definitionId - Provider definition ID.
   * @param providerName - Display name from the provider definition.
   * @param name - Caller-supplied config name.
   * @returns Canonical display name.
   */
  private resolveProviderConfigNameFromDefinition(definitionId: string, providerName: string, name?: string): string {
    const resolvedName = resolveCanonicalProviderConfigName({
      requestedName: name,
      providerName,
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
