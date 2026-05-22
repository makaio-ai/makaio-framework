import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import { type ProviderDefinition, CanonicalModelSubjects } from '@makaio/contracts';
import { slugifyProviderConfigName } from '@makaio/contracts/config';
import { AdapterSubsystemSubjects, type BindingRecord } from '../adapter-subsystem/index.js';
import { ModelRegistrySubjects } from '../model-registry/index.js';
import { CanonicalModelResolver } from './resolver.js';
import type { CanonicalModelResolverDeps, DefaultModelResolution } from './resolver-deps.js';

/**
 * A resolved candidate from the bare-model default resolution scan.
 *
 * Collected per adapter in {@link CanonicalModelService.collectAdapterCandidates}
 * and then deduplicated by executable route before a final resolution decision.
 */
interface DefaultModelCandidate {
  readonly adapterName: string;
  readonly definitionId: string;
  readonly providerConfigId: string;
  readonly qualifiedName: string;
  readonly model: string;
}

/**
 * Service that exposes framework canonical-model resolution via bus RPC.
 *
 * Wires {@link CanonicalModelResolver} dependencies to adapter-subsystem and
 * model-registry bus subjects and registers the `canonicalModel.resolve` handler.
 */
export class CanonicalModelService extends BaseService {
  /**
   * Creates a new CanonicalModelService instance.
   * @param bus - Bus instance for request/event handling
   */
  public constructor(bus: IMakaioBus = MakaioBus) {
    super(bus);
  }

  /**
   * Registers the canonical model resolution handler on the bus.
   */
  protected override async onInit(): Promise<void> {
    await this.bus.request(AdapterSubsystemSubjects.ensureReady, {});

    const deps = this.createDeps();
    const resolver = new CanonicalModelResolver(deps);

    this.registerHandler(CanonicalModelSubjects.resolve, async (ctx) => {
      const result = await resolver.resolve(ctx.payload.parsed, ctx.payload.context);
      ctx.setResult(result);
    });
  }

  /**
   * Creates resolver dependencies wired to adapter-subsystem and model-registry bus requests.
   * @returns Fully wired resolver dependency object
   */
  private createDeps(): CanonicalModelResolverDeps {
    const bus = this.bus;

    const listEnabledAdapterNames = async (): Promise<string[]> => {
      const { adapters } = await bus.request(AdapterSubsystemSubjects.listAdapters, {});
      return adapters.filter((adapter) => adapter.enabled).map((adapter) => adapter.name);
    };

    const getDefaultBinding = async (adapterName: string): Promise<BindingRecord | undefined> => {
      const [defaultBindingResult, enabledConfigIds] = await Promise.all([
        bus.request(AdapterSubsystemSubjects.getDefaultBinding, { adapterName }),
        this.listEnabledProviderConfigIds(),
      ]);

      if (defaultBindingResult.binding && enabledConfigIds.has(defaultBindingResult.binding.providerConfigId)) {
        return defaultBindingResult.binding;
      }

      const { bindings } = await bus.request(AdapterSubsystemSubjects.listBindings, { adapterName });
      const enabledBindings = bindings.filter((binding) => enabledConfigIds.has(binding.providerConfigId));
      const binding = enabledBindings.find((candidate) => candidate.isDefault) ?? enabledBindings[0];
      return binding;
    };

    /**
     * Get provider definitions for an adapter from the adapter subsystem.
     * @param adapterName - The adapter whose provider definitions to fetch.
     * @returns Array of provider definitions contributed by the adapter.
     */
    const getProviderDefinitions = async (adapterName: string): Promise<ProviderDefinition[]> => {
      const { definitions } = await bus.request(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, {
        adapterName,
      });
      return definitions;
    };

    const listBindingsForConfig = async (providerConfigId: string): Promise<BindingRecord[]> => {
      const { bindings } = await bus.request(AdapterSubsystemSubjects.listBindingsByConfig, {
        providerConfigId,
      });
      return bindings;
    };

    const findProviderConfigByName = async (name: string): Promise<{ readonly id: string } | undefined> => {
      const { configs } = await bus.request(AdapterSubsystemSubjects.listProviderConfigs, { enabled: true });
      const targetName = slugifyProviderConfigName(name);
      return configs.find((config) => slugifyProviderConfigName(config.name) === targetName);
    };

    const findProviderDefinition = this.buildFindProviderDefinition(listEnabledAdapterNames, getProviderDefinitions);
    const findDefaultConfigForDefinition = async (
      definitionId: string,
    ): Promise<{ readonly id: string } | undefined> => {
      const { configs } = await bus.request(AdapterSubsystemSubjects.listProviderConfigsByDefinition, {
        definitionId,
      });
      const enabledConfigs = configs.filter((config) => config.enabled);
      return enabledConfigs.find((config) => config.isDefault) ?? enabledConfigs[0];
    };
    const findConfigForDefinitionAndAdapter = async (
      definitionId: string,
      adapterName: string,
    ): Promise<{ readonly id: string } | undefined> => {
      const { config } = await bus.request(AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter, {
        definitionId,
        adapterName,
      });
      return config ? { id: config.id } : undefined;
    };
    const resolveDefaultModelTarget = this.buildResolveDefaultModelTarget(
      listEnabledAdapterNames,
      getProviderDefinitions,
      findConfigForDefinitionAndAdapter,
    );

    return {
      listEnabledAdapterNames,
      getDefaultBinding,
      findProviderConfigByName,
      findProviderDefinition,
      listBindingsForConfig,
      findDefaultConfigForDefinition,
      findConfigForDefinitionAndAdapter,
      resolveDefaultModelTarget,
    };
  }

