/* eslint max-lines: ["error", { "max": 660 }] */ // Bumped for the debugLog diagnostic sink option
import type { ScopedBus } from './scoped-bus.js';
import { buildBusInstance, type BusTransportMethods } from './bus-instance.js';
import { hostPartyOf } from './call-context/carrier.js';
import type {
  BusMessageObserver,
  ConnectOptions,
  IHostMakaioBus,
  MakaioBusContext,
  TransportRegistration,
} from './types/bus.js';
import type { BusTransport } from './types/transports.js';
import type { HandlerEntry } from './types/handler-entry.js';
import type { InterceptorEntry, InterceptorHandler } from './types/interceptor.js';
import { createNamespaceRegistry, createTransportRegistry } from './registries/index.js';
import { resolveBusDebugLog } from './utils/debug-log.js';
import { createBusNamespace } from '@makaio/core';
import type { EventHandler, RequestHandler } from '@makaio/core';
import { LifecycleSchemas } from './lifecycle-schemas.js';
import { wireLifecycleEmitter } from './utils/wire-lifecycle-emitter.js';

/**
 * Creates a new bus context containing handler registries and shared state.
 *
 * Used internally by createBusInstance to manage event and request handlers.
 * Can be used to create isolated bus instances (e.g., for testing) by providing
 * separate handler maps per instance.
 * @param debugLog - Optional diagnostic sink; defaults to `console.debug`. Wrapped so it never throws.
 * @returns A new MakaioBusContext instance with empty handler registries
 */
export const createBusContext = (debugLog?: (message: string) => void): MakaioBusContext => {
  // Storage for event handlers (sorted by priority)
  const eventHandlers = new Map<string, Array<HandlerEntry<EventHandler<unknown>>>>();

  // Storage for request handlers (middleware chain, sorted by priority)
  const requestHandlers = new Map<string, Array<HandlerEntry<RequestHandler<unknown, unknown>>>>();

  // Storage for interceptor handlers (run BEFORE event/request handlers)
  const interceptorHandlers = new Map<string, Array<InterceptorEntry<InterceptorHandler<unknown>>>>();

  // Storage for __onAny handlers (debugging/testing)
  const anyHandlers = new Set<(ctx: unknown) => void | Promise<void>>();

  // Storage for production-capable message observers
  const messageObservers = new Set<BusMessageObserver>();

  const namespaceRegistry = createNamespaceRegistry();

  const context: MakaioBusContext = {
    eventHandlers,
    requestHandlers,
    interceptorHandlers,
    anyHandlers,
    messageObservers,
    // The registry needs the context object, so it is assigned immediately after construction.
    transportRegistry: undefined as never,
    namespaceRegistry,
    remoteRequestHandlers: new Map(),
    remoteEventHandlers: new Map(),
    remoteSubscriptionDeliveryClasses: new Map(),
    debugLog: resolveBusDebugLog(debugLog),
  };

  context.transportRegistry = createTransportRegistry(context);

  return context;
};

interface TransportEntry {
  transport: BusTransport;
  unregister: () => void;
  ready: Promise<void>;
}

interface TransportConnectErrorShape extends Error {
  code?: unknown;
  status?: unknown;
}

interface ReadyHandshake {
  promise: Promise<void>;
  cancelSignal: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  cancel: () => void;
  isCanceled: () => boolean;
}

/**
 * Creates transport registration helpers that track transports and unregister callbacks
 * by transport name.
 *
 * Tracks only transports registered by this bus instance so that `disconnect()` cannot
 * inadvertently tear down transports owned by another bus sharing the same context.
 * @param context - Bus context whose transport registry receives transport registrations
 * @returns Object with `registerTransport`, `unregisterTransport`, `disconnect`, `connect`, and `ready` methods
 */
