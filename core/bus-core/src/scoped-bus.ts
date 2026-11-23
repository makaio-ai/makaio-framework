import type { MakaioBusContext } from './types/index.js';
import type { OnceOptions } from './methods/once.js';
import * as methods from './methods/index.js';
import { validateMessage } from './utils/message-safeguards.js';
import { createFilteredBus, type IFilteredBus } from './filtered-bus.js';
import type { IScopedBusBase } from './scoped-bus-base.js';
import { createSendSurface } from './send-surface.js';
import type {
  HandlerForSubjectDefinition,
  PartyRef,
  PayloadFilter,
  SubjectDefinition,
  SubjectRecord,
  TypedPayloadFilter,
} from '@makaio/core';

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
};

/**
 * Creates a scoped bus for a namespace on a shared bus context.
 *
 * The view shares the parent's context, and with it the parent's transport state; it
 * creates no lifecycle emitter and no transport state of its own. It keeps the parent's
 * carrier: the carrier owns the handlers registered through the view and is the caller of
 * everything sent through it. Its three send operations come from `createSendSurface`, which
 * resolves both call forms and enters `methods/` with the carrier.
 * @param context - Shared bus context of the parent bus
 * @param input - Namespace domain string; subjects of other namespaces are rejected
 * @param carrier - The carrier of the parent bus
 * @returns Scoped bus for the namespace
 */
export function createScopedBus<
  Namespace extends string,
  Subjects extends SubjectRecord = SubjectRecord,
  FilterPayload = unknown,
>(context: MakaioBusContext, input: Namespace, carrier: PartyRef): ScopedBus<Namespace, Subjects, FilterPayload> {
  const namespace = input;
  const sends = createSendSurface(context, carrier, namespace);

  const view: IScopedBusBase<Namespace> = {
    namespace,

    on(subject, handler, options) {
      validateMessage('on', subject, namespace);
      return methods.on(context, carrier, subject, handler, options);
    },

    intercept(subject, handler, options) {
      validateMessage('intercept', subject, namespace);
      return methods.intercept(context, carrier, subject, handler, options);
    },

    once: ((subject: SubjectDefinition, handlerOrOptions?: unknown) => {
      validateMessage('once', subject, namespace);

      // Callback version
      if (typeof handlerOrOptions === 'function') {
        return methods.once(context, carrier, subject, handlerOrOptions as HandlerForSubjectDefinition<typeof subject>);
      }

      // Promise version
      return methods.once(context, carrier, subject, handlerOrOptions as OnceOptions<typeof subject> | undefined);
    }) as IScopedBusBase<Namespace>['once'],

    emit: sends.emit as IScopedBusBase<Namespace>['emit'],
    request: sends.request as IScopedBusBase<Namespace>['request'],
    requestOptional: sends.requestOptional as IScopedBusBase<Namespace>['requestOptional'],
  };

  return {
    ...view,
    withFilter: (<_Payload>(filter: PayloadFilter) =>
      createFilteredBus<Namespace, Subjects, FilterPayload>(context, namespace, filter, carrier)) as ScopedBus<
      Namespace,
      Subjects,
      FilterPayload
    >['withFilter'],
  };
}
