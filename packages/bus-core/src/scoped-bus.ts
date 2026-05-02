import type { MakaioBusContext } from './types/index.js';
import { createBusInstance } from './bus.js';
import { createFilteredBus, type IFilteredBus } from './filtered-bus.js';
import type { IScopedBusBase } from './scoped-bus-base.js';
import type { PayloadFilter, SubjectRecord, TypedPayloadFilter } from '@makaio/core';

/**
 * Scoped bus with namespace isolation and type-safe filtering.
 * @typeParam Namespace - The namespace domain string (e.g., 'adapter:codex-mcp')
 * @typeParam Subjects - SubjectRecord for payload types (used by on/once/emit)
 * @typeParam FilterPayload - Pre-computed intersection of all filterable payloads.
 *                            When provided, withFilter constrains filter keys to this type.
 */
export type ScopedBus<
  Namespace extends string,
  Subjects = SubjectRecord,
  FilterPayload = unknown,
> = IScopedBusBase<Namespace> & {
  /**
   * Create a filtered bus with a base payload filter.
   *
   * The filter is automatically applied to all `on()` and `once()` calls.
   *
   * When FilterPayload is known (via BusNamespace.scopedBus()), filter keys are
   * automatically constrained to the intersection of all subject payloads.
   * @param filter - Base filter to apply to all subscriptions
   * @returns FilteredBus with the specified filter
   * @example
   * ```typescript
   * // Type-safe filtering - keys auto-inferred from pre-computed FilterPayload
   * const scopedBus = await CodexMcpNamespace.scopedBus();
   * scopedBus.withFilter({ agentId: this.agentId }); // ✅ agentId validated
   * scopedBus.withFilter({ unknownKey: 'x' });       // ❌ Error - unknown key
   *
   * // Explicit type override still works
   * interface CustomPayload { agentId: string; sessionId: string }
   * scopedBus.withFilter<CustomPayload>({ agentId: 'x' });
   * ```
   */
  withFilter(filter: TypedPayloadFilter<FilterPayload>): IFilteredBus<Namespace, Subjects, FilterPayload>;

  /**
   * Get the bus context for advanced use cases.
   */
  getContext(): MakaioBusContext;
};

/**
 * Creates a scoped bus from a namespace object or namespace key.
 *
 * Accepts either a namespace object directly, a registered namespace key to look up,
 * or a string domain name. Returns a scoped bus that automatically prefixes all
 * subjects with the domain.
 * @param context - Makaio bus context
 * @param input - Namespace object, registered namespace key, or domain string
 * @returns Scoped bus instance for the specified namespace or domain
 */
export function createScopedBus<
  Namespace extends string,
  Subjects extends SubjectRecord = SubjectRecord,
  FilterPayload = unknown,
>(context: MakaioBusContext, input: Namespace): ScopedBus<Namespace, Subjects, FilterPayload> {
  const namespace = input;

  const bus = createBusInstance({ context, namespace });

  return {
    namespace,
    emit: bus.emit,
    on: bus.on,
    intercept: bus.intercept,
    once: bus.once,
    request: bus.request,
    requestOptional: bus.requestOptional,
    withFilter: (<_Payload>(filter: PayloadFilter) =>
      createFilteredBus<Namespace, Subjects, FilterPayload>(context, namespace, filter)) as ScopedBus<
      Namespace,
      Subjects,
      FilterPayload
    >['withFilter'],
    getContext: () => context,
  } as ScopedBus<Namespace, Subjects, FilterPayload>;
}
