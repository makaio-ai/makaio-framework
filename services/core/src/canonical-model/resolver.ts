import type {
  AgentResolutionContext,
  CanonicalModelResolvedSelection,
  ResolvableCanonicalModel,
} from '@makaio/contracts';
import type { BindingRecord } from '../adapter-subsystem/index.js';
import type { CanonicalModelResolverDeps } from './resolver-deps.js';
import { CanonicalModelResolutionError } from './errors.js';

/** Adapter selection returned by framework canonical-model resolution. */
export type ResolvedSelection = CanonicalModelResolvedSelection;

/**
 * Resolves a framework-resolvable canonical model to a concrete adapter selection.
 *
 * Uses the dependency interface for all lookups - bus wiring lives in the
 * service, not here.
 */
export class CanonicalModelResolver {
  /**
   * Creates a new resolver with the given dependency implementations.
   * @param deps - Lookup functions wired to bus RPCs or test stubs
   */
  public constructor(private readonly deps: CanonicalModelResolverDeps) {}

  /**
   * Resolve a parsed canonical model to a concrete adapter selection.
   * @param parsed - The parsed canonical model ref
   * @param _context - Optional resolution context reserved for future framework seams
   * @returns Resolved adapter selection
   * @throws CanonicalModelResolutionError when resolution fails
   */
  public async resolve(
    parsed: ResolvableCanonicalModel,
    _context?: AgentResolutionContext,
  ): Promise<ResolvedSelection> {
    switch (parsed.kind) {
      case 'bare':
        return this.resolveBare(parsed.model);
      case 'qualified':
        return this.resolveQualified(parsed.segment1, parsed.segment2, parsed.model);
    }
  }

  /**
   * Resolve a bare model name via the default chain.
   * @param model - Verbatim model identifier
   * @returns Adapter resolution for the matching model
   */
  private async resolveBare(model: string): Promise<ResolvedSelection> {
    const result = await this.deps.resolveDefaultModelTarget(model);

    switch (result.kind) {
      case 'resolved':
        return {
          kind: 'adapter',
          adapterName: result.target.adapterName,
          providerConfigId: result.target.providerConfigId,
          model: result.target.model,
        };

      case 'ambiguous':
        throw new CanonicalModelResolutionError(
          `Model "${model}" is available via multiple providers. Use a qualified reference to select one.`,
          'ambiguous-model',
          result.matches.map((match) => match.qualifiedName),
        );

      case 'not-found':
        throw new CanonicalModelResolutionError(
          `Model "${model}" was not found in any enabled adapter's registry.`,
          'model-not-found',
        );
    }
  }

  /**
   * Resolve a qualified model reference with one or two routing segments.
   * @param segment1 - First routing segment (lowercased by parser)
   * @param segment2 - Second routing segment when present (lowercased by parser)
   * @param model - Verbatim model name after `::`
   * @returns Adapter resolution for the matching target
   */
  private async resolveQualified(
    segment1: string,
    segment2: string | undefined,
    model: string,
  ): Promise<ResolvedSelection> {
    if (segment2 !== undefined) {
      return this.resolveQualifiedTwoSegments(segment1, segment2, model);
    }
    return this.resolveQualifiedOneSegment(segment1, model);
  }

  /**
   * Resolve a two-segment qualified reference: `adapter/provider::model`.
   * @param adapterSegment - Adapter name segment (lowercased)
   * @param providerSegment - Provider segment: config name or definition ID
   * @param model - Verbatim model name
   * @returns Adapter resolution with the verified adapter + provider + model
   */
  private async resolveQualifiedTwoSegments(
    adapterSegment: string,
    providerSegment: string,
    model: string,
  ): Promise<ResolvedSelection> {
    const enabledAdapters = await this.deps.listEnabledAdapterNames();
    if (!enabledAdapters.includes(adapterSegment)) {
      throw new CanonicalModelResolutionError(
        `Adapter "${adapterSegment}" is not enabled or does not exist.`,
        'adapter-not-found',
      );
    }

    const configId = await this.resolveProviderSegment(providerSegment, adapterSegment, enabledAdapters);

    return { kind: 'adapter', adapterName: adapterSegment, providerConfigId: configId, model };
  }