// eslint-disable-next-line max-lines-per-function -- rollbackEntries helper inflates the count
const createTransportMethods = (context: MakaioBusContext): BusTransportMethods => {
  const localTransports = new Map<string, TransportEntry>();
  let connected = false;
  let connectPromise: Promise<void> | null = null;
  let readyPromise: Promise<void> | null = null;
  let activeReadyHandshake: ReadyHandshake | null = null;
  const hasActiveTransportLifecycle = (): boolean => connected || connectPromise !== null;

  const areEntriesCurrent = (entries: TransportEntry[]): boolean => {
    return entries.every((entry) => localTransports.get(entry.transport.name) === entry);
  };

  const rollbackEntries = async (entries: TransportEntry[]): Promise<void> => {
    for (const entry of entries) {
      try {
        entry.unregister();
      } catch (unregisterError) {
        console.error(`[bus.connect] Failed to unregister '${entry.transport.name}' during rollback:`, unregisterError);
      } finally {
        // Identity-guarded delete preserves concurrently registered replacements.
        if (localTransports.get(entry.transport.name) === entry) {
          localTransports.delete(entry.transport.name);
        }
      }
    }
    await Promise.allSettled(entries.map((entry) => entry.transport.disconnect())); // best-effort disconnect
  };

  const clearReadyPromise = (currentReadyPromise: Promise<void>): void => {
    if (readyPromise === currentReadyPromise) {
      readyPromise = null;
    }
  };

  const waitForPendingReady = async (options?: ConnectOptions): Promise<void> => {
    if (options?.awaitReady !== false && readyPromise) {
      await readyPromise;
    }
  };

  const createHandshakeReadyPromise = (): ReadyHandshake => {
    let canceled = false;
    let settled = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: unknown) => void;
    let resolveCancelSignal!: () => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolvePromise = promiseResolve;
      rejectPromise = promiseReject;
    });
    const cancelSignal = new Promise<void>((resolve) => {
      resolveCancelSignal = resolve;
    });

    // Internal lifecycle promise: suppress unhandled-rejection noise when a
    // connect attempt fails before any caller has chosen to await bus.ready.
    void promise.catch(() => undefined);

    return {
      promise,
      cancelSignal,
      resolve: () => {
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise();
      },
      reject: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        rejectPromise(error);
      },
      cancel: () => {
        if (canceled) {
          return;
        }
        canceled = true;
        resolveCancelSignal();
        if (!settled) {
          settled = true;
          resolvePromise();
        }
      },
      isCanceled: () => canceled,
    };
  };

  const wrapTransportConnectError = (transportName: string, error: unknown): Error => {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`Failed to connect transport "${transportName}": ${originalMessage}`, { cause: error });

    if (typeof error === 'object' && error !== null) {
      const original = error as TransportConnectErrorShape;
      const withMeta = wrapped as TransportConnectErrorShape;
      if ('code' in original) {
        withMeta.code = original.code;
      }
      if ('status' in original) {
        withMeta.status = original.status;
      }
    }

    return wrapped;
  };

  const rollbackStaleAttempt = async (entries: TransportEntry[], resolveReady: () => void): Promise<void> => {
    await rollbackEntries(entries);
    resolveReady();
  };

  const failAttempt = async (
    entries: TransportEntry[],
    currentReadyPromise: Promise<void>,
    rejectReady: (error: unknown) => void,
    error: unknown,
  ): Promise<void> => {
    rejectReady(error);
    clearReadyPromise(currentReadyPromise);
    await rollbackEntries(entries);
  };

  const createTransportReadyPromise = (entries: TransportEntry[], handshake: ReadyHandshake): Promise<void> => {
    const transportsReady = Promise.all(
      entries.map((entry) =>
        entry.ready.catch((readyError) => {
          console.error(`[bus.connect] Transport '${entry.transport.name}' ready failed:`, readyError);
          throw readyError;
        }),
      ),
    ).then(() => {});
    void transportsReady.catch(() => undefined);

    // disconnect() cancels the active ready handshake. Race that signal here so
    // callers awaiting connect()/bus.ready are not left hanging on a transport-
    // specific ready promise that will never settle after teardown.
    return Promise.race([transportsReady, handshake.cancelSignal]);
  };

  return {
    registerTransport: (transport): TransportRegistration => {
      if (hasActiveTransportLifecycle()) {
        throw new Error(
          `[bus.connect] Cannot register transport '${transport.name}' after connect() has started; create a new bus instance or use the shared transport registry directly`,
        );
      }

      const registration = context.transportRegistry.registerTransport(transport.name as never, transport as never);
      localTransports.set(transport.name, {
        transport,
        unregister: registration.unregister,
        // Getter: reads current transport.ready at await time, not the registration
        // snapshot (transports may replace ready per session in connectOnce()).
        get ready() {
          return transport.ready ?? registration.ready;
        },
      });
      return registration;
    },
    unregisterTransport: (name) => {
      const entry = localTransports.get(name);
      if (entry) {
        entry.unregister();
        localTransports.delete(name);
      }
    },
    get ready(): Promise<void> {
      return readyPromise ?? Promise.resolve();
    },
    // disconnect() must immediately make the bus appear inert to new callers.
    // In-flight connect attempts may still resolve later, so connect() guards
    // finalization with entry identity checks before mutating shared state.
    disconnect: () => {
      connected = false;
      activeReadyHandshake?.cancel();
      activeReadyHandshake = null;
      connectPromise = null;
      readyPromise = null;
      // Disconnect before unregister so sockets close before registry entries
      // are removed. Only affects transports registered by this bus instance.
      for (const { transport, unregister } of localTransports.values()) {
        try {
          void Promise.resolve(transport.disconnect()).catch(() => {
            // Best-effort — transport may already be closed.
          });
        } catch {
          // Best-effort — synchronous throw from disconnect().
        }
        unregister();
      }
      localTransports.clear();
    },
    reconnect: async (): Promise<void> => {
      const transportsWithReconnect = Array.from(localTransports.values()).filter(
        (entry): entry is TransportEntry & { transport: BusTransport & Required<Pick<BusTransport, 'reconnect'>> } =>
          typeof entry.transport.reconnect === 'function',
      );
      const results = await Promise.allSettled(
        transportsWithReconnect.map((entry) => Promise.resolve().then(() => entry.transport.reconnect())),
      );
      for (const [i, result] of results.entries()) {
        if (result.status === 'rejected') {
          console.error(
            `[bus] reconnect failed for transport '${transportsWithReconnect[i].transport.name}':`,
            result.reason,
          );
        }
      }
    },
    // eslint-disable-next-line max-lines-per-function -- connect() intentionally owns connection, readiness, and rollback coordination in one lifecycle boundary.
    connect: async (options?: ConnectOptions) => {
      // connect() is still a one-shot operation for the transport set owned by
      // this bus instance. Late/manual transport wiring uses the lower-level
      // transportRegistry.registerTransport() + transport.connect() path.
      //
      // A prior fast connect({ awaitReady: false }) may leave readyPromise
      // pending even though sockets are already open. In that case a later
      // default connect() should await the existing readiness handshake.
      if (connected) {
        await waitForPendingReady(options);
        return;
      }
      if (connectPromise) {
        await connectPromise;
        await waitForPendingReady(options);
        return;
      }

      const entries = Array.from(localTransports.values());
      if (entries.length === 0) return;

      const handshake = createHandshakeReadyPromise();
      readyPromise = handshake.promise;
      activeReadyHandshake = handshake;
      let finalizeReadyPromise: Promise<void> | null = null;
      let deferHandshakeCleanupToFinalizeReady = false;

      connectPromise = (async () => {
        try {
          await Promise.all(
            entries.map(async (e) => {
              try {
                await e.transport.connect();
              } catch (error) {
                throw wrapTransportConnectError(e.transport.name, error);
              }
            }),
          );
        } catch (error) {
          // Roll back partial connection so the bus does not retain transports
          // whose onReceive handlers were wired but never reached a usable session.
          await failAttempt(entries, handshake.promise, handshake.reject, error);
          throw error;
        }

        // disconnect() may have run while the transport connect phase was in
        // flight. Only the entries still owned by this attempt may finalize bus
        // state; stale attempts are rolled back and ignored.
        if (!areEntriesCurrent(entries)) {
          await rollbackStaleAttempt(entries, handshake.resolve);
          return;
        }

        connected = true;

        try {
          const transportReadyPromise = createTransportReadyPromise(entries, handshake);

          const finalizeReady = async (): Promise<void> => {
            if (!connected || handshake.isCanceled()) {
              return;
            }

            await transportReadyPromise;

            if (!connected || handshake.isCanceled()) {
              return;
            }

            if (!areEntriesCurrent(entries)) {
              await rollbackStaleAttempt(entries, handshake.resolve);
              return;
            }

            handshake.resolve();
          };

          if (options?.awaitReady !== false) {
            finalizeReadyPromise = finalizeReady();
            await finalizeReadyPromise;
          } else {
            // Attach a background rejection handler to prevent an unhandled promise
            // rejection and to roll back transports if readiness fails after connect()
            // has already returned.
            finalizeReadyPromise = finalizeReady();
            deferHandshakeCleanupToFinalizeReady = true;
            void finalizeReadyPromise
              .catch(async (error) => {
                console.error('[bus.connect] Background ready failed:', error);
                // Keep connected=true until rollback completes so that
                // hasActiveTransportLifecycle() remains true for the full
                // duration of the rollback window, preventing a new connect()
                // or registerTransport() from slipping through mid-teardown.
                await failAttempt(entries, handshake.promise, handshake.reject, error);
                connected = false;
              })
              .finally(() => {
                finalizeReadyPromise = null;
                if (activeReadyHandshake === handshake) {
                  activeReadyHandshake = null;
                }
              });
          }
        } catch (error) {
          connected = false;
          await failAttempt(entries, handshake.promise, handshake.reject, error);
          throw error;
        }
      })().finally(() => {
        connectPromise = null;
        if (!deferHandshakeCleanupToFinalizeReady && activeReadyHandshake === handshake) {
          activeReadyHandshake = null;
        }
        finalizeReadyPromise = null;
      });

      await connectPromise;
    },
  };
};

