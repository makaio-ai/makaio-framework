import type { ProviderDefinition } from '@makaio/contracts';
import type { BindingRecord } from '../adapter-subsystem/index.js';

/** A resolved model target from default chain resolution. */
export interface ResolvedDefaultTarget {
  readonly adapterName: string;
  readonly providerConfigId: string;
  readonly definitionId: string;
  readonly model: string;
}

/** An ambiguous match found during bare model resolution. */
export interface AmbiguousMatch {
  readonly adapterName: string;
  readonly definitionId: string;
  /** Fully qualified canonical string for the user to copy-paste. */
  readonly qualifiedName: string;
}

/** Result of bare model default resolution. */
export type DefaultModelResolution =
  | { readonly kind: 'resolved'; readonly target: ResolvedDefaultTarget }
  | { readonly kind: 'ambiguous'; readonly matches: AmbiguousMatch[] }
  | { readonly kind: 'not-found' };

/**
 * Dependencies for framework canonical-model resolution.
 *
 * All lookups are expressed as async functions. The service implementation
 * wires these to bus RPCs; tests can stub them directly.
 */
export interface CanonicalModelResolverDeps {
  /** List all enabled adapter names. */
  listEnabledAdapterNames(): Promise<string[]>;

  /**
   * Get the preferred binding for an adapter.
   * @param adapterName - The adapter to retrieve the default binding for
   */
  getDefaultBinding(adapterName: string): Promise<BindingRecord | undefined>;

  /**
   * Find a provider config by name (case-insensitive slug match). Returns minimal identity.
   * @param name - The provider config name to search for
   */
  findProviderConfigByName(name: string): Promise<{ readonly id: string } | undefined>;

  /**
   * Find a {@link ProviderDefinition} by ID.
   * @param id - The provider definition ID to look up
   * @param enabledAdapterNames - Optional enabled adapter names already loaded by the caller
   */
  findProviderDefinition(id: string, enabledAdapterNames?: readonly string[]): Promise<ProviderDefinition | undefined>;

  /**
   * Get all bindings for a given provider config ID.
   * @param providerConfigId - The provider config ID to list bindings for
   */
  listBindingsForConfig(providerConfigId: string): Promise<BindingRecord[]>;

  /**
   * Find the default provider config for a provider definition.
   *
   * Returns the config marked `isDefault` for the given definition,
   * falling back to the first enabled config when no default is set.
   * Only the config's `id` is consumed by the resolver.
   * @param definitionId - The provider definition ID to look up
   */
  findDefaultConfigForDefinition(definitionId: string): Promise<{ readonly id: string } | undefined>;

  /**
   * Find a provider config for a definition that is bound to a specific adapter.
   *
   * Searches enabled configs for the definition in preference order
   * (`isDefault` first), returning the first that has a binding to the
   * given adapter.
   * @param definitionId - The provider definition ID
   * @param adapterName - The adapter to require a binding for
   */
  findConfigForDefinitionAndAdapter(
    definitionId: string,
    adapterName: string,
  ): Promise<{ readonly id: string } | undefined>;

  /**
   * Resolve a bare model name to a target via the default chain.
   *
   * This is the seam for future framework-owned preference policies.
   * @param model - The bare model name to resolve
   */
  resolveDefaultModelTarget(model: string): Promise<DefaultModelResolution>;
}
