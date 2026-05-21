/**
 * Handler type resolution for event and request subjects.
 *
 * Provides generic types that resolve the appropriate handler signature based on
 * the subject pattern (exact or wildcard) and whether it's an event or request.
 */

import type { EventContext, RequestContext, WildcardContext } from './context.js';
import type { WildcardSubject } from './wildcards.js';
import type { SubjectDefinition } from './subjects.js';
import type { EventMessagePayload, RequestMessagePayload } from './message.js';

export type EventHandler<T> = (context: EventContext<T>) => void | Promise<void>;
export type RequestHandler<Payload, Response> = (context: RequestContext<Payload, Response>) => void | Promise<void>;

/**
 * Context provided to __onAny handlers for debugging/testing.
 * Captures all message metadata regardless of type (event/request/broadcast).
 */
export interface AnyMessageContext {
  type: 'event' | 'request' | 'broadcast';
  subject: string;
  namespace: string;
  payload: unknown;
  messageId: string;
  correlationId?: string;
}

/**
 * Handler for __onAny - receives all messages (events and requests) across all namespaces.
 * Used for debugging and testing only.
 */
export type AnyHandler = (context: AnyMessageContext) => void | Promise<void>;

/**
 * Special handler for wildcards that match both events and requests.
 * @public
 */
export type WildcardUnifiedHandler = (context: WildcardContext<unknown, unknown>) => void | Promise<void>;

/**
 * Resolve the appropriate handler type for a subject pattern (exact or wildcard).
 *
 * Handles all subscription patterns:
 * - Event wildcards (`adapter.*`) → `(payload: unknown) => void | Promise<void>`
 * - Request wildcards (`adapter.*`) → `(context: RequestContext<unknown, unknown>) => void | Promise<void>`
 * - Exact request subjects → `RequestHandler<TPayload, TReturnValue>`
 * - Exact event subjects → `EventHandler<TPayload>`
 *
 * This is the primary type used by the `on()` method to resolve handler signatures.
 * @example
 * ```typescript
 * // Event wildcard - unknown payload
 * type Handler1 = HandlerForPattern<'adapter.*'>;
 * // (payload: unknown) => void | Promise<void>
 *
 * // Exact event subject - typed payload
 * type Handler2 = HandlerForPattern<'adapter.log'>;
 * // EventHandler<{ message: string, level: string }>
 *
 * // Request wildcard - unknown context
 * type Handler3 = HandlerForPattern<'adapter.*'>;
 * // (context: RequestContext<unknown, unknown>) => void | Promise<void>
 *
 * // Exact request subject - typed context
 * type Handler4 = HandlerForPattern<'adapter.getCapabilities'>;
 * // RequestHandler<{ adapterName: string }, { capabilities: string[] }>
 * ```
 */

/**
 * Resolve the handler type for a SubjectDefinition.
 *
 * Uses indexed access (`T['$meta']['payload']`) instead of nested `extends` with `infer`
 * to ensure proper type resolution when T is a generic type parameter.
 */
export type HandlerForSubjectDefinition<T extends SubjectDefinition> = T['subject'] extends WildcardSubject
  ? WildcardUnifiedHandler
  : T['$meta']['payload'] extends RequestMessagePayload<infer Request, infer Response>
    ? RequestHandler<Request, Response>
    : T['$meta']['payload'] extends EventMessagePayload<infer Payload>
      ? EventHandler<Payload>
      : never;

/**
 * Extract context type for once() promise return value.
 *
 * Uses the same pattern as HandlerForSubjectDefinition for consistency.
 */
export type ContextForSubjectDefinition<T extends SubjectDefinition> = T['subject'] extends WildcardSubject
  ? WildcardContext<unknown, unknown>
  : T['$meta']['payload'] extends RequestMessagePayload<infer Request, infer Response>
    ? RequestContext<Request, Response>
    : T['$meta']['payload'] extends EventMessagePayload<infer Payload>
      ? EventContext<Payload>
      : never;
