import type { BusTransportKeys } from '../registries/index.js';
import type { PayloadFilter, TransportReceiveContext } from '@makaio/core';

/**
 * Default request timeout in milliseconds.
 *
 * Shared policy constant used when callers omit `RequestOptions.timeout`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Default readiness budget in milliseconds for the dispatch readiness gate.
 *
 * The gate waits for transports that have not yet completed their `ready`
 * handshake so that late-arriving remote routes can join the dispatch chain.
 * That wait is a routing *hint*, not a precondition: it runs on this dedicated
 * budget rather than on the caller's request timeout, and dispatch proceeds
 * with the routes known so far once the budget expires.
 *
 * Kept short on purpose — a transport that has not synced within this window
 * is either slow or structurally unable to complete the handshake, and neither
 * case justifies spending the caller's full request budget.
 */
export const DEFAULT_READINESS_TIMEOUT_MS = 1_500;

/**
 * Options for subscribing to events/requests via on().
 */
export interface OnOptions {
  /**
   * Explicit handler registry target for wildcard subjects.
   *
   * Exact subjects derive their registry from the subject schema. Wildcard
   * subjects can match both events and requests, so callers that know their
   * intent can pin the registration to event-only or request-only. Omit this
   * option to preserve the historical ambiguous wildcard behavior.
   */
  handlerKind?: 'event' | 'request' | 'both';
  /**
   * Declarative payload filter for smart-routing.
   *
   * Applied both locally (before handler invocation) and can be sent
   * to transports for server-side filtering.
   *
   * All conditions are ANDed together.
   * @example
   * ```typescript
   * bus.on(Subjects.message, handler, {
   *   filter: {
   *     agentId: 'agent-123',
   *     status: { $in: ['active', 'pending'] },
   *   }
   * });
   * ```
   */
  filter?: PayloadFilter;
  /**
   * Handler priority for middleware-style ordering.
   *
   * Higher values run earlier. Default is 0.
   * Handlers with equal priority preserve registration order.
   * @example
   * ```typescript
   * // Authentication runs first (highest priority)
   * bus.on(Subjects.request, authHandler, { priority: 100 });
   *
   * // Logging runs next
   * bus.on(Subjects.request, logHandler, { priority: 50 });
   *
   * // Business logic runs last (default priority)
   * bus.on(Subjects.request, businessHandler);
   * ```
   */
  priority?: number;
}

/**
 * Options for emitting events.
 *
 * Extends BaseMessage to provide message tracking.
 * All fields are optional - defaults will be auto-generated.
 */
export interface EmitOptions {
  /**
   * Unique identifier for this event.
   * Auto-generated if not provided.
   */
  messageId?: string;

  /**
   * Optional correlation ID for linking related operations.
   * Useful for tracking events as part of a larger workflow.
   */
  correlationId?: string;

  /**
   * Optional set of transport keys to send this event over.
   * If not specified, the event will be emitted locally and relayed to all ready transports.
   * Can be provided as a Set or Array of transport names.
   */
  transports?: Set<BusTransportKeys> | Array<BusTransportKeys>;
}

/**
 * Options for making requests.
 *
 * Extends EmitOptions with request-specific settings like timeout.
 */
export interface RequestOptions extends EmitOptions {
  /**
   * Timeout in milliseconds. Defaults to DEFAULT_REQUEST_TIMEOUT_MS (60 seconds) if not specified.
   * Use `0` for no automatic timeout — the request stays open until resolved,
   * rejected, or cancelled via the `signal` AbortSignal.
   */
  timeout?: number;

  /**
   * Budget in milliseconds for the dispatch readiness gate.
   *
   * When any transport eligible for this request is still completing its `ready`
   * handshake, dispatch waits up to this long for its routes to arrive, then builds
   * the handler chain once. The wait happens whether or not a local handler could
   * answer: a pending peer may yet advertise a *higher-priority* route, and the
   * cross-transport priority contract says that route runs first. Local-only subjects
   * (and `transports: []`) never wait, because no peer can contribute to them.
   *
   * The practical cost is up to this budget per request during a transport's connect
   * window, and nothing at all once transports have settled. On expiry dispatch
   * proceeds with the routes advertised so far — the gate never fails a request, it
   * only delays it.
   *
   * This budget is separate from {@link RequestOptions.timeout} so a transport
   * that never completes its handshake cannot consume the caller's whole
   * request budget. The overall request timeout, the request deadline and `signal`
   * all still bound it.
   *
   * Use `0` to disable the cap, matching `timeout: 0` semantics. A non-finite or
   * negative value is rejected with a `RangeError` at the request seam rather than
   * being allowed to fail the request from inside the gate.
   * @defaultValue DEFAULT_READINESS_TIMEOUT_MS (1.5 seconds)
   */
  readinessTimeout?: number;

  /**
   * AbortSignal to cancel the request.
   *
   * Cancellation preserves recognized Error reasons by identity. Other reasons become a
   * BusAbortError (DOMException named AbortError) with the exact original reason as cause.
   * Error recognition across JavaScript realms is conservative; unrecognized reasons
   * are retained as cause rather than relying on their name or message.
   * Use isRequestCancellation(error, signal) to distinguish this cancellation from
   * an independent failure. These semantics are the same with or without a timeout.
   * This allows callers to cancel long-running requests when they're
   * no longer needed (e.g., user typing invalidates previous autocomplete).
   * @example
   * ```typescript
   * const controller = new AbortController();
   * const result = MakaioBus.request(Subject, payload, {
   *   signal: controller.signal,
   * });
   * // Later, if needed:
   * controller.abort();
   * ```
   */
  signal?: AbortSignal;
}

/**
 * Internal-only mixin for options that thread trusted transport receive context.
 *
 * Public option types (`EmitOptions`, `RequestOptions`) do not expose this field,
 * so callers cannot forge transport context through `bus.emit()` / `bus.request()`.
 * @internal
 */
export interface WithReceiveContext {
  /** Trusted context supplied by the local receiving transport. */
  transport?: TransportReceiveContext;
}