  /**
   * Builds the `findProviderDefinition` dep function.
   * @param listEnabledAdapterNames - Dep for listing enabled adapter names
   * @param getProviderDefinitions - Dep for fetching provider definitions for an adapter
   * @returns Async function that finds a provider definition by ID
   */
  private buildFindProviderDefinition(
    listEnabledAdapterNames: () => Promise<string[]>,
    getProviderDefinitions: (adapterName: string) => Promise<ProviderDefinition[]>,
  ): (id: string, enabledAdapterNames?: readonly string[]) => Promise<ProviderDefinition | undefined> {
    return async (id: string, enabledAdapterNames?: readonly string[]): Promise<ProviderDefinition | undefined> => {
      const adapterNames = enabledAdapterNames ?? (await listEnabledAdapterNames());
      for (const adapterName of adapterNames) {
        const definitions = await getProviderDefinitions(adapterName);
        const definition = definitions.find((provider) => provider.id === id);
        if (definition) {
          return definition;
        }
      }
      return undefined;
    };
  }

  /**
   * Builds the `resolveDefaultModelTarget` dep function.
   *
   * Parallelises adapter definition fan-out, then issues a single batch
   * `checkModelInProviders` RPC instead of one `getForProvider` per provider.
   * Config look-ups are in-memory after the batch and are parallelised per
   * adapter so no sequential chaining occurs.
   * @param listEnabledAdapterNames - Dep for listing enabled adapter names
   * @param getProviderDefinitions - Dep for fetching provider definitions for an adapter
   * @param findConfigForDefinitionAndAdapter - Dep for finding a config bound to a specific adapter
   * @returns Async function that resolves a bare model name to a target
   */
  private buildResolveDefaultModelTarget(
    listEnabledAdapterNames: () => Promise<string[]>,
    getProviderDefinitions: (adapterName: string) => Promise<ProviderDefinition[]>,
    findConfigForDefinitionAndAdapter: (
      definitionId: string,
      adapterName: string,
    ) => Promise<{ readonly id: string } | undefined>,
  ): (model: string) => Promise<DefaultModelResolution> {
    const bus = this.bus;

    return async (model: string): Promise<DefaultModelResolution> => {
      const adapterNames = await listEnabledAdapterNames();
      const definitionsByAdapter = await Promise.all(
        adapterNames.map(async (adapterName) => ({
          adapterName,
          definitions: await getProviderDefinitions(adapterName),
        })),
      );

      const allProviderIds = Array.from(
        new Set(definitionsByAdapter.flatMap(({ definitions }) => definitions.map((d) => d.id))),
      );
      if (allProviderIds.length === 0) {
        return { kind: 'not-found' };
      }

      const { matches: registryMatches } = await bus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: allProviderIds,
        model,
      });

