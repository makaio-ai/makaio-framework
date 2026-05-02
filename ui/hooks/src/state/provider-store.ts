/**
 * Provider Store - Single source of truth for provider state
 *
 * Manages the state for:
 * - Available provider configs list (fetched via `adapterSubsystem.listProviderConfigs`)
 * - Loading/error state
 *
 * Components should call `fetchProviders()` on mount and read from the store.
 * The store handles deduplication of concurrent fetches.
 * @packageDocumentation
 */

import { create } from 'zustand';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import type { AIModel, ModelFilterMode, ModelVisibility } from '@makaio/contracts';

/**
 * Fetch all enabled provider configs, enriched with model catalogs from the provider
 * definition table and canonical adapter binding data.
 * @returns Array of provider information for enabled configs
 */
async function fetchAllProviders(): Promise<ProviderInfo[]> {
  // Keep the store snapshot coherent: if any canonical read fails, reject the
  // fetch and let the caller retain its previous provider snapshot instead of
  // publishing half-empty adapter or model metadata.
  const [{ configs }, { configs: adapterConfigs }, { providers }] = await Promise.all([
    MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigs, { enabled: true }),
    MakaioBus.request(AdapterSubsystemSubjects.listAdapterConfigs, {}),
    MakaioBus.request(ProviderStorageSubjects.list, {}),
  ]);

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const bindingsByConfigId = new Map<string, BoundAdapter[]>();

  for (const adapterConfig of adapterConfigs) {
    if (!adapterConfig.enabled) {
      continue;
    }

    const displayLabel = adapterConfig.displayName ?? adapterConfig.name;
    for (const binding of adapterConfig.bindings) {
      const boundAdapter = {
        adapterName: binding.adapterName,
        displayLabel,
      } satisfies BoundAdapter;
      const existing = bindingsByConfigId.get(binding.providerConfigId);
      if (existing) {
        existing.push(boundAdapter);
      } else {
        bindingsByConfigId.set(binding.providerConfigId, [boundAdapter]);
      }
    }
  }

  const enriched = configs.map(
    (config) =>
      ({
        providerConfigId: config.id,
        definitionId: config.definitionId,
        name: config.name,
        availableModels: providerById.get(config.definitionId)?.availableModels ?? [],
        isDefault: config.isDefault,
        enabled: config.enabled,
        modelFilterMode: config.modelFilterMode,
        modelVisibility: config.modelVisibility,
        hasCredentials: config.hasCredentials,
        boundAdapters: bindingsByConfigId.get(config.id) ?? [],
      }) satisfies ProviderInfo,
  );

  return enriched;
}

/**
 * An adapter that is bound to a provider config.
 *
 * Used by the model picker to emit model×adapter combinations. The
 * `displayLabel` resolves to the adapter's human-readable display name.
 */
export interface BoundAdapter {
  /** Stable adapter driver name (e.g., `'claude-code'`, `'openai-node'`). */
  adapterName: string;
  /**
   * Human-readable label for display in picker UI.
   * Sourced from the canonical adapter config's `displayName`, falling back to
   * the stable adapter `name` when the display label is absent.
   */
  displayLabel: string;
}

/**
 * Runtime information about a configured provider instance.
 *
 * Each entry corresponds to one canonical provider-config record and carries
 * the model catalog sourced from the linked provider definition.
 */
export interface ProviderInfo {
  /**
   * Provider config UUID — stable identifier for this configuration instance.
   * Corresponds to `providerConfigId` in {@link AgentSelection}.
   */
  providerConfigId: string;
  /** FK to providers.id — links this config to the provider definition. */
  definitionId: string;
  /** Display name for UI, as configured by the user. */
  name: string;
  /** Available models sourced from the provider definition catalog. */
  availableModels: AIModel[];
  /** Whether this is the default config for its provider definition. */
  isDefault: boolean;
  /** Whether this config is enabled. */
  enabled: boolean;
  /** Controls default visibility for models without explicit overrides. */
  modelFilterMode: ModelFilterMode;
  /** True when at least one credential key exists in storage. */
  hasCredentials: boolean;
  /** Sparse per-model visibility overrides. */
  modelVisibility?: Record<string, ModelVisibility>;
  /**
   * Adapters currently bound to this provider config.
   *
   * Used by the model picker to enumerate model×adapter combinations for
   * selection. Empty when no adapters are bound.
   */
  boundAdapters: BoundAdapter[];
}

