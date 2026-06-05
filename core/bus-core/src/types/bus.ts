// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 680 }] */ // Bumped for registerNamespaces() + registerNamespace(BusNamespaceDefinition) + observeMessages()

import type { TransportRegistry, NamespaceRegistry } from '../registries/index.js';
import type {
  AnyHandler,
  BusNamespaceDefinition,
  EventHandler,
  FilterablePayloadIntersection,
  HandlerForSubjectDefinition,
  OptionalResult,
  PayloadFilter,
  RegistrableBusNamespaceDefinition,
  RequestHandler,
  SubjectDefinition,
  SubjectRecord,
  SubjectRecordFromSchemaRecord,
  SubjectSchema,
  TransportReceiveContext,
  TypedPayloadFilter,
  WildcardSubject,
} from '@makaio/core';
import type { OnceOptions } from '../methods/once.js';
import type { BusTransport } from './transports.js';
import type { BroadcastResult } from '../methods/broadcast.js';

import type { ScopedBus } from '../scoped-bus.js';
import type { IFilteredBus } from '../filtered-bus.js';
import type { BusNamespace } from './namespace.js';
import type { EmitOptions, OnOptions, RequestOptions } from './options.js';

import type { HandlerEntry } from './handler-entry.js';
import type { InterceptOptions, InterceptorEntry, InterceptorHandler } from './interceptor.js';

/**
 * Production-capable observation record for local bus API entrypoints.
 *
 * Unlike `AnyMessageContext`, this is not debug-only and is safe for runtime
 * services that need to derive sanitized telemetry.
 */
export interface ObservedBusMessage {
  readonly type: 'event' | 'request' | 'broadcast';
  readonly subject: string;
  readonly namespace: string;
  readonly payload: unknown;
  readonly messageId: string;
  readonly correlationId?: string;
  readonly transport?: TransportReceiveContext;
  /** True when the originating bus call was explicitly or inherently local-only. */
  readonly localOnly?: boolean;
}

/**
 * Observer callback invoked for each local bus API message after validation
 * has succeeded. Observers must not mutate the payload.
 */
export type BusMessageObserver = (message: ObservedBusMessage) => void | Promise<void>;

/**
 * Internal bus context containing handler registries and shared state.
 *
 * Enables creation of isolated bus instances (e.g., for testing) by providing
 * separate handler maps per instance.
 *
 * Handler arrays are sorted by priority (highest first), with registration order
 * preserved for handlers with equal priority.
 */
export interface MakaioBusContext {
  eventHandlers: Map<string, Array<HandlerEntry<EventHandler<unknown>>>>;
  requestHandlers: Map<string, Array<HandlerEntry<RequestHandler<unknown, unknown>>>>;
  interceptorHandlers: Map<string, Array<InterceptorEntry<InterceptorHandler<unknown>>>>;
  anyHandlers: Set<AnyHandler>;
  /** Production-capable message observers registered via {@link IMakaioBus.observeMessages}. */
  messageObservers: Set<BusMessageObserver>;
  transportRegistry: TransportRegistry;
  namespaceRegistry: NamespaceRegistry;
  /** Remote handler priorities from subscribe messages; keyed by subject pattern. */
  remoteRequestHandlers: Map<string, Array<{ transport: string; priority: number }>>;
  /**
   * Set of transport names that have subscribed to each subject with event-only handlers
   * (i.e. subscribe messages whose priority array was empty).
   *
   * Tracked separately from `remoteRequestHandlers` because event-only subscriptions
   * produce no priority entries yet must still influence advertised-state decisions:
   * if a remote has event-only handlers for a subject, peers should still receive a
   * `subscribe` (with an empty priority array) rather than an `unsubscribe`.
   */
  remoteEventHandlers: Map<string, Set<string>>;
}

/**
 * Result of registering a transport on the bus.
 */
export interface TransportRegistration {
  /** Remove the transport from the registry and purge its remote handler entries. */
  unregister: () => void;
  /**
   * Resolves when initial subscribe synchronization is complete and requests
   * can safely route through this transport. Resolves immediately for
   * transports that do not implement `ready`.
   */
  ready: Promise<void>;
}

/**
 * Options for {@link IMakaioBus.connect}.
 */
