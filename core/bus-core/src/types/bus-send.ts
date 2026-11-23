import type { CallContext, OptionalResult, SubjectDefinition, WildcardSubject } from '@makaio/core';
import type { BroadcastResult } from '../methods/broadcast.js';
import type { EmitOptions, RequestOptions } from './options.js';

/**
 * Subject parameter type of the `emit` overloads: resolves to `Subject` for a concrete event subject and
 * to `never` for a channel subject, a request subject or a wildcard subject.
 *
 * Helpers that forward an emit generically over the subject use it as the type of their `subject`
 * parameter, so the condition exists in one place (see {@link BusSendOperations}).
 * @typeParam Subject - Subject definition being emitted
 * @typeParam IsChannel - Channel flag of `Subject` (defaulted, do not set)
 * @typeParam IsRequest - Request flag of `Subject` (defaulted, do not set)
 * @typeParam IsWildcard - Whether the subject key is a wildcard pattern (defaulted, do not set)
 */
export type EmitSubject<
  Subject extends SubjectDefinition,
  IsChannel = Subject['$meta']['channel'],
  IsRequest = Subject['$meta']['isRequest'],
  IsWildcard = Subject['subject'] extends WildcardSubject ? true : false,
> = IsChannel extends true ? never : IsRequest extends false ? (IsWildcard extends false ? Subject : never) : never;

/**
 * Send operations of the bus (`emit`, `request`, `requestOptional`, `broadcast`).
 *
 * Every operation has two overloads, the call form first and the own form last:
 * - **Call form** `op(call, subject, payload, options?)`: forwards a handled message.
 *   Principal and `attestedBy` come from `call`; the caller is the carrier of the bus.
 * - **Own form** `op(subject, payload, options?)`: the carrier sends for itself, so caller and
 *   principal are both the carrier.
 *
 * The signatures are declared as methods (not as properties) so that implementations can be bound
 * with a single cast to `IMakaioBus['<member>']`, which relies on method bivariance.
 *
 * Parameterised with the same type parameters as `IMakaioBus`, which composes this type.
 *
 * **Reading these members through utility types.** The members are generic and overloaded.
 * `Parameters<>` and `ReturnType<>` read the LAST overload (the own form) with `Subject` replaced by its
 * constraint, so they do NOT yield a subject/payload pair that the member accepts (the constraint
 * resolves the payload to a bare record, not to the payload of any concrete subject). A union of
 * member names (`bus[method]`) has no common call signature and is not callable; call each operation
 * through its own branch. Helpers that forward a send are written generically over `Subject`:
 * @example
 * ```typescript
 * type RequestSubject = SubjectDefinition & {
 *   readonly $meta: { readonly isRequest: true; readonly channel: false; readonly payload: RequestMessagePayload };
 * };
 * const forward = <Subject extends RequestSubject>(
 *   bus: MakaioBusLike, subject: Subject, payload: Subject['$meta']['payload']['request'],
 * ) => bus.request(subject, payload);
 * ```
 *
 * The event case is the same with {@link EmitSubject} as the subject parameter type, which rejects
 * request, wildcard and channel subjects:
 * @example
 * ```typescript
 * async function forward<S extends SubjectDefinition>(
 *   bus: IMakaioBus, call: CallContext, subject: EmitSubject<S>, payload: S['$meta']['payload'],
 * ): Promise<void> {
 *   await bus.emit<S>(call, subject, payload);
 * }
 * ```
 */
