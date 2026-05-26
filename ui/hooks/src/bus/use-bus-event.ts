/**
 * React hook for subscribing to bus event subjects.
 *
 * Registers a handler on mount and unregisters it on unmount. The handler
 * reference is kept in a ref so re-renders with a new function do not cause
 * an unsubscribe/resubscribe cycle — the latest function is always invoked.
 * @packageDocumentation
 */

import { useEffect, useRef } from 'react';
import type { EventHandler, EventMessagePayload, ExtractSubjectPayload, SubjectDefinition } from '@makaio/core';
import { useBus } from './bus-provider.js';

type NonChannelEventSubjectDefinition = SubjectDefinition & {
  readonly $meta: {
    readonly channel: false;
    readonly isRequest: false;
    readonly payload: EventMessagePayload;
  };
};
type HandlerForBusEvent<Subject extends NonChannelEventSubjectDefinition> = EventHandler<
  ExtractSubjectPayload<Subject>
>;
type BusEventSubscriber<Subject extends NonChannelEventSubjectDefinition> = {
  on(subject: Subject, handler: HandlerForBusEvent<Subject>): () => void;
};

/**
 * Subscribe to a bus event subject for the lifetime of the component.
 *
 * The subscription is established once on mount (and whenever `bus` or
 * `subject` change). Passing a new `handler` reference on re-render does
 * NOT cause an unsubscribe/resubscribe — the latest handler is always called.
 *
 * This pattern ensures that closures capturing component state stay fresh
 * without the overhead of re-registering on every render.
 * @param subject - The event subject definition to subscribe to.
 * @param handler - The event handler to invoke when the subject fires.
 * @example
 * ```tsx
 * useBusEvent(SessionNamespace.subjects.messageAdded, (ctx) => {
 *   setMessages((prev) => [...prev, ctx.payload]);
 * });
 * ```
 */
export function useBusEvent<Subject extends NonChannelEventSubjectDefinition>(
  subject: Subject,
  handler: HandlerForBusEvent<Subject>,
): void {
  type Handler = HandlerForBusEvent<Subject>;
  type HandlerContext = Parameters<Handler>[0];
  type HandlerResult = ReturnType<Handler>;

  const bus = useBus();

  // Always hold the latest handler so the stable bus subscription calls it
  // without needing to re-register every time the closure changes.
  const handlerRef = useRef<(context: HandlerContext) => HandlerResult>(handler);
  handlerRef.current = handler;

  useEffect(() => {
    // Wrap the ref call so the bus sees a stable function reference.
    const stableWrapper = ((context: HandlerContext) => handlerRef.current(context)) as Handler;

    return (bus as BusEventSubscriber<Subject>).on(subject, stableWrapper);
  }, [bus, subject]);
}