interface ProviderState {
  /** All available providers across all definitions */
  providers: ProviderInfo[];

  /** Loading state */
  isLoading: boolean;

  /** Error state */
  error: Error | null;

  /** Fetch in progress (for deduplication) */
  _fetchPromise: Promise<void> | null;

  /**
   * Whether providers have been fetched at least once.
   * Used to gate the stale-cache guard so `invalidate()` can force a refresh.
   */
  _hasFetched: boolean;

  /**
   * Monotonically increasing counter incremented on every `invalidate()` call.
   * In-flight fetches compare their captured generation against the current
   * value on completion — if they differ, the results are discarded so a
   * subsequent `fetchProviders()` can start a fresh fetch.
   */
  _fetchGeneration: number;

  /**
   * Fetch providers from all enabled provider configs. Idempotent — concurrent
   * calls share the same promise. No-ops when already fetched unless
   * `invalidate()` has been called first.
   */
  fetchProviders: () => Promise<void>;

  /**
   * Mark the provider list as stale so the next `fetchProviders()` call
   * triggers a real refetch. Call this after creating, updating, or deleting
   * a provider config.
   */
  invalidate: () => void;

  /** Set providers */
  setProviders: (providers: ProviderInfo[]) => void;

  /** Set error state */
  setError: (error: Error | null) => void;
}

// Not persisted: providers are derived from the bus on every fetch, so persistence
// would be a cache invalidation hazard. Use plain `create` rather than createPersistedStore.
export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  // TODO(provider-store-initial-state): The store uses two booleans (isLoading,
  // _hasFetched) plus the error field to encode four states: idle, loading,
  // ready, and error.
  // A cleaner model would be a single discriminated-union status field
  // ('idle' | 'loading' | 'ready' | 'error') so consumers can pattern-match
  // without coupling to the internal _hasFetched flag. Requires a coordinated
  // update to all consumers that currently check _hasFetched directly.
  //
  // isLoading starts false: consumers gate on _hasFetched to distinguish
  // "not yet fetched" from "actively loading". This avoids a permanent spinner
  // for consumers that read the store before fetchProviders() is dispatched.
  isLoading: false,
  error: null,
  _fetchPromise: null,
  _hasFetched: false,
  _fetchGeneration: 0,

  fetchProviders: async () => {
    const state = get();

    // Already fetched successfully and not invalidated - no-op
    if (state._hasFetched && !state.isLoading) {
      return Promise.resolve();
    }

    // Fetch already in progress - return existing promise (deduplication)
    if (state._fetchPromise) {
      return state._fetchPromise;
    }

    // Capture the current generation before starting the fetch. If invalidate()
    // is called while the fetch is in-flight, the generation will increment and
    // we will discard stale results rather than letting them gate future fetches.
    const generation = get()._fetchGeneration;

    // Start new fetch - set loading state and clear any previous error
    set({ isLoading: true, error: null });

    const promise = fetchAllProviders()
      .then((allProviders) => {
        // If invalidate() was called during the flight, discard results so that
        // the next fetchProviders() call triggers a fresh fetch.
        if (get()._fetchGeneration !== generation) {
          return;
        }
        console.debug(
          '[providerStore] providers:',
          allProviders.map((p) => ({
            providerConfigId: p.providerConfigId,
            definitionId: p.definitionId,
            name: p.name,
          })),
        );
        get().setProviders(allProviders);
      })
      .catch((err) => {
        // Mirror success-path stale generation guard: rejected promises from an
        // invalidated generation must not clobber error/loading state of the
        // newer active generation.
        if (get()._fetchGeneration !== generation) {
          return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        get().setError(error);
      })
      .finally(() => {
        // Clear only if this promise is still the tracked in-flight fetch.
        // Prevent stale (invalidated) flights from clobbering a newer fetch.
        set((state) => (state._fetchPromise === promise ? { _fetchPromise: null } : {}));
      });

    set({ _fetchPromise: promise });
    return promise;
  },

  invalidate: () => {
    set((state) => ({
      _hasFetched: false,
      _fetchPromise: null,
      _fetchGeneration: state._fetchGeneration + 1,
      isLoading: false,
    }));
  },

  setProviders: (providers) => {
    set({
      providers,
      isLoading: false,
      error: null,
      _hasFetched: true,
    });
  },

  setError: (error) => {
    set({ error, isLoading: false });
  },
}));