/**
 * Options for creating a bus instance.
 */
export interface CreateBusOptions<Namespace extends string | undefined = undefined> {
  /** Pre-created context. Omit for a fresh one. */
  context?: MakaioBusContext;
  /** Namespace scope (e.g. 'adapter:claudeCode'). */
  namespace?: Namespace;
  /** Transports to register immediately after creation. */
  transports?: BusTransport[];
  /**
   * Sink for internal bus diagnostics (subscription propagation and
   * subscribe-sync-complete failures, readiness-budget expiry). One formatted line
   * per call. Defaults to `console.debug`, so browser visibility is unchanged; a
   * Node CLI can pass a stderr writer. A throwing or rejecting sink never changes bus
   * state. With an explicit `context`, this replaces that context's sink.
   *
   * Named `debugLog` to match the transports' `debugLog` option (same
   * `(message: string) => void` shape).
   */
  debugLog?: (message: string) => void;
}

/**
 * Use the supplied context or build a fresh one; an explicit `debugLog` always wins.
 * @param options - Bus creation options
 * @returns The context the bus instance will run on
 */
function resolveBusContext(options?: CreateBusOptions<string | undefined>): MakaioBusContext {
  if (!options?.context) return createBusContext(options?.debugLog);
  if (options.debugLog) options.context.debugLog = resolveBusDebugLog(options.debugLog);
  return options.context;
}

