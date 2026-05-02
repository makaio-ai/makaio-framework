import { type IMakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects, type ProviderContext } from '@makaio/contracts';
import {
  ADAPTER_FILE_SCHEMA_VERSION,
  type AdapterFile,
  type ProviderConfigFile,
  slugifyProviderConfigName,
} from '@makaio/contracts/config';
import {
  type AdapterFileConfig,
  type BindingRecord,
  type EffectiveAdapter,
  type IAdapterConfigRepository,
  type ProviderConfigFileRecord,
} from '@makaio/services-core/adapter-subsystem';
import {
  type AdapterConfigPatch,
  type RemoveBindingsResult,
  type SnapshotState,
  cloneAdapterSettings,
} from './adapter-subsystem-types.js';
import { commitSnapshotPersistence } from './adapter-config-snapshot-persistence.js';
import {
  buildAdapterConfigDerivedState,
  deriveProviderDefinitionIds,
  toBindingRecords,
} from './adapter-config-derived-state.js';
import { promoteEnabledBindingDefault, promoteEnabledProviderConfigDefault } from './binding-defaults.js';
import { buildProviderContextFromRaw } from './provider-runtime-view.js';
import { SnapshotMutationQueue } from './snapshot-mutation-queue.js';

/**
 * Constructor options for {@link AdapterConfigStore}.
 */
export interface AdapterConfigStoreOptions {
  /**
   * Repository seam for the canonical file-backed config tree.
   */
  readonly configRepository: IAdapterConfigRepository;
  /**
   * Bus instance used for capability queries and log-import invalidation subscriptions.
   */
  readonly bus: IMakaioBus;
}

/**
 * Owns all snapshot management, persistence, derived read-model state, and
 * read accessors for the adapter subsystem.
 *
 * This is a plain class — not a `BaseService` — created and held by the
 * facade. All state mutations are serialized through the internal
 * {@link SnapshotMutationQueue} so concurrent writes never race.
 */
export class AdapterConfigStore {
  private readonly configRepository: IAdapterConfigRepository;
  private readonly bus: IMakaioBus;

  private snapshot: SnapshotState = {
    providerConfigs: new Map(),
    adapters: new Map(),
  };
  private providerConfigRecords = new Map<string, ProviderConfigFileRecord>();
  private providerConfigSlugToId = new Map<string, string>();
  private adapterRecords = new Map<string, AdapterFileConfig>();
  private bindingsByAdapter = new Map<string, BindingRecord[]>();
  private bindingsByConfig = new Map<string, BindingRecord[]>();
  private defaultBindingByAdapter = new Map<string, BindingRecord | null>();
  private providerConfigIdsByDefinition = new Map<string, string[]>();
  private knownAdapterNames = new Set<string>();
  private logImportProviderKeysPromise: Promise<Set<string>> | null = null;
  private readonly snapshotMutationQueue = new SnapshotMutationQueue();