export type BusSendOperations<Subjects extends SubjectDefinition, StrictNamespace> = {
  /**
   * Emit an event to all registered handlers (call form).
   *
   * `Parameters<>` of `emit` reads the own-form overload at its `Subject` constraint; write forwarding helpers generically over `Subject`.
   *
   * All local handlers execute in parallel with fail-fast settlement: on
   * success the returned promise resolves only after every local handler has
   * settled and every transport send has been attempted, but the first
   * handler rejection rejects it immediately — slower siblings keep running
   * unawaited, and no transport send is attempted. `await emit(...)` is
   * therefore an ordering guarantee only for the success path; after a
   * rejection, the remaining handlers' effects may not have settled.
   *
   * Handler errors are logged and never stop sibling handlers, but they DO
   * reject the returned promise. Callers that emit for ordering rather than for
   * correctness must therefore either ignore the promise (`void emit(...)`) or
   * catch it — an awaited emit propagates a consumer's failure back to the
   * producer.
   *
   * Remote handlers are not awaited: only delivery to the transport is, so the
   * ordering guarantee is local to this bus instance.
   *
   * **Note:** You cannot emit to wildcard patterns. Use concrete subject keys only.
   * Handlers registered with wildcards will still receive the event if it matches.
   *
   * Use the call form inside a handler to forward the handled message's principal; use the own
   * form (`emit(subject, payload, options?)`) when the carrier sends for itself.
   * @param call - Call context of the handled message (principal and `attestedBy` come from it; the caller is the carrier of this bus)
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
   * const definition = createBusNamespace('agent', {
   *   started: z.object({ agentId: z.string() }),
   * });
   * const { subjects: AgentSubjects } = MakaioBus.registerNamespace(definition);
   *
   * // Forward a handled message (call form), send to all transports (default)
   * await emit(call, AgentSubjects.started, { agentId: 'agent-123' });
   *
   * // Send for the carrier itself (own form)
   * await emit(AgentSubjects.started, { agentId: 'agent-123' });
   *
   * // Local only, no transports
   * await emit(
   *   call,
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
   *   call,
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
    call: CallContext,
    subject: EmitSubject<Subject, IsChannel, IsRequest, IsWildcard>,
    payload: Subject['$meta']['payload'],
    options?: EmitOptions,
  ): Promise<void>;
  /**
   * Emit an event to all registered handlers (own form): the carrier sends for itself, so caller and
   * principal are both the carrier. See the call form for delivery and transport semantics.
   * @param subject - Concrete event subject (wildcards not allowed)
   * @param payload - Event payload
   * @param options - Emit options (messageId, correlationId, transports)
   */
  emit<
    Subject extends Subjects & StrictNamespace,
    IsRequest = Subject['$meta']['isRequest'],
    IsWildcard = Subject['subject'] extends WildcardSubject ? true : false,
    IsChannel = Subject['$meta']['channel'],
  >(
    subject: EmitSubject<Subject, IsChannel, IsRequest, IsWildcard>,
    payload: Subject['$meta']['payload'],
    options?: EmitOptions,
  ): Promise<void>;

  /**
   * Execute a request and wait for a response (call form).
   *
   * `Parameters<>` of `request` reads the own-form overload at its `Subject` constraint; write forwarding helpers generically over `Subject`.
   *
   * Requests follow a middleware chain pattern - handlers are called in order
   * until one calls setResult() or all handlers complete.
   *
   * **Note:** You cannot request via wildcard patterns. Use concrete subject keys only.
   * Handlers registered with wildcards will still match if the subject matches their pattern.
   *
   * Use the call form inside a handler to forward the handled message's principal; use the own
   * form (`request(subject, payload, options?)`) when the carrier sends for itself.
   * @param call - Call context of the handled message (principal and `attestedBy` come from it; the caller is the carrier of this bus)
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
   * // ✅ Concrete subject, forwarding a handled message (call form)
   * const result = await request(
   *   call,
   *   AgentSubjects.toolApprove,
   *   { toolName: 'deleteFile', args: {}, toolCallId: 'call_123' },
   *   { timeout: 10000 }
   * );
   * console.debug(result.approved);
   *
   * // ✅ Carrier sends for itself (own form)
   * const own = await request(AgentSubjects.toolApprove, {
   *   toolName: 'deleteFile',
   *   args: {},
   *   toolCallId: 'call_123',
   * });
   *
   * // ❌ Cannot use wildcards
   * // await request(AgentSubjects.$all, { ... }); // Type error
   *
   * // With specific transports
   * const result = await request(
   *   call,
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
    call: CallContext,
    subject: IsChannel extends true ? never : IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>;
  /**
   * Execute a request and wait for a response (own form): the carrier sends for itself, so caller and
   * principal are both the carrier. See the call form for routing and error semantics.
   * @param subject - Concrete request subject (wildcards not allowed)
   * @param payload - Request payload
   * @param options - Request options (timeout, correlationId, transports)
   * @returns Response value
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
   * Execute a request, returning a discriminated union instead of throwing for missing handlers (call form).
   *
   * `Parameters<>` of `requestOptional` reads the own-form overload at its `Subject` constraint; write forwarding helpers generically over `Subject`.
   *
   * Use for optional services. Only NoHandlerError is caught - other errors propagate.
   * @see {@link OptionalResult} for return type details
   * @param call - Call context of the handled message (principal and `attestedBy` come from it; the caller is the carrier of this bus)
   * @param subject - Concrete request subject (wildcards not allowed)
   * @param payload - Request payload
   * @param options - Request options (timeout, correlationId, transports)
   * @returns Discriminated union of the handler response or the missing-handler marker
   */
  requestOptional<
    Subject extends Subjects & StrictNamespace,
    IsRequest = Subject['$meta']['isRequest'],
    IsChannel = Subject['$meta']['channel'],
  >(
    call: CallContext,
    subject: IsChannel extends true ? never : IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<OptionalResult<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>>;
  /**
   * Execute a request, returning a discriminated union instead of throwing for missing handlers (own form):
   * the carrier sends for itself, so caller and principal are both the carrier.
   * @see {@link OptionalResult} for return type details
   * @param subject - Concrete request subject (wildcards not allowed)
   * @param payload - Request payload
   * @param options - Request options (timeout, correlationId, transports)
   * @returns Discriminated union of the handler response or the missing-handler marker
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
   * Execute a broadcast request and collect responses from ALL handlers (call form).
   *
   * `Parameters<>` of `broadcast` reads the own-form overload at its `Subject` constraint; write forwarding helpers generically over `Subject`.
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
   * @param call - Call context of the handled message (principal and `attestedBy` come from it; the caller is the carrier of this bus)
   * @param subject - Concrete request subject (wildcards not allowed)
   * @param payload - Request payload
   * @param options - Request options (timeout, correlationId)
   * @returns Array of \{ nodeId, payload \} responses from all handlers
   * @example
   * ```typescript
   * // Discover all filesystem sources from all nodes (call form)
   * const results = await MakaioBus.broadcast(call, FileSystemSubjects.listSources, \{\});
   * // results: [
   * //   \{ nodeId: 'local', payload: \{ sources: [...] \} \},
   * //   \{ nodeId: 'container-1', payload: \{ sources: [...] \} \},
   * // ]
   *
   * // Own form: the carrier broadcasts for itself
   * const own = await MakaioBus.broadcast(FileSystemSubjects.listSources, \{\});
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
    call: CallContext,
    subject: IsChannel extends true ? never : IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<BroadcastResult<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>[]>;
  /**
   * Execute a broadcast request and collect responses from ALL handlers (own form): the carrier sends
   * for itself, so caller and principal are both the carrier.
   * @param subject - Concrete request subject (wildcards not allowed)
   * @param payload - Request payload
   * @param options - Request options (timeout, correlationId)
   * @returns Array of \{ nodeId, payload \} responses from all handlers
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
};