export interface ConnectOptions {
  /**
   * Whether to await subscribe-sync readiness after connecting (default: `true`).
   *
   * When `true`, `connect()` resolves only after all transports have completed
   * the subscribe-sync handshake (`transport.ready`), guaranteeing
   * `remoteRequestHandlers` is fully populated before any request dispatch.
   *
   * Set to `false` to resolve as soon as sockets are open. Useful when the
   * caller needs the socket open for a custom handshake before subscribe-sync.
   * @defaultValue true
   */
  awaitReady?: boolean;
}

export type IMakaioBus<
  NamespaceDomain extends string | unknown = unknown,
  Subjects extends SubjectDefinition = SubjectDefinition,
  StrictNamespace = {
    $meta: {
      namespace: NamespaceDomain extends string ? NamespaceDomain : string;
    };
  },
> = {
  namespace: NamespaceDomain;
  /**
   * Register an event or request handler.
   *
   * **Events:** Fire-and-forget - multiple handlers can listen and execute in parallel.
   * **Requests:** Request-response with middleware support - handlers form a chain.
   *
   * **Wildcard Support:** Use `.$all` property on subjects to match all subjects in a namespace.
   * Wildcard handlers receive `unknown` payload and must use type guards.
   * @param subject - SubjectDefinition object (exact or wildcard)
   * @param handler - Handler function (EventHandler for events, RequestHandler for requests)
   * @returns Unsubscribe function
   * @example Basic event handler with typed payload
   * ```typescript
   * const { subjects: AgentSubjects } = MakaioBus.registerNamespace('agent', {
   *   started: z.object({ agentId: z.string() }),
   * });
   *
   * const unsubscribe = on(AgentSubjects.started, (context) => {
   *   context.payload.agentId; // ✅ string - fully typed
   *   console.debug('Agent started:', context.payload.agentId);
   * });
   * ```
   * @example Wildcard handlers for namespace-level events
   * ```typescript
   * // Matches all subjects in namespace
   * on(AgentSubjects.$all, (context) => {
   *   context.payload; // unknown - must use type guards
   *   if ('agentId' in context.payload) {
   *     console.debug('Any agent event:', context.payload.agentId);
   *   }
   * });
   * ```
   * @example Request handler with typed request/response
   * ```typescript
   * const { subjects: AgentSubjects } = MakaioBus.registerNamespace('agent', {
   *   toolApprove: {
   *     request: z.object({ toolName: z.string() }),
   *     response: z.object({ approved: z.boolean() }),
   *   },
   * });
   *
   * on(AgentSubjects.toolApprove, (context) => {
   *   const { toolName } = context.payload; // ✅ fully typed
   *   context.setResult({ approved: true });
   * });
   * ```
   * @example Middleware pattern for request chain
   * ```typescript
   * on(AgentSubjects.toolApprove, async (context) => {
   *   console.debug('Before approval');
   *   await context.next();
   *   console.debug('After approval');
   * });
   * ```
   */
  on<Subject extends Subjects & StrictNamespace, IsChannel = Subject['$meta']['channel']>(
    subject: IsChannel extends true ? never : Subject,
    handler: Subject extends SubjectDefinition ? HandlerForSubjectDefinition<Subject> : never,
    options?: OnOptions,
  ): () => void;

  /** Register an interceptor that runs BEFORE handlers (payload transform, blocking, priority). */
  intercept<Subject extends Subjects & StrictNamespace>(
    subject: Subject,
    handler: InterceptorHandler<Subject['$meta']['payload']>,
    options?: InterceptOptions,
  ): () => void;

  /**
   * Register a one-time event or request handler that auto-unsubscribes after first invocation.
   *
   * Wraps the `on()` method to automatically unsubscribe after the handler fires once.
   * The handler is removed BEFORE being invoked to prevent re-entrance issues if the
   * handler triggers the same event.
   *
   * **Events:** Fire-and-forget - handler executes once then auto-unsubscribes.
   * **Requests:** Request-response - handler executes once then auto-unsubscribes.
   *
   * **Wildcard Support:** Like `on()`, supports `.$all` property for namespace-level patterns.
   * @param subject - SubjectDefinition object (exact or wildcard)
   * @param handler - Handler function (EventHandler for events, RequestHandler for requests)
   * @returns Unsubscribe function for manual cleanup if needed
   * @example Basic one-time event handler
   * ```typescript
   * const { subjects: AgentSubjects } = MakaioBus.registerNamespace('agent', {
   *   started: z.object({ agentId: z.string() }),
   * });
   *
   * once(AgentSubjects.started, (context) => {
   *   context.payload.agentId; // ✅ string - fully typed
   *   console.debug('Agent started once:', context.payload.agentId);
   * });
   *
   * await emit(AgentSubjects.started, { agentId: 'agent-123' }); // Handler fires
   * await emit(AgentSubjects.started, { agentId: 'agent-456' }); // Handler does NOT fire
   * ```
   * @example Manual unsubscribe before first fire
   * ```typescript
   * const unsubscribe = once(AgentSubjects.started, (context) => {
   *   console.debug('This will never run');
   * });
   *
   * unsubscribe(); // Manually unsubscribe before event fires
   * await emit(AgentSubjects.started, { agentId: 'agent-123' }); // Handler does NOT fire
   * ```
   * @example Wildcard handler for one-time namespace monitoring
   * ```typescript
   * once(AgentSubjects.$all, (context) => {
   *   context.payload; // unknown - must use type guards
   *   console.debug('First agent event:', context.payload);
   * });
   * ```
   * @example One-time request handler
   * ```typescript
   * const { subjects: AgentSubjects } = MakaioBus.registerNamespace('agent', {
   *   toolApprove: {
   *     request: z.object({ toolName: z.string() }),
   *     response: z.object({ approved: z.boolean() }),
   *   },
   * });
   *
   * once(AgentSubjects.toolApprove, (context) => {
   *   const { toolName } = context.payload; // ✅ fully typed
   *   context.setResult({ approved: true });
   * });
   *
   * await request(AgentSubjects.toolApprove, { toolName: 'deleteFile' }); // Handler fires
   * await request(AgentSubjects.toolApprove, { toolName: 'createFile' }); // Handler does NOT fire
   * ```
   */
  once<Subject extends Subjects & StrictNamespace, IsChannel = Subject['$meta']['channel']>(
    subject: IsChannel extends true ? never : Subject,
    handler: Subject extends SubjectDefinition ? HandlerForSubjectDefinition<Subject> : never,
  ): () => void;

  /**
   * Wait for an event to occur, returning a Promise.
   *
   * Note: Request subjects are not supported with the promise version of once().
   * Use the callback version for request handlers: `once(subject, handler)`
   * @param subject - Event SubjectDefinition object (exact or wildcard)
   * @param options - Options object with: timeoutMs (reject after timeout), filter (only resolve when filter returns true), signal (AbortSignal to cancel waiting)
   * @returns Promise that resolves with the event context
   * @example Simple await
   * ```typescript
   * const ctx = await bus.once(Subjects.init);
   * console.debug('Event received:', ctx.payload);
   * ```
   * @example With timeout
   * ```typescript
   * try {
   *   const ctx = await bus.once(Subjects.init, { timeoutMs: 5000 });
   * } catch (err) {
   *   if (err instanceof OnceTimeoutError) {
   *     console.debug('Timed out waiting for event');
   *   }
   * }
   * ```
   * @example With filter (waits for matching event)
   * ```typescript
   * const ctx = await bus.once(Subjects.message, {
   *   filter: (payload) => payload.sessionId === expectedId
   * });
   * // Resolves only when a message with matching sessionId is received
   * ```
   * @example With AbortSignal
   * ```typescript
   * const controller = new AbortController();
   * const promise = bus.once(Subjects.init, { signal: controller.signal });
   * controller.abort(); // Cancels the wait
   * ```
   */
  once<
    Subject extends Subjects & StrictNamespace,
    IsRequest = Subject['$meta']['isRequest'],
    IsChannel = Subject['$meta']['channel'],
  >(
    subject: IsChannel extends true ? never : IsRequest extends false ? Subject : never,
    options?: Subject extends SubjectDefinition ? OnceOptions<Subject> : never,
  ): Promise<Subject extends SubjectDefinition ? Parameters<HandlerForSubjectDefinition<Subject>>[0] : never>;
  /**
   * Emit an event to all registered handlers.
   *
   * Events are fire-and-forget - all handlers execute in parallel.
   * Handler errors are logged but don't stop other handlers from executing.
   *
   * **Note:** You cannot emit to wildcard patterns. Use concrete subject keys only.
   * Handlers registered with wildcards will still receive the event if it matches.
   * @param subject - Concrete event subject (wildcards not allowed)
   * @param payload - Event payload
   * @param options - Emit options (messageId, correlationId, transports)
   *
   * ## Transport Routing
   * - `transports: undefined` - Send to ALL registered transports (default)
   * - `transports: []` - Local only, don't send to any transports
   * - `transports: ['ws', 'nats']` - Send only to specified transports
   * @example
   * ```typescript
   * const { subjects: AgentSubjects } = MakaioBus.registerNamespace('agent', {
   *   started: z.object({ agentId: z.string() }),
   * });
   *
   * // Send to all transports (default)
   * await emit(AgentSubjects.started, { agentId: 'agent-123' });
   *
   * // Local only, no transports
   * await emit(
   *   AgentSubjects.started,
   *   { agentId: 'agent-123' },
   *   { transports: [] }
   * );
   *
   * // Send to specific transports
   * await emit(
   *   AgentSubjects.started,
   *   { agentId: 'agent-123' },
   *   { transports: ['websocket'] }
   * );
   *
   * // With tracking IDs:
   * await emit(
   *   AgentSubjects.started,
   *   { agentId: 'agent-123' },
   *   { correlationId: 'user-action-123' }
   * );
   * ```
   */
  emit<
    Subject extends Subjects & StrictNamespace,
    IsRequest = Subject['$meta']['isRequest'],
    IsWildcard = Subject['subject'] extends WildcardSubject ? true : false,
    IsChannel = Subject['$meta']['channel'],
  >(
    subject: IsChannel extends true
      ? never
      : IsRequest extends false
        ? IsWildcard extends false
          ? Subject
          : never
        : never,
    payload: Subject['$meta']['payload'],
    options?: EmitOptions,
  ): Promise<void>;
  /**
   * Execute a request and wait for a response.
   *
   * Requests follow a middleware chain pattern - handlers are called in order
   * until one calls setResult() or all handlers complete.
   *
   * **Note:** You cannot request via wildcard patterns. Use concrete subject keys only.
   * Handlers registered with wildcards will still match if the subject matches their pattern.
   * @param subject - Concrete request subject (wildcards not allowed)
   * @param payload - Request payload
   * @param options - Request options (timeout, correlationId, transports)
   * @returns Response value
   * @throws \{NoHandlerError\} If no handler is registered
   * @throws \{TimeoutError\} If request times out
   * @throws \{ValidationError\} If payload validation fails
   * @throws \{RequestError\} If handler throws an error
   *
   * ## Transport Routing
   * - `transports: undefined` - Send to ALL registered transports (default)
   * - `transports: []` - Local only, don't send to any transports
   * - `transports: ['ws', 'nats']` - Send only to specified transports
   * @example
   * ```typescript
   * // ✅ Concrete subject
   * const result = await request(
   *   AgentSubjects.toolApprove,
   *   { toolName: 'deleteFile', args: {}, toolCallId: 'call_123' },
   *   { timeout: 10000 }
   * );
   * console.debug(result.approved);
   *
   * // ❌ Cannot use wildcards
   * // await request('agent.*', { ... }); // Type error
   *
   * // With specific transports
   * const result = await request(
   *   AgentSubjects.toolApprove,
   *   { toolName: 'deleteFile', args: {}, toolCallId: 'call_123' },
   *   { transports: ['websocket'], timeout: 10000 }
   * );
   * ```
   */
  request<
    Subject extends Subjects & StrictNamespace,
    IsRequest = Subject['$meta']['isRequest'],
    IsChannel = Subject['$meta']['channel'],
  >(
    subject: IsChannel extends true ? never : IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>;

  /**
   * Execute a request, returning a discriminated union instead of throwing for missing handlers.
   *
   * Use for optional services. Only NoHandlerError is caught - other errors propagate.
   * @see {@link OptionalResult} for return type details
   */
  requestOptional<
    Subject extends Subjects & StrictNamespace,
    IsRequest = Subject['$meta']['isRequest'],
    IsChannel = Subject['$meta']['channel'],
  >(
    subject: IsChannel extends true ? never : IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<OptionalResult<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>>;

  /**
   * Execute a broadcast request and collect responses from ALL handlers.
   *
   * Unlike `request()` which uses a middleware chain and returns the first result,
   * `broadcast()` executes all handlers in parallel and aggregates their responses.
   *
   * Use for discovery patterns where multiple nodes may respond (e.g., fs.listSources).
   *
   * **Note:** You cannot broadcast via wildcard patterns. Use concrete subject keys only.
   * Handlers registered with wildcards will still match if the subject matches their pattern.
   *
   * **Handler Usage:**
   * Handlers should call `ctx.identify(nodeId)` before `ctx.setResult()` to tag their response.
   * If `identify()` is not called, the response is tagged as 'anonymous'.
   * @param subject - Concrete request subject (wildcards not allowed)
   * @param payload - Request payload
   * @param options - Request options (timeout, correlationId)
   * @returns Array of \{ nodeId, payload \} responses from all handlers
   * @example
   * ```typescript
   * // Discover all filesystem sources from all nodes
   * const results = await MakaioBus.broadcast(FileSystemSubjects.listSources, \{\});
   * // results: [
   * //   \{ nodeId: 'local', payload: \{ sources: [...] \} \},
   * //   \{ nodeId: 'container-1', payload: \{ sources: [...] \} \},
   * // ]
   *
   * // Aggregate sources
   * const allSources = results.flatMap(r => r.payload.sources);
   * ```
   */
  broadcast<
    Subject extends Subjects & StrictNamespace,
    IsRequest = Subject['$meta']['isRequest'],
    IsChannel = Subject['$meta']['channel'],
  >(
    subject: IsChannel extends true ? never : IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<BroadcastResult<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>[]>;

  scoped: <Domain extends string, Subjects extends SubjectRecord, F, Sc extends Record<string, SubjectSchema>>(
    input: BusNamespace<Domain, Subjects, F, Sc>,
    context?: MakaioBusContext,
  ) => ScopedBus<Domain>;

  /**
   * Create a filtered bus with a base payload filter.
   *
   * The filter is automatically applied to all `on()` and `once()` calls.
   *
   * Optionally provide a type parameter for type-safe filter keys.
   * @param filter - Base filter to apply to all subscriptions
   * @returns FilteredBus with the specified filter
   * @example
   * ```typescript
   * // Untyped (loose) - any keys allowed
   * const agentBus = MakaioBus.withFilter({ agentId: this.agentId });
   *
   * // Type-safe filter keys
   * interface AgentPayload { agentId: string; sessionId: string }
   * const strictBus = MakaioBus.withFilter<AgentPayload>({ agentId: 'x' });
   * ```
   */
  withFilter: <Payload = unknown>(
    filter: [unknown] extends [Payload] ? PayloadFilter : TypedPayloadFilter<Payload>,
  ) => IFilteredBus<NamespaceDomain extends string ? NamespaceDomain : string>;

  /**
   * Register a production-capable local message observer.
   *
   * Observers receive local `emit`, `request`, and `broadcast` API calls after
   * message validation has succeeded. Observers must not mutate the payload.
   * Unlike `__onAny`, this is not debug-only and is safe for runtime telemetry services.
   * @param observer - Observer callback.
   * @returns Cleanup function that unregisters the observer.
   * @example
   * ```typescript
   * const dispose = bus.observeMessages((message) => {
   *   console.debug(`[${message.type}] ${message.namespace}.${message.subject}`);
   * });
   * ```
   */
  observeMessages(observer: BusMessageObserver): () => void;

  /**
   * Register a handler that receives ALL messages (events and requests) across all namespaces.
   *
   * **Debugging/Testing Only:** Noops in production (process.env.NODE_ENV === 'production').
   * Useful for logging, debugging, and test assertions that need visibility into all bus activity.
   *
   * Handler receives complete metadata: type, subject, namespace, payload, messageId, correlationId.
   * @param handler - Function to invoke for every message
   * @returns Unsubscribe function (noop in production)
   * @example
   * ```typescript
   * const unsubscribe = bus.__onAny((context) => {
   *   console.debug(`[${context.type}] ${context.namespace}:${context.subject}`, context.payload);
   * });
   * ```
   */
  __onAny: (handler: AnyHandler) => () => void;
  __resetHandlers?: () => void;

  /**
   * Register a transport by its name property.
   *
   * Convenience method that delegates to `getContext().transportRegistry.registerTransport()`.
   * The transport's `name` property is used as the registry key.
   * @param transport - Transport to register
   * @returns Registration object with `unregister` and `ready` promise
   */
  registerTransport(transport: BusTransport): TransportRegistration;

  /**
   * Unregister a transport by name.
   *
   * No-op if no transport is registered under that name.
   * @param name - Transport name to unregister
   */
  unregisterTransport(name: string): void;

  /**
   * Disconnect all registered transports and clear the transport map.
   *
   * Convenience method for tearing down a bus instance. The inverse of
   * passing `transports` to `createBusInstance()` or calling
   * `registerTransport()` individually.
   */
  disconnect(): void;

  /**
   * Trigger an immediate reconnection attempt on all disconnected transports.
   *
   * Delegates to each transport's `reconnect()` method if available. For
   * transports with exponential-backoff reconnection (e.g. WebSocket), this
   * wakes the backoff sleep and returns once the attempt is *initiated* — not
   * once the connection is established. For one-shot transports it resolves
   * after the connect attempt completes. Failures are logged but do not reject
   * this promise. No-op when all transports are already connected.
   */
  reconnect(): Promise<void>;

  /**
   * Resolves when all transports registered at connect-time have completed
   * subscribe-sync. If {@link connect} was called with the default `awaitReady: true`,
   * this is already resolved when `connect()` returns. If `awaitReady: false` was used,
   * await this to ensure readiness before dispatching requests.
   *
   * Resolves immediately if no transports are registered or `connect()` has not been called.
   */
  readonly ready: Promise<void>;

  /**
   * Connect all registered transports and optionally await subscribe-sync readiness.
   *
   * Calls `transport.connect()` on every transport registered by this bus instance.
   * If any transport fails to connect, all transports are disconnected and unregistered
   * (rollback) before the error is re-thrown. Pass `{ awaitReady: false }` to resolve
   * as soon as sockets are open without waiting for the subscribe-sync handshake.
   * Concurrent calls are safe — a second in-flight call awaits the same promise. Once
   * sockets are open, subsequent calls are no-ops unless a prior
   * `connect({ awaitReady: false })` left the readiness handshake pending; in that case,
   * default `connect()` still awaits `bus.ready`.
   * @param options - Connection options (see {@link ConnectOptions})
   * @throws If any transport's `connect()` or `ready` promise rejects (after rollback)
   */
  connect(options?: ConnectOptions): Promise<void>;

  getContext(): MakaioBusContext;

  /**
   * Register a namespace from a `BusNamespaceDefinition` created by `createBusNamespace()`.
   *
   * Returns a `BusNamespace` that extends the definition with a `scopedBus()` method.
   * @param definition - Namespace definition created by `createBusNamespace()` from `@makaio/core`
   * @returns Registered namespace with `scopedBus()` and pre-computed FilterPayload type
   */
  registerNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
    definition: BusNamespaceDefinition<Domain, Schemas>,
  ): BusNamespace<
    Domain,
    SubjectRecordFromSchemaRecord<Schemas>,
    FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
    Schemas
  >;

  /**
   * Register multiple namespaces in a single call.
   *
   * Convenience wrapper for composition roots that register a catalog of namespaces at boot:
   * ```typescript
   * MakaioBus.registerNamespaces(FrameworkContractNamespaces);
   * ```
   * @param definitions - Array of namespace definitions to register
   */
  registerNamespaces(definitions: readonly RegistrableBusNamespaceDefinition[]): void;

  /** Get the schema for a registered subject, or undefined if not found. */
  getSchema<T extends SubjectDefinition>(subject: T | string): SubjectSchema | undefined;

  /**
   * Extend a registered subject's schema with additional fields.
   *
   * Adds new root-level fields to the Zod schema used for dev-mode validation and
   * widens the TypeScript payload type. Successive calls accumulate — two packages
   * can independently extend the same subject without overwriting each other.
   *
   * The returned value is the same runtime SubjectDefinition object — only the
   * TypeScript type is widened. Bus routing is unaffected.
   * @param subject - SubjectDefinition from a registered namespace
   * @param extensions - For request subjects: `{ request?: { field: z.string() }, response?: {...} }`.
   *   For event subjects: `{ field: z.string() }` (flat record of additional Zod fields).
   * @returns The same SubjectDefinition with wider TypeScript types
   */
  extendSubject<SD extends Subjects & StrictNamespace, Ext extends import('../extend-subject.js').SubjectExtension<SD>>(
    subject: SD,
    extensions: Ext,
  ): import('../extend-subject.js').ExtendedSubjectDefinition<SD, Ext>;
};
