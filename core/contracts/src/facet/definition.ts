import type { FacetNamespaceRegistration } from './schemas.js';

/**
 * A facet namespace definition with a serializable registration record.
 *
 * Created by {@link defineFacetNamespace}. The definition retains the original
 * options and produces a bus-transportable {@link FacetNamespaceRegistration}
 * via `toRegistration()`.
 *
 * The interface is intentionally opaque: only `namespace` is exposed directly
 * so that callers have a stable, lightweight handle on the definition.
 * All other properties (`cardinality`, `values`, `authority`, `appliesTo`,
 * `description`) are accessible exclusively through `toRegistration()`, which
 * also produces the serializable, bus-transportable snapshot. This design
 * avoids spreading raw mutable fields onto a long-lived definition object and
 * keeps the contract aligned with the bus registration shape.
 */
export interface FacetNamespaceDefinition {
  /** Unique namespace identifier (e.g., `'status'`, `'review-state'`). */
  readonly namespace: string;
  /**
   * Produces a serializable registration record suitable for bus transport.
   * @returns A {@link FacetNamespaceRegistration} snapshot with all array
   *   fields copied to prevent shared-reference mutation.
   */
  readonly toRegistration: () => FacetNamespaceRegistration;
}

/**
 * Options for {@link defineFacetNamespace}.
 *
 * Structurally identical to {@link FacetNamespaceRegistration} — every field
 * is included in the serializable registration output.
 */
type DefineFacetNamespaceOptions = FacetNamespaceRegistration;

/**
 * Creates a facet namespace definition with a serializable registration.
 *
 * The returned definition exposes the `namespace` identifier directly and
 * produces a bus-transportable {@link FacetNamespaceRegistration} via
 * `toRegistration()`. Array fields (`values`, `authority`, `appliesTo`) are
 * defensively copied so callers cannot mutate the registration snapshot.
 * @param options - Facet namespace registration options including cardinality,
 *   values, authority, and the entity classes the facet applies to.
 * @returns A {@link FacetNamespaceDefinition} with a `toRegistration` method.
 * @example
 * ```ts
 * export const statusFacet = defineFacetNamespace({
 *   namespace: 'status',
 *   cardinality: 'single',
 *   values: ['pending', 'processing', 'blocked', 'completed'],
 *   authority: ['system'],
 *   appliesTo: ['workpiece'],
 * });
 * ```
 */
export function defineFacetNamespace(options: DefineFacetNamespaceOptions): FacetNamespaceDefinition {
  return {
    namespace: options.namespace,
    toRegistration: (): FacetNamespaceRegistration => ({
      namespace: options.namespace,
      cardinality: options.cardinality,
      values: options.values === 'open' ? 'open' : [...options.values],
      authority: [...options.authority],
      appliesTo: [...options.appliesTo],
      ...(options.description !== undefined ? { description: options.description } : {}),
    }),
  };
}