/**
 * Creates a new bus instance with optional context, namespace isolation, and transports.
 *
 * The bus instance provides methods for type-safe event emission, request/response
 * patterns, handler registration, and namespace management. Handlers use
 * SubjectDefinition objects (not strings) for full type safety and schema validation.
 * @param options - Optional creation options. `context` defaults to a fresh `createBusContext()`.
 * `namespace` scopes the instance (e.g. `'adapter:claudeCode'`). `transports` are registered
 * immediately after creation.
 * @returns A new IHostMakaioBus instance with methods for on, emit, request, scoped, and schema management
 */
export function createBusInstance<Namespace extends string | undefined = undefined>(
  options?: CreateBusOptions<Namespace>,
): IHostMakaioBus<Namespace> {
  // Each call creates a fresh context by default, so wireLifecycleEmitter
  // (called below) installs on an isolated transport registry. The only way
  // to share a context is to pass one explicitly; carrier-bound instances reuse
  // the host context but do not call wireLifecycleEmitter themselves.
  const { namespace, transports } = options ?? {};
  const context = resolveBusContext(options);
  const transportMethods = createTransportMethods(context);

  // A bus built without a shared context is a carrier of its own: the host party of its
  // fresh context, never the party of the running host (the kernel binds that one when it
  // composes the host).
  const bus = buildBusInstance<Namespace>(context, hostPartyOf(context), transportMethods, namespace);

  // Wire lifecycle emission: transport connect/disconnect fire BusLifecycle events (local-only).
  wireLifecycleEmitter(context, bus.registerNamespace(createBusNamespace('bus:lifecycle', LifecycleSchemas)).subjects);

  for (const transport of transports ?? []) {
    bus.registerTransport(transport);
  }

  return bus;
}

