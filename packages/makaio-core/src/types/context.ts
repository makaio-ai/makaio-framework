import type { BaseMessageContext } from './message.js';

/**
 * Context object passed to event handlers when using wildcard patterns.
 *
 * Provides:
 * - `isRequest`: Always false (discriminator for type narrowing)
 * - `payload`: The event payload
 * - Message tracking fields from BaseMessage (messageId, correlationId)
 */
export interface EventContext<Payload> extends BaseMessageContext {
  /** Discriminator - always false for events */
  isRequest: false;

  /** The event payload */
  payload: Payload;

  /** The event subject */
  subject: string;
}

/**
 * Context object passed to request handlers.
 *
 * Provides:
 * - `isRequest`: Always true (discriminator for type narrowing)
 * - `payload`: The request payload
 * - `setResult`: Function to set the response value
 * - `next`: Function to call the next handler in the middleware chain
 * - `replacePayload`: Function to transform the payload for subsequent handlers
 * - `identify`: Optional function to identify the handler for broadcast aggregation
 * - Message tracking fields from BaseMessage (messageId, correlationId)
 */
export interface RequestContext<Payload, Response> extends BaseMessageContext {
  /** Discriminator - always true for requests */
  isRequest: true;

  /** The request payload */
  payload: Payload;

  /** Set the response value (ends the handler chain) */
  setResult: (result: Response) => void;

  /**
   * Read the current result value.
   *
   * Returns the value set by `setResult()` in this handler or by a downstream
   * handler after `await next()`. Undefined until a result has been set.
   */
  readonly result: Response | undefined;

  /**
   * Shallow-merge additional fields into the current result.
   *
   * Only valid for object-typed responses. In the request path the operation
   * uses spread (immutable); in broadcast mode it uses `Object.assign`
   * (in-place mutation) so the already-pushed result reference stays current.
   * If no result has been set yet, starts from an empty object.
   * @param extension - Fields to merge into the current result
   */
  extendResult: (extension: [Response] extends [Record<string, unknown>] ? Partial<Response> : never) => void;

  /**
   * Call the next handler in the middleware chain.
   * If no more handlers exist, throws NoHandlerError.
   */
  next: () => Promise<void>;

  /**
   * Replace the payload with a new value.
   * Subsequent handlers in the middleware chain will receive the new payload.
   * Useful for hooks that need to inject context before the main handler runs.
   */
  replacePayload: (newPayload: Payload) => void;

  /**
   * Identify this handler for broadcast aggregation.
   * Only present when called via broadcast() - call before setResult().
   * @param nodeId - Unique identifier for this handler/node
   */
  identify?: (nodeId: string) => void;
}

/**
 * Unified context for wildcard handlers that can match both events and requests.
 * Use the `isRequest` discriminator to narrow the type.
 * @example
 * ```typescript
 * MakaioBus.on('adapter.*', (context) => {
 *   if (context.isRequest) {
 *     // TypeScript knows this is RequestContext
 *     context.setResult({ handled: true });
 *   } else {
 *     // TypeScript knows this is EventContext
 *     console.debug('Event:', context.payload);
 *   }
 * });
 * ```
 */
export type WildcardContext<Payload = unknown, Response = unknown> =
  | EventContext<Payload>
  | RequestContext<Payload, Response>;
