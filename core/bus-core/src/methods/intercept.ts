import type { MakaioBusContext, InterceptorEntry, InterceptOptions } from '../types/index.js';
import type { InterceptorContext, InterceptorHandler } from '../types/interceptor.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import { matchesFilter } from '../utils/payload-filter.js';
import { insertSorted } from '../utils/insert-sorted.js';
import type { SubjectDefinition } from '@makaio/core';

/**
 * Register an interceptor for a subject.
 *
 * Interceptors run BEFORE event/request handlers, enabling:
 * - Payload transformation via `replacePayload()`
 * - Event blocking via `stopPropagation()`
 * - Sequential execution in priority order (highest first)
 * @param context - Makaio bus context
 * @param subjectDefinition - Subject definition with subject pattern and metadata
 * @param handler - Interceptor handler function
 * @param options - Optional priority and filter options
 * @returns Unsubscribe function to remove the interceptor
 */
export function intercept<T extends SubjectDefinition>(
  context: MakaioBusContext,
  subjectDefinition: T,
  handler: InterceptorHandler<T['$meta']['payload']>,
  options?: InterceptOptions,
): () => void {
  const fullSubjectKey = getFullSubjectForSubjectDefinition(subjectDefinition);
  const priority = options?.priority ?? 0;

  // Ensure the entry array exists for this subject
  if (!context.interceptorHandlers.has(fullSubjectKey)) {
    context.interceptorHandlers.set(fullSubjectKey, []);
  }

  // Wrap handler with filter if provided
  const effectiveHandler: InterceptorHandler<unknown> = options?.filter
    ? (ctx: InterceptorContext<unknown>) => {
        if (!matchesFilter(ctx.payload, options.filter!)) {
          return; // Filter didn't match, skip interceptor
        }
        return handler(ctx as InterceptorContext<T['$meta']['payload']>);
      }
    : (handler as InterceptorHandler<unknown>);

  const entries = context.interceptorHandlers.get(fullSubjectKey)!;
  const entry: InterceptorEntry<InterceptorHandler<unknown>> = {
    handler: effectiveHandler,
    priority,
  };

  insertSorted(entries, entry);

  // Return unsubscribe function that removes this specific handler
  return () => {
    const currentEntries = context.interceptorHandlers.get(fullSubjectKey);
    if (currentEntries) {
      const index = currentEntries.findIndex((e) => e.handler === effectiveHandler);
      if (index !== -1) {
        currentEntries.splice(index, 1);
      }
      // Clean up empty arrays
      if (currentEntries.length === 0) {
        context.interceptorHandlers.delete(fullSubjectKey);
      }
    }
  };
}
