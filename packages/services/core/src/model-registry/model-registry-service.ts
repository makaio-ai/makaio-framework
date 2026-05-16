import type { AIModel, ProviderAIModel } from '@makaio/contracts';
import { ModelRegistryPublicSubjects, type ModelRegistrySupportedModel } from '@makaio/contracts/model-registry';
import type { IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import { ModelRegistrySubjects } from './namespace.js';
import { type ModelRegistry, type ProviderModelOverride } from './schemas.js';
import type { IModelRegistryFetcher } from './types.js';
import { cloneModelMetadata, mergeModelMetadata } from './merge-utils.js';

/**
 * Options for creating a ModelRegistryService instance.
 */
export interface ModelRegistryServiceOptions {
  /**
   * The bus instance for registering handlers.
   */
  bus: IMakaioBus;

  /**
   * Fetcher implementation for retrieving the registry.
   *
   * Typically a {@link FallbackRegistryFetcher} chain that composes
   * user overrides, cached CDN, and bundled static sources.
   */
  fetcher: IModelRegistryFetcher;
}

/** Result of a registry fetch attempt after schema validation. */
interface RegistryFetchResult {
  /** Parsed registry returned by the fetcher chain. */
  registry: ModelRegistry;
  /** Whether the parsed registry committed into the service cache. */
  committed: boolean;
}

/** Error thrown when a provider definition is absent from the loaded model registry. */
export class ModelRegistryProviderNotFoundError extends Error {
  /** Stable provider definition identifier requested from the registry. */
  public readonly providerId: string;

  /**
   * Create a provider-not-found registry error.
   * @param providerId - Stable provider definition identifier that was missing.
   */
  public constructor(providerId: string) {
    super(`Provider "${providerId}" is not present in the model registry`);
    this.name = 'ModelRegistryProviderNotFoundError';
    this.providerId = providerId;
  }
}

/**
 * Service for managing model registry operations via bus handlers.
 *
 * Responsibilities:
 * - Resolve model registry through the injected fetcher (chain)
 * - Hold in-memory cache, deduplicate concurrent requests
 * - Register bus handlers for getForProvider, getLabModels, getProviderModels,
 *   checkModelInProviders, and refresh
 * - Emit modelRegistry.changed after a committed refresh
 * - Follow init/destroy lifecycle pattern with idempotent guards
 *
 * Schema validation (including `superRefine` cross-validation) is delegated to
 * the fetcher chain. The service trusts the registry returned by the fetcher.
 *
 * Caching and fallback logic lives in the fetcher chain, not here.
 * This service only manages in-memory state and bus wiring.
 * @example
 * ```typescript
 * const service = new ModelRegistryService({
 *   bus: MakaioBus,
 *   fetcher: new UserOverlayFetcher(
 *     userModelsDir,
 *     new FallbackRegistryFetcher([
 *       new CachedRegistryFetcher(new CdnRegistryFetcher(registryUrl), fileCache),
 *       new BundledSeedFetcher(seedPath),
 *     ]),
 *   ),
 * });
 * await service.init();
 * ```
 */
export class ModelRegistryService extends BaseService {
  private readonly fetcher: IModelRegistryFetcher;
  private registry: ModelRegistry | null = null;
  private labModelIndex: Map<string, AIModel> | null = null;
  private fetchPromise: Promise<RegistryFetchResult> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private fetchGeneration = 0;

  /**
   * Creates a new ModelRegistryService instance.
   * @param options - Service configuration options
   */
  public constructor(options: ModelRegistryServiceOptions) {
    super(options.bus);
    this.fetcher = options.fetcher;
  }

  /**
   * Register bus handlers for model registry operations.
   */
  protected onInit(): void {
    this.registerHandler(ModelRegistrySubjects.getForProvider, async (ctx) => {
      const { providerId, model: providerModelId } = ctx.payload;
      const { registry, index } = await this.ensureRegistryWithIndex();
      const model = this.resolveProviderModel(registry, index, providerId, providerModelId);
      ctx.setResult({ model });
    });

    this.registerHandler(ModelRegistrySubjects.getLabModels, async (ctx) => {
      const { labId } = ctx.payload;
      const { registry } = await this.ensureRegistryWithIndex();
      const labEntry = registry.labs[labId];
      ctx.setResult({ models: labEntry?.models.map((model) => this.cloneModel(model)) ?? [] });
    });

    this.registerHandler(ModelRegistrySubjects.getProviderModels, async (ctx) => {
      const { providerId } = ctx.payload;
      const { registry, index } = await this.ensureRegistryWithIndex();
      const models = this.resolveAllProviderModels(registry, index, providerId);
      ctx.setResult({ models });
    });

    this.registerHandler(ModelRegistryPublicSubjects.supportedModels, async (ctx) => {
      const { registry, index } = await this.ensureRegistryWithIndex();
      ctx.setResult({ models: this.resolveSupportedModels(registry, index) });
    });

    this.registerHandler(ModelRegistrySubjects.checkModelInProviders, async (ctx) => {
      const { providerIds, model: canonicalModelName } = ctx.payload;
      const { registry, index } = await this.ensureRegistryWithIndex();
      const matches: Record<string, ProviderAIModel> = {};
      for (const providerId of providerIds) {
        const model = this.resolveProviderModelByCanonicalName(registry, index, providerId, canonicalModelName);
        if (model !== undefined) {
          matches[providerId] = model;
        }
      }
      ctx.setResult({ matches });
    });

    this.registerHandler(ModelRegistrySubjects.refresh, async (ctx) => {
      try {
        await this.refreshRegistry();
        ctx.setResult({ success: true });
      } catch (error) {
        ctx.setResult({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  /**
   * Clear in-memory registry cache on destroy.
   */
  protected onDestroy(): void {
    this.fetchGeneration += 1;
    this.registry = null;
    this.labModelIndex = null;
    this.fetchPromise = null;
    this.refreshPromise = null;
  }

  /**
   * Ensure registry is loaded, fetching if necessary.
   *
   * Resolution order:
   * 1. In-memory (this.registry) — instant
   * 2. Fetcher chain — delegates all source resolution and caching
   *
   * Concurrent requests share a single fetch promise to avoid redundant work.
   * Returns both the registry and a lab model index that is coherent with it.
   * When the registry was committed (the common case), the cached index is
   * returned directly. For in-flight stale fetches that committed to a
   * different generation, the index is built on-demand from the returned
   * registry so callers always receive a consistent pair.
   * @returns Registry and coherent lab model index.
   * @throws Error when the registry cannot be loaded from any configured source.
   */
  private async ensureRegistryWithIndex(): Promise<{ registry: ModelRegistry; index: Map<string, AIModel> }> {
    if (this.registry !== null) {
      return { registry: this.registry, index: this.labModelIndex! };
    }

    if (this.fetchPromise !== null) {
      const result = await this.fetchPromise;
      const index = this.labModelIndex ?? this.buildLabModelIndex(result.registry);
      return { registry: result.registry, index };
    }

    const generation = this.fetchGeneration;
    const fetchPromise = this.startRegistryFetch(generation);
    this.fetchPromise = fetchPromise;

    const result = await fetchPromise;
    const index = this.labModelIndex ?? this.buildLabModelIndex(result.registry);
    return { registry: result.registry, index };
  }

  /**
   * Refresh the registry from the fetcher chain.
   *
   * If a registry fetch is already active, refresh joins that fetch instead
   * of starting a competing one. Otherwise it clears in-memory state so the
   * full fetcher chain is re-evaluated.
   * @throws Error if the fetcher chain fails
   */
  private async refreshRegistry(): Promise<void> {
    if (this.refreshPromise !== null) {
      await this.refreshPromise;
      return;
    }

    const refreshPromise =
      this.fetchPromise !== null ? this.awaitActiveFetchForRefresh(this.fetchPromise) : this.runRefresh();
    this.refreshPromise = refreshPromise;

    try {
      await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = null;
      }
    }
  }

  /**
   * Await an active registry fetch on behalf of a refresh request.
   * @param fetchPromise - Active registry fetch to share with the refresh.
   * @throws Error if the fetcher chain fails or the shared fetch cannot commit.
   */
  private async awaitActiveFetchForRefresh(fetchPromise: Promise<RegistryFetchResult>): Promise<void> {
    const result = await fetchPromise;
    if (!result.committed) {
      throw new Error('Model registry refresh completed without committing a registry');
    }
    await this.emitRegistryChanged();
  }

  /**
   * Run the single active forced refresh when no registry fetch is in flight.
   * @throws Error if the fetcher chain fails or the refresh cannot commit.
   */
  private async runRefresh(): Promise<void> {
    const generation = this.fetchGeneration + 1;
    this.fetchGeneration = generation;
    this.registry = null;
    this.labModelIndex = null;
    const fetchPromise = this.startRegistryFetch(generation);
    this.fetchPromise = fetchPromise;
    const result = await fetchPromise;
    if (!result.committed) {
      throw new Error('Model registry refresh completed without committing a registry');
    }
    await this.emitRegistryChanged();
  }

  /**
   * Notify subscribers that the committed model registry changed.
   */
  private async emitRegistryChanged(): Promise<void> {
    try {
      await this.bus.emit(ModelRegistrySubjects.changed, {});
    } catch (error) {
      console.warn('[ModelRegistryService] Failed to notify model registry change:', error);
    }
  }

  /**
   * Start the single active fetch for a registry generation.
   *
   * Both initial loads and forced refreshes install the promise returned here
   * as {@link fetchPromise}. That keeps one owner per generation: concurrent
   * requests await the same fetch and stale generations cannot clear a newer
   * active fetch.
   * @param generation - The generation captured at fetch start.
   * @returns Parsed model registry and whether it committed for the requested generation.
   */
  private startRegistryFetch(generation: number): Promise<RegistryFetchResult> {
    // Wrap in a ref so the finally block can safely compare against this promise
    // without the TS2454 "used before assigned" false positive that arises from
    // a const-scoped IIFE self-reference.
    const ref: { promise: Promise<RegistryFetchResult> | null } = { promise: null };

    ref.promise = (async () => {
      try {
        const registry = await this.fetcher.fetch();
        const committed = this.commitRegistry(generation, registry);
        return { registry, committed };
      } finally {
        if (generation === this.fetchGeneration && this.fetchPromise === ref.promise) {
          this.fetchPromise = null;
        }
      }
    })();

    return ref.promise;
  }

  /**
   * Commit a freshly parsed registry if the service generation is still current.
   *
   * Generation bumps on destroy() invalidate in-flight fetches and prevent
   * stale data from repopulating the cache after teardown. Also builds and
   * caches the lab model index so per-request calls to `getProviderModels` and
   * `getForProvider` avoid redundant iteration over the full lab list.
   * @param generation - The generation captured at fetch start.
   * @param registry - The parsed registry to commit.
   * @returns True when the registry was committed, false when the result was stale.
   */
  private commitRegistry(generation: number, registry: ModelRegistry): boolean {
    if (generation !== this.fetchGeneration) {
      return false;
    }

    this.registry = registry;
    this.labModelIndex = this.buildLabModelIndex(registry);
    return true;
  }

  /**
   * Resolve a single model for a provider by merging lab definition with provider overrides.
   * @param registry - The current model registry.
   * @param index - Lab model index coherent with the registry.
   * @param providerId - The provider identifier.
   * @param providerModelId - The provider-native model identifier to resolve.
   * @returns The merged model descriptor, or `undefined` if not found.
   */
  private resolveProviderModel(
    registry: ModelRegistry,
    index: Map<string, AIModel>,
    providerId: string,
    providerModelId: string,
  ): ProviderAIModel | undefined {
    const providerEntry = registry.providers[providerId];
    if (!providerEntry) return undefined;

    const overrides = providerEntry.models[providerModelId];
    if (overrides === undefined) return undefined;

    const labModel = index.get(overrides.canonicalModel ?? providerModelId);
    if (!labModel) return undefined;

    return this.mergeModel(providerModelId, labModel, overrides);
  }

  /**
   * Resolve the provider offering that corresponds to a canonical lab model name.
   * @param registry - The current model registry.
   * @param index - Lab model index coherent with the registry.
   * @param providerId - The provider identifier.
   * @param canonicalModelName - Canonical lab model name to check.
   * @returns The merged provider model descriptor, or `undefined` if not found.
   */
  private resolveProviderModelByCanonicalName(
    registry: ModelRegistry,
    index: Map<string, AIModel>,
    providerId: string,
    canonicalModelName: string,
  ): ProviderAIModel | undefined {
    const providerEntry = registry.providers[providerId];
    if (!providerEntry) return undefined;

    for (const [providerModelId, overrides] of Object.entries(providerEntry.models)) {
      if ((overrides.canonicalModel ?? providerModelId) !== canonicalModelName) {
        continue;
      }

      const labModel = index.get(canonicalModelName);
      if (!labModel) return undefined;
      return this.mergeModel(providerModelId, labModel, overrides);
    }

    return undefined;
  }

  /**
   * Resolve all models for a provider, each merged with its lab definition.
   * @param registry - The current model registry.
   * @param index - Lab model index coherent with the registry.
   * @param providerId - The provider identifier.
   * @returns Array of merged model descriptors for the provider.
   * @throws Error when the provider is not present in the registry.
   */
  private resolveAllProviderModels(
    registry: ModelRegistry,
    index: Map<string, AIModel>,
    providerId: string,
  ): ProviderAIModel[] {
    const providerEntry = registry.providers[providerId];
    if (!providerEntry) {
      throw new ModelRegistryProviderNotFoundError(providerId);
    }

    const models: ProviderAIModel[] = [];

    for (const [providerModelId, overrides] of Object.entries(providerEntry.models)) {
      const labModel = index.get(overrides.canonicalModel ?? providerModelId);
      if (labModel) {
        models.push(this.mergeModel(providerModelId, labModel, overrides));
      }
    }

    return models;
  }

  /**
   * Resolve SDK-safe model descriptors across every provider.
   * @param registry - The current model registry.
   * @param index - Lab model index coherent with the registry.
   * @returns Provider-tagged model descriptors for SDK introspection.
   */
  private resolveSupportedModels(registry: ModelRegistry, index: Map<string, AIModel>): ModelRegistrySupportedModel[] {
    const models: ModelRegistrySupportedModel[] = [];

    for (const providerId of Object.keys(registry.providers)) {
      for (const model of this.resolveAllProviderModels(registry, index, providerId)) {
        models.push({
          name: model.name,
          ...(model.friendlyName !== undefined && { friendlyName: model.friendlyName }),
          contextWindowSize: model.contextWindowSize,
          provider: providerId,
        });
      }
    }

    return models.sort((a, b) => {
      if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
      if (a.name === b.name) return 0;
      return a.name < b.name ? -1 : 1;
    });
  }

  /**
   * Build an index of all lab models keyed by name for efficient lookup.
   * @param registry - The current model registry.
   * @returns Map of model name to lab model descriptor.
   */
  private buildLabModelIndex(registry: ModelRegistry): Map<string, AIModel> {
    const index = new Map<string, AIModel>();
    for (const lab of Object.values(registry.labs)) {
      for (const model of lab.models) {
        index.set(model.name, model);
      }
    }
    return index;
  }

  /**
   * Merge a lab model with provider-specific overrides.
   *
   * Provider overrides replace lab values field-by-field.
   * Metadata merges at the top level, while provider `capabilities`
   * and `pricing` metadata replace the corresponding lab block whole.
   * The returned `name` is the provider-native model ID because that is the
   * identifier callers must send back to the provider API.
   * @param providerModelId - Provider-native model identifier.
   * @param labModel - The canonical model definition from the lab.
   * @param overrides - Provider-specific field overrides.
   * @returns The merged model descriptor.
   */
  private mergeModel(
    providerModelId: string,
    labModel: ProviderAIModel,
    overrides: ProviderModelOverride,
  ): ProviderAIModel {
    if (Object.keys(overrides).length === 0) {
      return { ...this.cloneProviderModel(labModel), name: providerModelId };
    }

    const { canonicalModel: _canonicalModel, metadata: providerMetadata, ...providerFields } = overrides;
    const merged: ProviderAIModel = {
      ...this.cloneProviderModel(labModel),
      ...providerFields,
      name: providerModelId,
    };
    if (providerFields.supportedReasoningLevels !== undefined) {
      merged.supportedReasoningLevels = { ...providerFields.supportedReasoningLevels };
    }
    const metadata = mergeModelMetadata(labModel.metadata, providerMetadata);

    if (metadata !== undefined) {
      merged.metadata = metadata;
    }

    return merged;
  }

  /**
   * Clone a provider-resolved model descriptor (with required `labId`).
   *
   * Delegates structural cloning to {@link cloneModel} and re-spreads `labId`
   * so TypeScript knows the result is a `ProviderAIModel`.
   * @param model - Cached provider model descriptor to clone.
   * @returns A structurally independent provider model descriptor.
   */
  private cloneProviderModel(model: ProviderAIModel): ProviderAIModel {
    return { ...this.cloneModel(model), labId: model.labId };
  }

  /**
   * Clone a model descriptor before returning it through in-process bus APIs.
   * @param model - Cached model descriptor to clone.
   * @returns A structurally independent model descriptor.
   */
  private cloneModel(model: AIModel): AIModel {
    const cloned: AIModel = { ...model };

    if (model.supportedReasoningLevels !== undefined) {
      cloned.supportedReasoningLevels = { ...model.supportedReasoningLevels };
    }

    if (model.metadata !== undefined) {
      cloned.metadata = cloneModelMetadata(model.metadata);
    }

    return cloned;
  }
}
