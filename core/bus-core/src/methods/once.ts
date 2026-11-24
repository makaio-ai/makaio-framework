import type { MakaioBusContext } from '../types/index.js';
import { AccessDeniedError } from '@makaio/contracts/access';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import { subscriptionSignal } from '../subscription-lifetime.js';
import { getOnPropagationPromise, on } from './on.js';
import { resolveEffectiveTransports } from './resolve-effective-transports.js';
import type {
  HandlerForSubjectDefinition,
  PartyRef,
  PayloadFilter,
  SubjectDefinition,
  TypedPayloadFilter,
} from '@makaio/core';

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
 * @param owner - Carrier of the bus instance registering the handler; becomes the owner of the underlying `on()` entry
 * @param subjectDefinition - Subject definition with subject pattern and metadata
 * @param handler - Handler function (EventHandler for events, RequestHandler for requests)
 * @returns Unsubscribe function for manual cleanup if needed
 * @example Basic one-time event handler
 * ```typescript
 * import { createBusNamespace } from '@makaio/core';
 * import { createBusInstance } from '@makaio/bus-core';
 * import { z } from 'zod';
 *
 * const definition = createBusNamespace('agent', {
 *   started: z.object({ agentId: z.string() }),
 * });
 * const bus = createBusInstance();
 * const { subjects: AgentSubjects } = bus.registerNamespace(definition);
 *
 * bus.once(AgentSubjects.started, (context) => {
 *   console.debug('Agent started once:', context.payload.agentId);
 * });
 *
 * // ORIGIN: The example initiates this event.
 * await bus.emit(bus.own('root'), AgentSubjects.started, { agentId: 'agent-123' }); // Handler fires
 * // ORIGIN: The example initiates this event.
 * await bus.emit(bus.own('root'), AgentSubjects.started, { agentId: 'agent-456' }); // Handler does NOT fire
 * ```
 * @example Manual unsubscribe before first fire
 * ```typescript
 * const unsubscribe = bus.once(AgentSubjects.started, (context) => {
 *   console.debug('This will never run');
 * });
 *
 * unsubscribe(); // Manually unsubscribe before event fires
 * // ORIGIN: The example initiates this event.
 * await bus.emit(bus.own('root'), AgentSubjects.started, { agentId: 'agent-123' }); // Handler does NOT fire
 * ```
 * @example One-time request handler
 * ```typescript
 * import { createBusNamespace } from '@makaio/core';
 * import { createBusInstance } from '@makaio/bus-core';
 * import { z } from 'zod';
 *
 * const definition = createBusNamespace('agent', {
 *   toolApprove: {
 *     request: z.object({ toolName: z.string() }),
 *     response: z.object({ approved: z.boolean() }),
 *   },
 * });
 * const bus = createBusInstance();
 * const { subjects: AgentSubjects } = bus.registerNamespace(definition);
 *
 * bus.once(AgentSubjects.toolApprove, (context) => {
 *   context.setResult({ approved: true });
 * });
 *
 * // ORIGIN: The example initiates this request.
 * await bus.request(bus.own('root'), AgentSubjects.toolApprove, { toolName: 'deleteFile' }); // Handler fires
 * // ORIGIN: The example initiates this request.
 * const result = await bus.requestOptional(bus.own('root'), AgentSubjects.toolApprove, { toolName: 'createFile' });
 * console.debug(result.handled); // false
 * ```
 * @see {@link on} for the underlying subscription mechanism
 */
export function once<T extends SubjectDefinition>(
  context: MakaioBusContext,
  owner: PartyRef,
  subjectDefinition: T,
  handler: HandlerForSubjectDefinition<T>,
): () => void;

