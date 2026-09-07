import type { BusTransportKeys } from '../registries/index.js';
import type { PayloadFilter, TransportReceiveContext } from '@makaio/core';

/**
 * Default request timeout in milliseconds.
 *
 * Shared policy constant used when callers omit `RequestOptions.timeout`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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