  /**
   * Resolve a single-segment qualified reference: `segment::model`.
   * @param segment - The single routing segment (lowercased)
   * @param model - Verbatim model name
   * @returns Adapter resolution using the matched adapter or provider
   */
  private async resolveQualifiedOneSegment(segment: string, model: string): Promise<ResolvedSelection> {
    const enabledAdapters = await this.deps.listEnabledAdapterNames();

    if (enabledAdapters.includes(segment)) {
      const binding = await this.deps.getDefaultBinding(segment);
      if (!binding) {
        throw new CanonicalModelResolutionError(
          `Adapter "${segment}" has no enabled provider binding. Configure or enable a provider binding first.`,
          'no-binding',
        );
      }
      return {
        kind: 'adapter',
        adapterName: segment,
        providerConfigId: binding.providerConfigId,
        model,
      };
    }

    const configByName = await this.deps.findProviderConfigByName(segment);
    if (configByName) {
      const binding = await this.pickBindingForConfig(configByName.id, enabledAdapters);
      return {
        kind: 'adapter',
        adapterName: binding.adapterName,
        providerConfigId: configByName.id,
        model,
      };
    }

    const definition = await this.deps.findProviderDefinition(segment, enabledAdapters);
    if (definition) {
      const config = await this.deps.findDefaultConfigForDefinition(definition.id);
      if (!config) {
        throw new CanonicalModelResolutionError(
          `Provider definition "${segment}" exists but has no configured provider config. Create a provider config first.`,
          'provider-not-found',
        );
      }
      const binding = await this.pickBindingForConfig(config.id, enabledAdapters);
      return { kind: 'adapter', adapterName: binding.adapterName, providerConfigId: config.id, model };
    }

    throw new CanonicalModelResolutionError(
      `"${segment}" does not match any enabled adapter name, provider config name, or provider definition ID.`,
      'adapter-not-found',
    );
  }

  /**
   * Resolve a provider segment (second routing segment) to a provider config ID.
   * @param providerSegment - Provider routing segment (lowercased)
   * @param adapterName - Adapter name already validated as enabled
   * @param enabledAdapters - Enabled adapter names already loaded by the caller
   * @returns The resolved provider config ID
   */
  private async resolveProviderSegment(
    providerSegment: string,
    adapterName: string,
    enabledAdapters?: readonly string[],
  ): Promise<string> {
    const configByName = await this.deps.findProviderConfigByName(providerSegment);
    if (configByName) {
      await this.requireBindingForAdapterAndConfig(adapterName, configByName.id, providerSegment);
      return configByName.id;
    }

    const definition = await this.deps.findProviderDefinition(providerSegment, enabledAdapters);
    if (definition) {
      const config = await this.deps.findConfigForDefinitionAndAdapter(definition.id, adapterName);
      if (!config) {
        throw new CanonicalModelResolutionError(
          `Provider definition "${providerSegment}" has no enabled config bound to adapter "${adapterName}". Create a provider config and binding first.`,
          'no-binding',
        );
      }
      return config.id;
    }

    throw new CanonicalModelResolutionError(
      `"${providerSegment}" does not match any provider config name or provider definition ID.`,
      'provider-not-found',
    );
  }

  /**
   * Verify that a binding exists between the given adapter and provider config.
   * @param adapterName - Adapter name to verify
   * @param configId - Provider config ID to verify
   * @param providerLabel - Human-readable label for the provider
   * @returns Void on success
   */
  private async requireBindingForAdapterAndConfig(
    adapterName: string,
    configId: string,
    providerLabel: string,
  ): Promise<void> {
    const bindings = await this.deps.listBindingsForConfig(configId);
    const hasBinding = bindings.some((binding) => binding.adapterName === adapterName);
    if (!hasBinding) {
      throw new CanonicalModelResolutionError(
        `No binding exists between adapter "${adapterName}" and provider "${providerLabel}". Create a binding first.`,
        'no-binding',
      );
    }
  }

  /**
   * Pick the best enabled binding for a provider config.
   * @param configId - Provider config ID to find bindings for
   * @param enabledAdapters - Adapter names currently enabled for resolution
   * @returns The preferred binding record among enabled adapters
   */
  private async pickBindingForConfig(configId: string, enabledAdapters: readonly string[]): Promise<BindingRecord> {
    const allBindings = await this.deps.listBindingsForConfig(configId);
    const bindings = allBindings.filter((binding) => enabledAdapters.includes(binding.adapterName));
    if (bindings.length === 0) {
      throw new CanonicalModelResolutionError(
        `Provider config "${configId}" has no bindings to enabled adapters. Bind it to an enabled adapter first.`,
        'no-binding',
      );
    }
    return bindings.find((binding) => binding.isDefault) ?? bindings[0];
  }
}