/**
 * Wait for an event or request to occur, returning a Promise.
 * @param context - Makaio bus context
 * @param owner - Carrier of the bus instance registering the handler; becomes the owner of the underlying `on()` entry
 * @param subjectDefinition - Subject definition with subject pattern and metadata
 * @param options - Options for timeout, filter, and abort signal
 * @returns Promise that resolves with the event/request context
 * @example Simple await
 * ```typescript
 * const ctx = await once(context, owner, Subjects.init);
 * console.debug('Event received:', ctx.payload);
 * ```
 * @example With timeout
 * ```typescript
 * try {
 *   const ctx = await once(context, owner, Subjects.init, { timeoutMs: 5000 });
 * } catch (err) {
 *   if (err instanceof OnceTimeoutError) {
 *     console.debug('Timed out waiting for event');
 *   }
 * }
 * ```
 * @example With declarative filter (waits for matching event)
 * ```typescript
 * const ctx = await once(context, owner, Subjects.message, {
 *   filter: { sessionId: expectedId }
 * });
 * // Resolves only when a message with matching sessionId is received
 * ```
 * @example With AbortSignal
 * ```typescript
 * const controller = new AbortController();
 * const promise = once(context, owner, Subjects.init, { signal: controller.signal });
 * controller.abort(); // Cancels the wait
 * ```
 */
export function once<T extends SubjectDefinition>(
  context: MakaioBusContext,
  owner: PartyRef,
  subjectDefinition: T,
  options?: OnceOptions<T>,
): Promise<ContextForSubjectDefinition<T>>;

export function once<T extends SubjectDefinition>(
  context: MakaioBusContext,
  owner: PartyRef,
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

    unsubscribe = on(context, owner, subjectDefinition, wrappedHandler);
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
  const subject = getFullSubjectForSubjectDefinition(subjectDefinition);
  const signal = subscriptionSignal(owner, subject, context.debugLog, options?.signal);
  if (signal === false) return Promise.reject(new OnceAbortError());

  return new Promise<ContextForSubjectDefinition<T>>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    let abortHandler: (() => void) | null = null;

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

    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };

    // Setup AbortSignal listener if provided
    if (signal) {
      if (signal.aborted) return fail(new OnceAbortError());
      abortHandler = () => fail(new OnceAbortError());
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    let acceptedByTransport = false;
    let denial: AccessDeniedError | undefined;
    // Subscribe to event with filter passed to on() for local filtering.
    // The handler is registered synchronously — local delivery works immediately.
    unsubscribe = on(
      context,
      owner,
      subjectDefinition,
      ((ctx: ContextForSubjectDefinition<T>) => {
        // Match found - cleanup and resolve
        cleanup();
        resolve(ctx);
      }) as HandlerForSubjectDefinition<T>,
      options?.filter ? { filter: options.filter as PayloadFilter } : undefined,
      (accepted, error) => {
        acceptedByTransport ||= accepted;
        if (error instanceof AccessDeniedError) denial ??= error;
      },
    );

    // Defer timeout until subscription is propagated to transports.
    // This closes the race where an event fires between the subscribe
    // message being queued and the server processing it.
    // The handler is already registered (local delivery is immediate) —
    // only the timeout timer is deferred.
    const finishPropagation = (): void => {
      if (unsubscribe === null) return;
      if (denial && !acceptedByTransport && !hasLocalRoute(context, subjectDefinition, subject)) return fail(denial);
      if (options?.timeoutMs) {
        timer = setTimeout(() => fail(new OnceTimeoutError(subject, options.timeoutMs!)), options.timeoutMs);
      }
    };

    void Promise.resolve(getOnPropagationPromise(unsubscribe)).then(finishPropagation);
  });
}

/**
 * Check whether the subject has an explicitly local publication route.
 * @param context - Bus holding namespace routing defaults.
 * @param definition - Subject token supplied to once.
 * @param subject - Fully qualified subject name.
 * @returns Whether an in-process publisher can be the intended source.
 */
function hasLocalRoute(context: MakaioBusContext, definition: SubjectDefinition, subject: string): boolean {
  return (
    definition.$meta.local === true ||
    context.namespaceRegistry.isLocalSubject(subject) ||
    resolveEffectiveTransports(context, definition, subject, undefined) !== undefined
  );
}