  /**
   * Create a new adapter config store.
   * @param options - Dependencies required by the store.
   */
  public constructor(options: AdapterConfigStoreOptions) {
    this.configRepository = options.configRepository;
    this.bus = options.bus;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load the canonical file snapshot and derive bus-safe read models.
   */
  public async loadSnapshot(): Promise<void> {
    const [providerConfigs, adapters] = await Promise.all([
      this.configRepository.loadProviderConfigs(),
      this.configRepository.loadAdapterConfigs(),
    ]);

    this.replaceSnapshot({
      providerConfigs: new Map(providerConfigs.configs),
      adapters: new Map(adapters.configs),
    });
  }

  /**
   * Register bus subscriptions that invalidate the log-import provider-keys
   * cache whenever capabilities change.
   *
   * Cleanup functions are forwarded to the provided registration callback so
   * the owning facade can manage teardown through its own lifecycle.
   * @param addCleanup - Callback that registers a teardown function.
   */
  public registerListeners(addCleanup: (fn: () => void) => void): void {
    const invalidate = (): void => {
      this.logImportProviderKeysPromise = null;
    };

    addCleanup(
      this.bus.on(CapabilitySubjects.register, invalidate, {
        filter: { capabilityId: 'log-import' },
      }),
    );
    addCleanup(
      this.bus.on(CapabilitySubjects.unregister, invalidate, {
        filter: { capabilityId: 'log-import' },
      }),
    );
  }

  /**
   * Clear all maps and reset snapshot state during teardown.
   */
  public clear(): void {
    this.snapshot = {
      providerConfigs: new Map(),
      adapters: new Map(),
    };
    this.providerConfigRecords.clear();
    this.providerConfigSlugToId.clear();
    this.adapterRecords.clear();
    this.bindingsByAdapter.clear();
    this.bindingsByConfig.clear();
    this.defaultBindingByAdapter.clear();
    this.providerConfigIdsByDefinition.clear();
    this.knownAdapterNames.clear();
    this.logImportProviderKeysPromise = null;
  }

  // ---------------------------------------------------------------------------
  // Snapshot internals
  // ---------------------------------------------------------------------------

  private replaceSnapshot(snapshot: SnapshotState): void {
    this.snapshot = snapshot;
    this.applyDerivedState();
  }

  private cloneSnapshot(): SnapshotState {
    return { providerConfigs: new Map(this.snapshot.providerConfigs), adapters: new Map(this.snapshot.adapters) };
  }

  public async commitSnapshotMutation(mutator: (nextSnapshot: SnapshotState) => void | Promise<void>): Promise<void>;
  public async commitSnapshotMutation<T>(
    mutator: (nextSnapshot: SnapshotState) => void | Promise<void>,
    capture: () => T | Promise<T>,
  ): Promise<T>;
  public async commitSnapshotMutation<T>(
    mutator: (nextSnapshot: SnapshotState) => void | Promise<void>,
    capture?: () => T | Promise<T>,
  ): Promise<T | void> {
    return await this.snapshotMutationQueue.run(async () => {
      const nextSnapshot = this.cloneSnapshot();
      await mutator(nextSnapshot);
      await this.commitSnapshot(nextSnapshot);
      return await capture?.();
    });
  }

  private async commitSnapshot(nextSnapshot: SnapshotState): Promise<void> {
    await commitSnapshotPersistence(this.configRepository, this.snapshot, nextSnapshot);
    this.replaceSnapshot(nextSnapshot);
  }

  /**
   * Build all derived indexes from the current snapshot and assign them
   * atomically. Invalidates the log-import cache when the adapter set changes.
   */
  private applyDerivedState(): void {
    const derived = buildAdapterConfigDerivedState(this.snapshot);

    this.providerConfigRecords = derived.providerConfigRecords;
    this.providerConfigSlugToId = derived.providerConfigSlugToId;
    this.providerConfigIdsByDefinition = derived.providerConfigIdsByDefinition;
    this.adapterRecords = derived.adapterRecords;
    this.bindingsByAdapter = derived.bindingsByAdapter;
    this.bindingsByConfig = derived.bindingsByConfig;
    this.defaultBindingByAdapter = derived.defaultBindingByAdapter;

    const adapterSetChanged =
      derived.adapterNames.size !== this.knownAdapterNames.size ||
      [...derived.adapterNames].some((name) => !this.knownAdapterNames.has(name));

    if (adapterSetChanged) {
      this.knownAdapterNames = derived.adapterNames;
      this.logImportProviderKeysPromise = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Read accessors
  // ---------------------------------------------------------------------------

  /**
   * Read a provider config in bus-safe form.
   * @param id - Provider config ID.
   * @returns Read model, or `null` when missing.
   */
  public getProviderConfig(id: string): ProviderConfigFileRecord | null {
    const config = this.providerConfigRecords.get(id);
    return config ? structuredClone(config) : null;
  }

  /**
   * Read a provider config or throw when missing.
   * @param id - Provider config ID.
   * @param action - Human-readable action label used in the error message.
   * @returns Provider config read model.
   */
  public requireProviderConfig(id: string, action: string): ProviderConfigFileRecord {
    const config = this.getProviderConfig(id);
    if (!config) {
      throw new Error(`Provider config could not be loaded after ${action}: ${id}`);
    }
    return config;
  }

  /**
   * Read an adapter config in bus-safe form.
   * @param name - Adapter name.
   * @returns Read model, or `null` when missing.
   */
  public getAdapterConfig(name: string): AdapterFileConfig | null {
    const config = this.adapterRecords.get(name);
    return config ? structuredClone(config) : null;
  }

  /**
   * Read an adapter config or throw when missing.
   * @param name - Adapter name.
   * @param action - Human-readable action label used in the error message.
   * @returns Adapter config read model.
   */
  public requireAdapterConfig(name: string, action: string): AdapterFileConfig {
    const config = this.getAdapterConfig(name);
    if (!config) {
      throw new Error(`Adapter config could not be loaded after ${action}: ${name}`);
    }
    return config;
  }

  /**
   * Return whether a named adapter is currently enabled in the file-backed snapshot.
   * @param adapterName - Adapter driver name.
   * @returns `true` when the config exists and `enabled` is truthy.
   */
  public isAdapterEnabled(adapterName: string): boolean {
    return this.getAdapterConfig(adapterName)?.enabled ?? false;
  }

  /**
   * List provider configs with optional enabled filtering.
   * @param enabled - Enabled filter.
   * @returns Bus-safe provider config records.
   */
  public listProviderConfigs(enabled?: boolean): ProviderConfigFileRecord[] {
    const configs = [...this.providerConfigRecords.values()].map((config) => structuredClone(config));
    return enabled === undefined ? configs : configs.filter((config) => config.enabled === enabled);
  }

  /**
   * List provider configs for a single definition.
   * @param definitionId - Provider definition ID.
   * @returns Bus-safe provider config records.
   */
  public listProviderConfigsByDefinition(definitionId: string): ProviderConfigFileRecord[] {
    return this.getProviderConfigIdsByDefinition(definitionId)
      .map((id) => this.getProviderConfig(id))
      .filter((config): config is ProviderConfigFileRecord => config !== null);
  }

  /**
   * List all adapter configs from the current snapshot.
   * @returns Bus-safe adapter config records.
   */
  public listAdapterConfigs(): AdapterFileConfig[] {
    return [...this.adapterRecords.values()].map((config) => structuredClone(config));
  }

  /**
   * List bindings for an adapter.
   * @param adapterName - Adapter name.
   * @returns Binding records.
   */
  public listBindings(adapterName: string): BindingRecord[] {
    return structuredClone(this.bindingsByAdapter.get(adapterName) ?? []);
  }

  /**
   * List bindings for a provider config.
   * @param providerConfigId - Provider config ID.
   * @returns Binding records.
   */
  public listBindingsByConfig(providerConfigId: string): BindingRecord[] {
    return structuredClone(this.bindingsByConfig.get(providerConfigId) ?? []);
  }

  /**
   * Return the default binding for an adapter.
   * @param adapterName - Adapter name.
   * @returns Default binding, or `null`.
   */
  public getDefaultBinding(adapterName: string): BindingRecord | null {
    const binding = this.defaultBindingByAdapter.get(adapterName) ?? null;
    return binding ? structuredClone(binding) : null;
  }

  /**
   * Find the provider config bound to a definition and adapter.
   * @param definitionId - Provider definition ID.
   * @param adapterName - Adapter name.
   * @returns Matching config, or `null`.
   */
  public findConfigForDefinitionAndAdapter(definitionId: string, adapterName: string): ProviderConfigFileRecord | null {
    const boundIds = new Set(
      (this.bindingsByAdapter.get(adapterName) ?? []).map((binding) => binding.providerConfigId),
    );
    const candidates = this.getProviderConfigIdsByDefinition(definitionId)
      .map((id) => this.providerConfigRecords.get(id))
      .filter(
        (config): config is ProviderConfigFileRecord =>
          config !== undefined && config.enabled && boundIds.has(config.id),
      );
    const result = candidates.find((config) => config.isDefault) ?? candidates[0] ?? null;
    return result ? structuredClone(result) : null;
  }

  /**
   * Return the raw provider config file for a given ID.
   *
   * Used by components that need access to raw credential and endpoint data
   * before conversion to the bus-safe read model.
   * @param id - Provider config ID.
   * @returns Raw provider config file, or `undefined` when missing.
   */
  public getRawProviderConfig(id: string): ProviderConfigFile | undefined {
    return this.snapshot.providerConfigs.get(id);
  }

  /**
   * Return the provider config IDs for a definition in snapshot order.
   * @param definitionId - Provider definition ID.
   * @returns Matching provider config IDs.
   */
  public getProviderConfigIdsByDefinition(definitionId: string): string[] {
    return [...(this.providerConfigIdsByDefinition.get(definitionId) ?? [])];
  }

  /**
   * Assert that a provider config slug is unique.
   * @param candidateName - Proposed provider config name.
   * @param excludeId - Optional config ID to ignore during the check.
   */
  public assertProviderConfigNameUnique(candidateName: string, excludeId?: string): void {
    const candidateSlug = slugifyProviderConfigName(candidateName);
    const conflictingId = this.providerConfigSlugToId.get(candidateSlug);
    if (conflictingId !== undefined && conflictingId !== excludeId) {
      const conflictingName = this.providerConfigRecords.get(conflictingId)?.name ?? conflictingId;
      throw new Error(
        `Provider config name "${candidateName}" conflicts with existing config "${conflictingName}": ` +
          `both slugify to "${candidateSlug}". Choose a different name.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Adapter config mutations
  // ---------------------------------------------------------------------------

  /**
   * Update adapter config fields.
   * @param name - Adapter name.
   * @param patch - Partial adapter patch.
   * @returns Updated adapter read model.
   */
  public async setAdapterConfig(name: string, patch: AdapterConfigPatch): Promise<{ config: AdapterFileConfig }> {
    const config = await this.commitSnapshotMutation(
      (nextSnapshot) => {
        const existing = nextSnapshot.adapters.get(name);
        nextSnapshot.adapters.set(name, this.buildNextAdapterFile(existing, patch));
      },
      () => this.requireAdapterConfig(name, 'update'),
    );

    return { config };
  }

  /**
   * @param existing - Current adapter file, if present.
   * @param patch - Adapter mutation payload.
   * @returns Next adapter file with schema version stamped.
   */
  public buildNextAdapterFile(existing: AdapterFile | undefined, patch: AdapterConfigPatch): AdapterFile {
    const base = existing ?? {};
    return {
      ...base,
      $schema: ADAPTER_FILE_SCHEMA_VERSION,
      ...this.applyAdapterPatch(existing, patch),
      bindings: existing?.bindings,
    };
  }

  /**
   * @param existing - Current adapter file, if present.
   * @param patch - Adapter mutation payload.
   * @returns Partial adapter file with only the patched fields set.
   */
  public applyAdapterPatch(existing: AdapterFile | undefined, patch: AdapterConfigPatch): Partial<AdapterFile> {
    const e: Partial<AdapterFile> = existing ?? {};
    const helpLinks = patch.helpLinks?.map((link) => ({ ...link })) ?? e.helpLinks;
    const providerDefinitionIds = patch.providerDefinitionIds
      ? [...patch.providerDefinitionIds]
      : e.providerDefinitionIds;
    return {
      enabled: patch.enabled ?? e.enabled ?? true,
      displayName: patch.displayName ?? e.displayName,
      description: patch.description ?? e.description,
      helpLinks,
      instructions: patch.instructions ?? e.instructions,
      clientId: patch.clientId ?? e.clientId,
      protocol: patch.protocol ?? e.protocol,
      providerDefinitionIds,
      settings: patch.settings !== undefined ? cloneAdapterSettings(patch.settings) : e.settings,
    };
  }

  /**
   * Update an adapter's enabled state.
   * @param name - Adapter name.
   * @param enabled - Enabled flag.
   */
  public async setAdapterEnabled(name: string, enabled: boolean): Promise<void> {
    await this.setAdapterConfig(name, { enabled });
  }

  // ---------------------------------------------------------------------------
  // Effective adapter building
  // ---------------------------------------------------------------------------

  /**
   * Build the effective adapter view from in-memory state.
   * @returns Effective adapter read models.
   */
  public async buildEffectiveAdapters(): Promise<EffectiveAdapter[]> {
    const logImportProviderKeys = await this.getLogImportProviderKeys();

    return [...this.adapterRecords.values()].map((adapter) => {
      const bindings = this.bindingsByAdapter.get(adapter.name) ?? [];
      const enabledBindings = bindings.filter(
        (binding) => this.providerConfigRecords.get(binding.providerConfigId)?.enabled,
      );
      const providerDefinitionIds = [
        ...(adapter.providerDefinitionIds ?? deriveProviderDefinitionIds(bindings, this.providerConfigRecords)),
      ];
      return {
        name: adapter.name,
        displayName: adapter.displayName ?? adapter.name,
        ...(adapter.description !== undefined ? { description: adapter.description } : {}),
        enabled: adapter.enabled,
        configCount: bindings.length,
        readiness: enabledBindings.length > 0 ? 'ready' : 'needs-setup',
        supportsLogImport: logImportProviderKeys.has(adapter.name),
        ...(adapter.helpLinks !== undefined ? { helpLinks: adapter.helpLinks.map((link) => ({ ...link })) } : {}),
        ...(adapter.instructions !== undefined ? { instructions: adapter.instructions } : {}),
        ...(adapter.clientId !== undefined ? { clientId: adapter.clientId } : {}),
        ...(adapter.protocol !== undefined ? { protocol: adapter.protocol } : {}),
        ...(adapter.providerDefinitionIds !== undefined || providerDefinitionIds.length > 0
          ? { providerDefinitionIds }
          : {}),
      };
    });
  }

  private async getLogImportProviderKeys(): Promise<Set<string>> {
    if (!this.logImportProviderKeysPromise) {
      const requestPromise: Promise<Set<string>> = this.bus
        .requestOptional(CapabilitySubjects.listProviders, {
          capabilityId: 'log-import',
        })
        .then((capabilityResult) => {
          if (!capabilityResult.handled) {
            if (this.logImportProviderKeysPromise === requestPromise) {
              this.logImportProviderKeysPromise = null;
            }
            return new Set<string>();
          }

          return new Set(capabilityResult.data.providers.map((provider) => provider.providerKey ?? provider.id));
        })
        .catch((error) => {
          this.logImportProviderKeysPromise = null;
          throw error;
        });
      this.logImportProviderKeysPromise = requestPromise;
    }

    return await this.logImportProviderKeysPromise;
  }

  // ---------------------------------------------------------------------------
  // Provider context
  // ---------------------------------------------------------------------------

  /**
   * Build the runtime provider context for one provider config.
   * @param providerConfigId - Provider config ID.
   * @returns Runtime provider context, or `null` when the config does not exist.
   */
  public async buildProviderContext(providerConfigId: string): Promise<ProviderContext | null> {
    const raw = this.snapshot.providerConfigs.get(providerConfigId);
    if (!raw) {
      return null;
    }
    return buildProviderContextFromRaw(this.bus, providerConfigId, raw);
  }

  // ---------------------------------------------------------------------------
  // Snapshot helpers used by provider config mutations
  // ---------------------------------------------------------------------------

  /**
   * Remove all bindings for a deleted provider config and promote defaults as needed.
   * @param providerConfigId - ID of the provider config being removed.
   * @param adapters - Mutable adapter map from the next snapshot.
   * @param providerConfigs - Mutable provider config map from the next snapshot.
   * @returns Mutation result containing changed adapters and affected binding records.
   */
  public removeBindingsForConfig(
    providerConfigId: string,
    adapters: Map<string, AdapterFile>,
    providerConfigs: Map<string, ProviderConfigFile>,
  ): RemoveBindingsResult {
    const changedAdapters = new Map<string, AdapterFile>();
    const deletedBindings: BindingRecord[] = [];
    const defaultChangedBindings: Array<{ adapterName: string; providerConfigId: string }> = [];

    for (const [name, raw] of adapters) {
      const bindings = toBindingRecords(name, raw.bindings);
      const targetIndex = bindings.findIndex((binding) => binding.providerConfigId === providerConfigId);
      if (targetIndex === -1) {
        continue;
      }

      const [removed] = bindings.splice(targetIndex, 1);
      if (removed) {
        deletedBindings.push(removed);
      }

      if (removed?.isDefault && bindings.length > 0) {
        const result = promoteEnabledBindingDefault(bindings, providerConfigs);
        bindings.splice(0, bindings.length, ...result.bindings);
        if (result.promoted) {
          defaultChangedBindings.push({ adapterName: name, providerConfigId: result.promoted.providerConfigId });
        }
      }

      changedAdapters.set(name, {
        ...raw,
        bindings: bindings.map(({ adapterName: _adapterName, ...rest }) => rest),
      });
    }

    return { changedAdapters, deletedBindings, defaultChangedBindings };
  }

  /**
   * Promote a new default provider config for a definition after deletion.
   * @param definitionId - Provider definition ID affected by removal.
   * @param excludedId - Provider config ID being removed.
   * @param providerConfigs - Mutable provider config map from the next snapshot.
   * @returns New default provider config ID, or `null` when no enabled candidate remains.
   */
  public promoteProviderConfigDefault(
    definitionId: string,
    excludedId: string,
    providerConfigs: Map<string, ProviderConfigFile>,
  ): string | null {
    return promoteEnabledProviderConfigDefault(definitionId, excludedId, providerConfigs);
  }
}