/**
 * Main bus instance with unified API for events and request/response flows.
 *
 * Provides a singleton bus that manages schema-backed messaging with type-safe
 * subjects, namespace isolation, and transport routing. Use this as the central
 * coordination point for all cross-component communication.
 *
 * **Core Methods:**
 * - `registerNamespace(definition)` - Register a namespace as the host
 * - `on()` - Subscribe to events or requests with typed handlers
 * - `emit()` - Event broadcasting; awaiting it awaits the local handlers
 * - `request()` - Request-response with middleware chain
 * - `scoped()` - Create namespace-scoped bus instance
 *
 * **Key Features:**
 * - Type-safe SubjectDefinition objects (no raw strings)
 * - Runtime validation in development (Zod schemas)
 * - Wildcard pattern matching with `.$all`
 * - Transport-backed remote messaging
 * - Hierarchical namespace support (e.g., `adapter:claudeCode`)
 * - Middleware chains for request processing
 *
 * Extensions declare definitions in their manifest's `namespaces` or claim
 * them at runtime with `ctx.namespaces.lease(definition)`.
 * @example Host usage
 * ```typescript
 * import { MakaioBus } from '@makaio/bus-core';
 * import { createBusNamespace } from '@makaio/core';
 * import { z } from 'zod';
 *
 * const definition = createBusNamespace('agent', {
 *   started: z.object({ agentId: z.string() }),
 *   toolApprove: {
 *     request: z.object({ toolName: z.string() }),
 *     response: z.object({ approved: z.boolean() }),
 *   },
 * });
 * const { subjects } = MakaioBus.registerNamespace(definition);
 *
 * // Subscribe to events
 * MakaioBus.on(subjects.started, (context) => {
 *   console.debug('Agent started:', context.payload.agentId);
 * });
 *
 * // ORIGIN: The host initiates the start operation.
 * const call = MakaioBus.own('start');
 * await MakaioBus.emit(call, subjects.started, { agentId: 'agent-123' });
 *
 * // Handle requests
 * MakaioBus.on(subjects.toolApprove, (context) => {
 *   context.setResult({ approved: true });
 * });
 *
 * // Make requests
 * const result = await MakaioBus.request(call, subjects.toolApprove, {
 *   toolName: 'deleteFile',
 * });
 * ```
 */
export const MakaioBus: IHostMakaioBus = createBusInstance();

export type { ScopedBus };