      const allCandidates = (
        await Promise.all(
          definitionsByAdapter.map(({ adapterName, definitions }) =>
            this.collectAdapterCandidates(
              adapterName,
              definitions,
              model,
              registryMatches,
              findConfigForDefinitionAndAdapter,
            ),
          ),
        )
      ).flat();

      return CanonicalModelService.buildResolution(allCandidates);
    };
  }

  /**
   * Collect candidates for a single adapter by filtering providers that have the
   * model in the registry and have a bound config for the adapter.
   * @param adapterName - The adapter being scanned
   * @param definitions - Provider definitions for the adapter
   * @param model - Bare model name being resolved
   * @param registryMatches - Set of provider IDs that have the model (from batch RPC)
   * @param findConfigForDefinitionAndAdapter - Dep for finding a config bound to a specific adapter
   * @returns Array of candidates for this adapter
   */
  private async collectAdapterCandidates(
    adapterName: string,
    definitions: ProviderDefinition[],
    model: string,
    registryMatches: Record<string, unknown>,
    findConfigForDefinitionAndAdapter: (
      definitionId: string,
      adapterName: string,
    ) => Promise<{ readonly id: string } | undefined>,
  ): Promise<DefaultModelCandidate[]> {
    const matchedProviders = definitions.filter((provider) => provider.id in registryMatches);
    const configs = await Promise.all(
      matchedProviders.map((provider) => findConfigForDefinitionAndAdapter(provider.id, adapterName)),
    );

    return matchedProviders.flatMap((provider, index) => {
      const config = configs[index];
      if (!config) return [];
      return [
        {
          adapterName,
          definitionId: provider.id,
          providerConfigId: config.id,
          qualifiedName: `${adapterName}/${provider.id}::${model}`,
          model,
        },
      ];
    });
  }

  /**
   * Build a {@link DefaultModelResolution} from a flat candidate list.
   *
   * Deduplicates by executable route identity, then classifies the result.
   * @param candidates - All matched candidates across all adapters
   * @returns Resolved, ambiguous, or not-found resolution
   */
  private static buildResolution(candidates: DefaultModelCandidate[]): DefaultModelResolution {
    // The executable target includes adapter and provider config identity; two
    // adapters exposing the same definition are distinct routes and must remain
    // ambiguous until the caller qualifies the model reference.
    const deduped = Array.from(new Map(candidates.map((c) => [this.routeKey(c), c] as const)).values());
    if (deduped.length === 0) return { kind: 'not-found' };
    if (deduped.length > 1) {
      return {
        kind: 'ambiguous',
        matches: deduped.map(({ adapterName, definitionId, qualifiedName }) => ({
          adapterName,
          definitionId,
          qualifiedName,
        })),
      };
    }
    const [match] = deduped;
    return {
      kind: 'resolved',
      target: {
        adapterName: match.adapterName,
        providerConfigId: match.providerConfigId,
        definitionId: match.definitionId,
        model: match.model,
      },
    };
  }

  /**
   * Build the stable identity for a bare-model execution route.
   * @param candidate - Candidate route to identify
   * @returns Route identity key
   */
  private static routeKey(candidate: DefaultModelCandidate): string {
    return `${candidate.adapterName}\0${candidate.definitionId}\0${candidate.providerConfigId}`;
  }

  /**
   * Load enabled provider config IDs from the adapter subsystem.
   * @returns Enabled provider config IDs
   */
  private async listEnabledProviderConfigIds(): Promise<Set<string>> {
    const { configs } = await this.bus.request(AdapterSubsystemSubjects.listProviderConfigs, { enabled: true });
    return new Set(configs.map((config) => config.id));
  }
}
