import * as methods from './methods/index.js';
import { createScopedBus } from './scoped-bus.js';
import { createFilteredBus } from './filtered-bus.js';
import { own as ownContextOf } from './call-context/carrier.js';
import { BusError } from './errors/bus-error.js';
import { resetSeenCorrelationIds } from './utils/invoke-any-handlers.js';
import { validateMessage } from './utils/message-safeguards.js';
import { extendSubjectImpl } from './extend-subject.js';
import { createBroadcastSend, createSendSurface } from './send-surface.js';
import type { NamespaceLease } from '@makaio/contracts/extension';
import type { TypedNamespace } from './registries/namespace-registry.js';
import type { IHostMakaioBus, IMakaioBus, MakaioBusContext } from './types/bus.js';
import type { BusNamespaceDefinition, PartyRef, PayloadFilter, SubjectDefinition, SubjectSchema } from '@makaio/core';

/**
 * Register on behalf of a carrier, recording the lease for a bulk call's rollback when requested.
 * @param definition - Namespace to register.
 * @param recordLease - Optional callback to record the acquired lease.
 * @returns The registered namespace.
 */
export type CarrierNamespaceRegistration = <Domain extends string, Schemas extends Record<string, SubjectSchema>>(
  definition: BusNamespaceDefinition<Domain, Schemas>,
  recordLease?: (lease: NamespaceLease) => void,
) => TypedNamespace<Domain, Schemas>;

/**
 * The transport lifecycle methods of a bus instance (`registerTransport`, `connect`, `ready`, ...).
 *
 * They hold per-context transport state (the transports registered through them, the
 * connect and ready handshake). Bus instances that share a context share one object of
 * this shape, so a carrier-bound instance never keeps a second copy of that state.
 */
export type BusTransportMethods = Pick<
  IMakaioBus,
  'registerTransport' | 'unregisterTransport' | 'disconnect' | 'reconnect' | 'connect' | 'ready'
>;

/** What the kernel knows about a bus instance built by {@link buildBusInstance}. */
interface BusInstanceRecord {
  readonly context: MakaioBusContext;
  readonly carrier: PartyRef;
  readonly transportMethods: BusTransportMethods;
}

/**
 * Instances built by {@link buildBusInstance}. A side table instead of a field on the bus
 * object, so the context is not reachable through the public bus surface.
 */
const instances = new WeakMap<object, BusInstanceRecord>();

/**
 * Look up the record of a bus instance.
 * @param bus - A bus instance.
 * @returns The record of the instance.
 * @throws BusError When `bus` was not built by `buildBusInstance`.
 */
function recordOf(bus: object): BusInstanceRecord {
  const record = instances.get(bus);
  if (record === undefined) {
    throw new BusError('Not a bus instance built by the bus core');
  }
  return record;
}

/**
 * Clear all handler registries for test isolation.
 * @param context - Bus context to reset.
 */
function resetAllHandlers(context: MakaioBusContext): void {
  context.eventHandlers.clear();
  context.requestHandlers.clear();
  context.interceptorHandlers.clear();
  context.anyHandlers.clear();
  context.messageObservers.clear();
  context.remoteRequestHandlers.clear();
  context.remoteEventHandlers.clear();
  resetSeenCorrelationIds();
}

/**
 * Build a bus instance bound to a carrier.
 *
 * The carrier is the caller of every message the instance sends and the owner of every
 * handler and interceptor it registers. Handler registries, namespaces and transports live
 * in the shared `context`; the carrier and the namespace are per instance. The instance
 * does not derive or check call contexts itself: it passes its carrier and the `call` of
 * the caller on to the entries in `methods/`.
 * @param context - Shared bus context.
 * @param carrier - The party this instance acts as.
 * @param transportMethods - Transport lifecycle methods of the context (shared by every instance of it).
 * @param namespace - Namespace scope of the instance, if any.
 * @param registerNamespace - Registration on behalf of the carrier, when supplied.
 * @returns The bus instance.
 */
