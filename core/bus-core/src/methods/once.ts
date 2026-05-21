import type { MakaioBusContext } from '../types/index.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import { getOnPropagationPromise, on } from './on.js';
import type { HandlerForSubjectDefinition, PayloadFilter, SubjectDefinition, TypedPayloadFilter } from '@makaio/core';

/**
 * Options for the Promise-based once() method.
 */
export type OnceOptions<T extends SubjectDefinition> = {
  /** Timeout in milliseconds - rejects promise if event not received within this time */
  timeoutMs?: number;
  /**
   * Declarative payload filter for smart-routing.
   *
   * Applied both locally and can be sent to transports for server-side filtering.
   * Replaces the old function-based filter for serialization support.
   * @example
   * ```typescript
   * await bus.once(Subjects.message, {
   *   filter: {
   *     agentId: 'agent-123',
   *     'raw.msg.type': 'session_configured',
   *   }
   * });
   * ```
   */
  filter?: TypedPayloadFilter<T['$meta']['payload']>;
  /** AbortSignal to cancel waiting */
  signal?: AbortSignal;
};

/**
 * Error thrown when `once()` rejects because its `AbortSignal` was
 * triggered. Consumers that intentionally abort a pending listener can use
 * `instanceof OnceAbortError` to distinguish the expected rejection from real
 * failures.
 */
export class OnceAbortError extends Error {
  public constructor() {
    super('once() was aborted via AbortSignal');
    this.name = 'OnceAbortError';
  }
}

/**
 * Error thrown when once() times out waiting for an event.
 */
export class OnceTimeoutError extends Error {
  public constructor(subject: string, timeoutMs: number) {
    super(`once() timed out after ${timeoutMs}ms waiting for subject: ${subject}`);
    this.name = 'OnceTimeoutError';
  }
}

/**
 * Extract the context type that a handler receives for a given subject definition.
 * This is used to type the Promise return value correctly for both events and requests.
 */
type ContextForSubjectDefinition<T extends SubjectDefinition> = Parameters<HandlerForSubjectDefinition<T>>[0];

/**
 * Register a one-time event or request handler that auto-unsubscribes after first invocation.
 *
 * Wraps the `on()` method to automatically unsubscribe after the handler fires once.
 * The handler is removed BEFORE being invoked to prevent re-entrance issues if the
 * handler triggers the same event.
 * @param context - Makaio bus context
 * @param subjectDefinition - Subject definition with subject pattern and metadata
 * @param handler - Handler function (EventHandler for events, RequestHandler for requests)
 * @returns Unsubscribe function for manual cleanup if needed
 * @example Basic one-time event handler
 * ```typescript
 * const { subjects: AgentSubjects } = MakaioBus.registerNamespace('agent', {
 *   started: z.object({ agentId: z.string() }),
 * });
 *
 * once(AgentSubjects.started, (context) => {
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
 *   context.setResult({ approved: true });
 * });
 *
 * await request(AgentSubjects.toolApprove, { toolName: 'deleteFile' }); // Handler fires
 * await request(AgentSubjects.toolApprove, { toolName: 'createFile' }); // Handler does NOT fire
 * ```
 * @see {@link on} for the underlying subscription mechanism
 */
export function once<T extends SubjectDefinition>(
  context: MakaioBusContext,
  subjectDefinition: T,
  handler: HandlerForSubjectDefinition<T>,
): () => void;

/**
 * Wait for an event or request to occur, returning a Promise.
 * @param context - Makaio bus context
 * @param subjectDefinition - Subject definition with subject pattern and metadata
 * @param options - Options for timeout, filter, and abort signal
 * @returns Promise that resolves with the event/request context
 * @example Simple await
 * ```typescript
 * const ctx = await once(context, Subjects.init);
 * console.debug('Event received:', ctx.payload);
 * ```
 * @example With timeout
 * ```typescript
 * try {
 *   const ctx = await once(context, Subjects.init, { timeoutMs: 5000 });
 * } catch (err) {
 *   if (err instanceof OnceTimeoutError) {
 *     console.debug('Timed out waiting for event');
 *   }
 * }
 * ```
 * @example With declarative filter (waits for matching event)
 * ```typescript
 * const ctx = await once(context, Subjects.message, {
 *   filter: { sessionId: expectedId }
 * });
 * // Resolves only when a message with matching sessionId is received
 * ```
 * @example With AbortSignal
 * ```typescript
 * const controller = new AbortController();
 * const promise = once(context, Subjects.init, { signal: controller.signal });
 * controller.abort(); // Cancels the wait
 * ```
 */
export function once<T extends SubjectDefinition>(
  context: MakaioBusContext,
  subjectDefinition: T,
  options?: OnceOptions<T>,
): Promise<ContextForSubjectDefinition<T>>;

export function once<T extends SubjectDefinition>(
  context: MakaioBusContext,
  subjectDefinition: T,
  handlerOrOptions?: HandlerForSubjectDefinition<T> | OnceOptions<T>,
): (() => void) | Promise<ContextForSubjectDefinition<T>> {
  // Callback version - if third param is a function
  if (typeof handlerOrOptions === 'function') {
    const handler = handlerOrOptions as HandlerForSubjectDefinition<T>;
    let unsubscribe: (() => void) | null = null;

    const wrappedHandler: HandlerForSubjectDefinition<T> = ((ctx: unknown) => {
      // Remove self BEFORE calling handler to prevent re-entrance issues
      const unsub = unsubscribe;
      unsubscribe = null;
      unsub?.();

      return (handler as (ctx: unknown) => void | Promise<void>)(ctx);
    }) as HandlerForSubjectDefinition<T>;

    unsubscribe = on(context, subjectDefinition, wrappedHandler);

    // Return unsubscribe function for manual cleanup if needed
    return () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
  }

  // Promise version - if third param is options or undefined
  const options = handlerOrOptions as OnceOptions<T> | undefined;

  return new Promise<ContextForSubjectDefinition<T>>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    let abortHandler: (() => void) | null = null;
    const signal = options?.signal;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    // Setup AbortSignal listener if provided
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new OnceAbortError());
        return;
      }

      abortHandler = () => {
        cleanup();
        reject(new OnceAbortError());
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Subscribe to event with filter passed to on() for local filtering.
    // The handler is registered synchronously — local delivery works immediately.
    unsubscribe = on(
      context,
      subjectDefinition,
      ((ctx: ContextForSubjectDefinition<T>) => {
        // Match found - cleanup and resolve
        cleanup();
        resolve(ctx);
      }) as HandlerForSubjectDefinition<T>,
      options?.filter ? { filter: options.filter as PayloadFilter } : undefined,
    );

    // Defer timeout until subscription is propagated to transports.
    // This closes the race where an event fires between the subscribe
    // message being queued and the server processing it.
    // The handler is already registered (local delivery is immediate) —
    // only the timeout timer is deferred.
    const propagated = getOnPropagationPromise(unsubscribe);
    const startTimer = (): void => {
      if (options?.timeoutMs && unsubscribe !== null) {
        timer = setTimeout(() => {
          cleanup();
          reject(new OnceTimeoutError(getFullSubjectForSubjectDefinition(subjectDefinition), options.timeoutMs!));
        }, options.timeoutMs);
      }
    };

    if (propagated) {
      void propagated.then(startTimer, startTimer);
    } else {
      startTimer();
    }
  });
}
