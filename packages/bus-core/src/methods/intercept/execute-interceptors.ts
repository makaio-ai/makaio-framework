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
 * **Performance note:** Returns synchronously when no interceptors are registered
 * to preserve timing semantics of emit(). The promise is only introduced when
 * interceptors actually need to be executed.
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

  // Fast path: no interceptors, return synchronously to preserve timing
  if (interceptors.length === 0) {
    return { stopped: false, payload: initialPayload };
  }

  // Slow path: execute interceptors sequentially
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
async function executeInterceptorChain<P>(
  interceptors: Array<InterceptorHandler<unknown>>,
  subject: string,
  initialPayload: P,
  messageId: string,
  correlationId: string | undefined,
): Promise<InterceptorResult<P>> {
  let currentPayload = initialPayload;
  let stopped = false;

  for (const interceptor of interceptors) {
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

    // Execute interceptor (may be sync or async)
    await interceptor(ctx as InterceptorContext<unknown>);
  }

  return { stopped, payload: currentPayload };
}