export function buildBusInstance<Namespace extends string | unknown = undefined>(
  context: MakaioBusContext,
  carrier: PartyRef,
  transportMethods: BusTransportMethods,
  namespace?: Namespace,
  registerNamespace?: CarrierNamespaceRegistration,
): IHostMakaioBus<Namespace> {
  // The namespace domain as a string, for validation; any other domain (`unknown`) is unscoped.
  const scope = typeof namespace === 'string' ? namespace : undefined;
  const sendSurface = createSendSurface(context, carrier, scope);
  const register: CarrierNamespaceRegistration =
    registerNamespace ?? context.namespaceRegistry.registerNamespace.bind(context.namespaceRegistry);
  const bus: IHostMakaioBus<Namespace> = {
    namespace,
    on: (subject, handler, opts) => {
      validateMessage('on', subject, scope);
      return methods.on(context, carrier, subject, handler, opts);
    },
    intercept: (subject, handler, opts) => {
      validateMessage('intercept', subject, scope);
      return methods.intercept(context, carrier, subject, handler, opts);
    },
    once: (subject: SubjectDefinition, handler: unknown) => {
      validateMessage('once', subject, scope);
      return methods.once(context, carrier, subject, handler as never);
    },
    emit: sendSurface.emit as IMakaioBus<Namespace>['emit'],
    request: sendSurface.request as IMakaioBus<Namespace>['request'],
    requestOptional: sendSurface.requestOptional as IMakaioBus<Namespace>['requestOptional'],
    broadcast: createBroadcastSend(context, carrier, scope) as IMakaioBus<Namespace>['broadcast'],
    scoped: (input) => createScopedBus(context, input.name, carrier),
    withFilter: (filter: PayloadFilter) => createFilteredBus(context, scope ?? '', filter, carrier),
    own: (purpose) => ownContextOf(context, carrier, purpose),
    ...transportMethods,
    getSchema: (subject) => context.namespaceRegistry.getSchema(subject),
    registerNamespace: (definition) => register(definition),
    registerNamespaces: (definitions) => {
      const leases: NamespaceLease[] = [];
      try {
        for (const definition of definitions)
          register(definition as BusNamespaceDefinition, (lease) => leases.push(lease));
      } catch (error) {
        for (const lease of leases) lease.release();
        throw error;
      }
    },
    extendSubject: (subject, extensions) => {
      if (scope && subject.$meta.namespace !== scope)
        throw new Error(`Subject namespace ${subject.$meta.namespace} does not match scoped bus namespace ${scope}`);
      return extendSubjectImpl(context, subject, extensions);
    },
    observeMessages: (observer) => {
      context.messageObservers.add(observer);
      return () => {
        context.messageObservers.delete(observer);
      };
    },
    // Debugging/testing utilities
    __onAny: (handler) => {
      if (process.env.NODE_ENV === 'production') {
        return () => {}; // Noop in production
      }
      context.anyHandlers.add(handler);
      return () => {
        context.anyHandlers.delete(handler);
      };
    },
    __resetHandlers: process.env.NODE_ENV === 'test' ? () => resetAllHandlers(context) : undefined,
  } as IHostMakaioBus<Namespace>;

  // Object spread evaluates getters once at spread time and copies the resulting
  // value as a plain data property. `transportMethods.ready` would be frozen as
  // `Promise.resolve()` (its value when readyPromise is null) and would never
  // reflect the promise set during connect(). Re-define it as a live getter so
  // every read delegates to `transportMethods.ready`, which re-evaluates the
  // closure variable each time.
  Object.defineProperty(bus, 'ready', {
    get(): Promise<void> {
      return transportMethods.ready;
    },
    enumerable: true,
    configurable: true,
  });

  instances.set(bus, { context, carrier, transportMethods });
  return bus;
}

/**
 * Build a bus instance for another carrier on the context of `host`.
 *
 * The instance shares everything of the host's context: handler and interceptor
 * registries, namespaces, observers and the transport lifecycle methods (it has no
 * transport state of its own, and no second lifecycle emitter is installed). Only the
 * carrier differs: the instance sends as `carrier` and registers handlers owned by it.
 *
 * Kernel-internal: not exported from the package index.
 * @param host - Bus instance whose context is shared.
 * @param carrier - The party the new instance acts as.
 * @param registerNamespace - Carrier registration policy. Omitting it preserves host registration for trusted callers.
 * @returns A bus instance bound to `carrier` with the namespace of `host`.
 * @throws BusError When `host` was not built by `buildBusInstance`.
 */
export function createCarrierBus<Namespace extends string | unknown = unknown>(
  host: IMakaioBus<Namespace>,
  carrier: PartyRef,
  registerNamespace?: CarrierNamespaceRegistration,
): IMakaioBus<Namespace> {
  const { context, transportMethods } = recordOf(host);
  return buildBusInstance(context, carrier, transportMethods, host.namespace, registerNamespace);
}

/**
 * The shared context of a bus instance.
 *
 * For core modules only (scoped and filtered buses, channels, registries, kernel
 * composition). It is deliberately not exported from the package index or any public
 * entry: the context lets its holder build a sending bus for any carrier, and bus
 * instances no longer expose it. Works only for instances built by `buildBusInstance`.
 * @param bus - A bus instance.
 * @returns The context the instance runs on.
 * @throws BusError When `bus` was not built by `buildBusInstance`.
 */
export function busContextOf(bus: object): MakaioBusContext {
  return recordOf(bus).context;
}

/**
 * The carrier a bus instance is bound to.
 *
 * For core modules only (channels, registries, kernel composition). Like
 * {@link busContextOf} it is deliberately not exported from the package index or any
 * public entry. Works only for instances built by `buildBusInstance`.
 * @param bus - A bus instance.
 * @returns The party the instance acts as.
 * @throws BusError When `bus` was not built by `buildBusInstance`.
 */
export function busCarrierOf(bus: object): PartyRef {
  return recordOf(bus).carrier;
}
