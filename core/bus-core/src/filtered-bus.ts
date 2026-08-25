/**
 * Filtered bus implementation for pre-configured payload filtering.
 *
 * Provides a bus wrapper that automatically applies payload filters to all
 * subscriptions.
 */

import type { MakaioBusContext, OnOptions } from './types/index.js';
import type { OnceOptions } from './methods/once.js';
import type { IScopedBusBase } from './scoped-bus-base.js';
import { on } from './methods/on.js';
import { once } from './methods/once.js';
import { emit } from './methods/emit.js';
import { request, requestOptional } from './methods/request.js';
import { intercept } from './methods/intercept.js';
import { validateMessage } from './utils/message-safeguards.js';
import { mergeFilters } from './utils/payload-filter.js';
import type { HandlerForSubjectDefinition, PayloadFilter, SubjectDefinition, TypedPayloadFilter } from '@makaio/core';

/**
 * Filtered bus that applies a base filter to all subscriptions.
 *
 * Created via `ScopedBus.withFilter()` or `FilteredBus.withFilter()`.
 * @typeParam Namespace - The namespace domain string
 * @typeParam Subjects - SubjectRecord for payload types (unused, for type consistency)
 * @typeParam FilterPayload - Pre-computed filter payload type for type-safe withFilter
 */
export interface IFilteredBus<Namespace extends string = string, Subjects = unknown, FilterPayload = unknown>
  extends IScopedBusBase<Namespace> {
  /**
   * Get the current base filter.
   */
  getFilter(): PayloadFilter | undefined;

  /**
   * Create a new FilteredBus with additional filter conditions merged in.
   * Later filters override earlier ones for the same path.
   *
   * When FilterPayload is known, filter keys are automatically type-checked.
   * @param filter - Additional filter conditions to merge
   * @returns New FilteredBus with merged filter
   * @example
   * ```typescript
   * // Type-safe filtering - keys validated against FilterPayload
   * const agentBus = bus.withFilter({ agentId: 'agent-123' }); // ✅
   * const badBus = bus.withFilter({ unknownKey: 'x' });        // ❌ Error
   *
   * // Explicit type override
   * interface CustomPayload { agentId: string; status: string }
   * const strictBus = bus.withFilter<CustomPayload>({ agentId: 'agent-123' });
   * ```
   */
  withFilter(filter: TypedPayloadFilter<FilterPayload>): IFilteredBus<Namespace, Subjects, FilterPayload>;
}

/**
 * Merge a base filter with a per-call filter and return the resolved options.
 *
 * Centralises the repeated pattern of merging `baseFilter` with an optional
 * per-call filter found in `options`, spreading the result back into the
 * options object only when there is an effective filter to apply.
 *
 * The `filter` key is typed as `Record<string, unknown>` to accommodate both
 * `PayloadFilter` (on/intercept options, required-value index signature) and
 * `TypedPayloadFilter<T>` (once options, optional-value mapped type). Both are
 * structurally compatible with `PayloadFilter` at runtime; the cast when
 * forwarding to `mergeFilters` is safe because `mergeFilters` treats all
 * values uniformly via `Object.entries`.
 * @param baseFilter - The bus-level base filter (may be undefined)
 * @param options - Per-call options object carrying an optional `filter`
 * @returns Resolved options with the merged filter applied, or the original
 *   options reference when no effective filter exists
 */
function resolveOptions<T extends { filter?: Record<string, unknown> }>(
  baseFilter: PayloadFilter | undefined,
  options: T | undefined,
): T | undefined {
  const effectiveFilter = mergeFilters(baseFilter, options?.filter as PayloadFilter | undefined);
  if (!effectiveFilter || Object.keys(effectiveFilter).length === 0) return options;
  return { ...options, filter: effectiveFilter } as T;
}

/**
 * Create a filtered bus instance.
 * @param context - Bus context
 * @param namespace - Namespace for validation
 * @param baseFilter - Base filter to apply to all subscriptions
 * @returns FilteredBus instance
 */
export function createFilteredBus<Namespace extends string, Subjects = unknown, FilterPayload = unknown>(
  context: MakaioBusContext,
  namespace: Namespace,
  baseFilter?: PayloadFilter,
): IFilteredBus<Namespace, Subjects, FilterPayload> {
  const filteredBus: IFilteredBus<Namespace, Subjects, FilterPayload> = {
    namespace,

    getFilter(): PayloadFilter | undefined {
      return baseFilter;
    },

    withFilter: (<_Payload = unknown>(filter: PayloadFilter) => {
      return createFilteredBus<Namespace, Subjects, FilterPayload>(
        context,
        namespace,
        mergeFilters(baseFilter, filter),
      );
    }) as IFilteredBus<Namespace, Subjects, FilterPayload>['withFilter'],

    on(subject, handler, options) {
      validateMessage('on', subject, namespace);
      return on(context, subject, handler, resolveOptions(baseFilter, options));
    },

    intercept(subject, handler, options) {
      validateMessage('intercept', subject, namespace);
      return intercept(context, subject, handler, resolveOptions(baseFilter, options));
    },

    once: ((subject: SubjectDefinition, handlerOrOptions?: unknown) => {
      validateMessage('once', subject, namespace);

      // Callback version
      if (typeof handlerOrOptions === 'function') {
        const handler = handlerOrOptions as HandlerForSubjectDefinition<typeof subject>;
        let unsubscribe: (() => void) | null = null;

        const wrappedHandler = ((ctx: unknown) => {
          // Clear local subscription before invoking user code. This guarantees
          // one-time semantics even when the handler throws.
          const unsub = unsubscribe;
          unsubscribe = null;
          unsub?.();
          return (handler as (ctx: unknown) => void | Promise<void>)(ctx);
        }) as HandlerForSubjectDefinition<typeof subject>;

        unsubscribe = on(context, subject, wrappedHandler, resolveOptions<OnOptions>(baseFilter, undefined));

        return () => {
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        };
      }

      // Promise version
      return once(
        context,
        subject,
        resolveOptions(baseFilter, handlerOrOptions as OnceOptions<typeof subject> | undefined),
      );
    }) as IFilteredBus<Namespace>['once'],

    // The base filter is a subscription concern, so it is deliberately absent
    // from the three dispatching methods below — but their option bags are not
    // this wrapper's to reinterpret either. Dropping `options` here would
    // silently rewrite routing: a caller that emitted local-only through this
    // bus would have the message relayed to every ready transport instead.
    async emit(subject, payload, options) {
      validateMessage('emit', subject, namespace);
      return emit(context, subject, payload, options);
    },

    async request(subject, payload, options) {
      validateMessage('request', subject, namespace);
      return request(context, subject, payload, options);
    },

    async requestOptional(subject, payload, options) {
      validateMessage('request', subject, namespace);
      return requestOptional(context, subject, payload, options);
    },
  };

  return filteredBus;
}
