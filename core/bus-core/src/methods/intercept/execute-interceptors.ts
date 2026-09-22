import type { MakaioBusContext, InterceptorContext, InterceptorResult, InterceptorHandler } from '../../types/index.js';

/**
 * Get interceptors registered for the exact subject.
 * Returns interceptors sorted by priority (highest first).
 * @param context - Makaio bus context containing interceptor registry
 * @param subject - Subject key to look up interceptors for
 * @returns Array of interceptor handlers in priority order
 */
function getMatchingInterceptors(context: MakaioBusContext, subject: string): Array<InterceptorHandler<unknown>> {
  const entries = context.interceptorHandlers.get(subject);
  if (!entries || entries.length === 0) {
    return [];
  }
  return entries.map((entry) => entry.handler);
}

/**
 * Execute all matching interceptors for an event.
 *
 * Interceptors run sequentially in priority order. Each can:
 * - Call replacePayload() to transform the payload for subsequent interceptors/handlers
 * - Call stopPropagation() to abort the chain and prevent handlers from running
 * - Do nothing (implicit continue)
 *
 * Errors fail fast - subsequent interceptors and handlers are skipped.
 *
 * **Timing contract:** Returns synchronously when every interceptor completes
 * synchronously, preserving immediate local-handler admission in `emit()`. The
 * first interceptor that returns a promise defers the remaining chain and local
 * handlers until it settles. A stopped chain never admits handlers.
 * @param context - Makaio bus context containing interceptor registry
 * @param subject - Subject key to look up interceptors for
 * @param initialPayload - Original payload to pass through interceptor chain
 * @param messageId - Unique message identifier
 * @param correlationId - Optional correlation ID for tracing
 * @returns Result containing stopped flag and final payload after transformations
 */
export function executeInterceptors<P>(
  context: MakaioBusContext,
  subject: string,
  initialPayload: P,
  messageId: string,
  correlationId: string | undefined,
): InterceptorResult<P> | Promise<InterceptorResult<P>> {
  const interceptors = getMatchingInterceptors(context, subject);

  // A synchronous chain must remain synchronous so emit() can admit local
  // handlers before returning. executeInterceptorChain switches to a promise
  // only after an interceptor actually returns one.
  return executeInterceptorChain(interceptors, subject, initialPayload, messageId, correlationId);
}

/**
 * Execute the interceptor chain sequentially.
 * @param interceptors - Array of interceptor handlers to execute
 * @param subject - Subject key for context
 * @param initialPayload - Original payload
 * @param messageId - Message identifier
 * @param correlationId - Correlation ID for tracing
 * @returns Result after running all interceptors
 */
function executeInterceptorChain<P>(
  interceptors: Array<InterceptorHandler<unknown>>,
  subject: string,
  initialPayload: P,
  messageId: string,
  correlationId: string | undefined,
): InterceptorResult<P> | Promise<InterceptorResult<P>> {
  let currentPayload = initialPayload;
  let stopped = false;

  const continueFrom = (startIndex: number): InterceptorResult<P> | Promise<InterceptorResult<P>> => {
    for (let index = startIndex; index < interceptors.length; index += 1) {
      if (stopped) break;

      // Create context for this interceptor
      const ctx: InterceptorContext<P> = {
        subject,
        get payload() {
          return currentPayload;
        },
        messageId,
        correlationId,
        stopPropagation() {
          stopped = true;
        },
        replacePayload(newPayload: P) {
          currentPayload = newPayload;
        },
        next() {
          // Explicit continue - no-op since we continue by default
        },
      };

      const result = interceptors[index]!(ctx as InterceptorContext<unknown>);
      if (result instanceof Promise) {
        return result.then(() => continueFrom(index + 1));
      }
    }

    return { stopped, payload: currentPayload };
  };

  return continueFrom(0);
}
