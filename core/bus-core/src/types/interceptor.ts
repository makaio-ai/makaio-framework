import type { PayloadFilter } from '@makaio/core';

/**
 * Context provided to interceptor handlers.
 *
 * Interceptors run BEFORE event handlers (not request handlers), allowing:
 * - Payload transformation via `replacePayload()`
 * - Event blocking via `stopPropagation()`
 * - Sequential execution in priority order (highest first)
 *
 * Note: Interceptors only work with event subjects. For request/response
 * flow interception, use middleware instead.
 */
export interface InterceptorContext<P, S = string> {
  readonly subject: S;
  readonly payload: P;
  readonly messageId: string;
  readonly correlationId: string | undefined;

  /**
   * Stop propagation of this message.
   * Subsequent interceptors and all handlers will NOT be called.
   */
  stopPropagation(): void;

  /**
   * Replace the payload with a new value.
   * Subsequent interceptors and handlers will receive the new payload.
   */
  replacePayload(newPayload: P): void;

  /**
   * Explicitly continue to the next interceptor (optional).
   * Continuation is implicit if neither stopPropagation() nor next() is called.
   */
  next(): void;
}

/**
 * Handler function for interceptors.
 * Receives an InterceptorContext and may optionally return a Promise.
 */
export type InterceptorHandler<P> = (ctx: InterceptorContext<P>) => void | Promise<void>;

/**
 * Options for registering an interceptor.
 */
export interface InterceptOptions {
  /**
   * Priority for interceptor execution order.
   * Higher values run first. Default: 0
   */
  priority?: number;

  /**
   * Optional filter to conditionally invoke this interceptor.
   * Uses the same filter syntax as on() handlers.
   */
  filter?: PayloadFilter;
}

/**
 * Entry stored in the interceptor registry.
 * Similar to HandlerEntry but specific to interceptors.
 */
export interface InterceptorEntry<H> {
  handler: H;
  priority: number;
}

/**
 * Result of running the interceptor chain.
 * Used internally by emit() to determine if propagation was stopped
 * and what the (possibly transformed) payload is.
 */
export interface InterceptorResult<P> {
  /**
   * True if stopPropagation() was called.
   */
  stopped: boolean;

  /**
   * The final payload after any transformations.
   */
  payload: P;
}
