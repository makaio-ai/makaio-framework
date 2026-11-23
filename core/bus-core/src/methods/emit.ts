import type {
  BusEventMessage,
  EmitOptions,
  HandlerEntry,
  MakaioBusContext,
  WithReceiveContext,
} from '../types/index.js';
import { nanoid } from 'nanoid';

import { hostPartyOf } from '../call-context/carrier.js';
import { trackOpenHandlerCall } from '../call-context/own-work.js';
import { enterSend } from '../call-context/send-entry.js';
import { wireMetadataOf } from '../call-context/wire.js';

import { matchesSubscription } from '../utils/subscription-matching.js';
import { isExplicitLocalOnlyTransportSpec, normalizeTransportTargets } from './request/normalizeTransportTargets.js';
import { resolveEffectiveTransports } from './resolve-effective-transports.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import { invokeAnyHandlers } from '../utils/invoke-any-handlers.js';
import { notifyMessageObservers } from '../observability/subject-telemetry-projector.js';
import { validateEventPayload } from '../utils/validate-event-payload.js';
import { mergeSortedHandlerArrays } from '../utils/handler-merging.js';
import { executeInterceptors } from './intercept/index.js';
import { warnIfUnregistered } from '../utils/warn-unregistered.js';
import type { CallContext, EventHandler, PartyRef, SubjectDefinition, TransportReceiveContext } from '@makaio/core';

/**
 * Emit options plus the trusted receive context. The call is never an option:
 * a send passes it as a parameter, a received message enters through
 * {@link emitReceived}.
 */
type InternalEmitOptions = EmitOptions & Omit<WithReceiveContext, 'call'>;

/**
 * Get all handlers that match the given subject.
 *
 * Iterates through all registered patterns and collects handlers
 * from patterns that match the subject (exact or wildcard).
 * Returns handlers sorted by priority (highest first).
 * @param context - Makaio bus context
 * @param subject - Subject to match against
 * @returns Array of all matching handler entries sorted by priority
 */
function getMatchingHandlers(context: MakaioBusContext, subject: string): Array<HandlerEntry<EventHandler<unknown>>> {
  const { eventHandlers } = context;
  const matchingArrays: Array<Array<HandlerEntry<EventHandler<unknown>>>> = [];

  for (const [pattern, entries] of eventHandlers) {
    if (matchesSubscription(subject, pattern)) {
      matchingArrays.push(entries);
    }
  }

  return mergeSortedHandlerArrays(matchingArrays);
}

/**
 * The `metadata` field of an outbound message for `call`, or nothing when the
 * principal is this host itself.
 * @param context - Makaio bus context (names the own host)
 * @param call - Call context the message carries
 * @returns An object to spread into the wire message
 */
function wireMetadataField(context: MakaioBusContext, call: CallContext): Pick<BusEventMessage, 'metadata'> {
  const metadata = wireMetadataOf(call, hostPartyOf(context));
  return metadata === undefined ? {} : { metadata };
}

interface EventContext {
  payload: unknown;
  messageId: string;
  correlationId: string | undefined;
  subject: string;
  isRequest: false;
  call: CallContext;
  transport?: TransportReceiveContext;
}

/**
 * Execute event handlers in parallel.
 *
 * Each handler gets its own context object and runs inside
 * {@link trackOpenHandlerCall} for the carrier that registered it (the entry's
 * owner), not the carrier of the sender.
 * @param handlers - Array of handler entries to execute
 * @param eventContext - Context to pass to each handler
 * @param fullSubjectKey - Full subject key for error logging
 */
async function executeHandlers(
  handlers: Array<HandlerEntry<EventHandler<unknown>>>,
  eventContext: EventContext,
  fullSubjectKey: string,
): Promise<void> {
  const { correlationId, messageId } = eventContext;
  const promises: Promise<unknown>[] = [];

  for (const { handler, owner } of handlers) {
    let handlerResult: void | Promise<void>;
    try {
      // Start each handler before emit yields so it can synchronously install a
      // dependent subscription. Its asynchronous completion remains parallel
      // with every sibling and is awaited below.
      handlerResult = trackOpenHandlerCall(owner, () => handler({ ...eventContext }));
    } catch (error) {
      handlerResult = Promise.reject(error);
    }
    promises.push(
      Promise.resolve(handlerResult).catch((error) => {
        const logPrefix = correlationId ? `[${correlationId}][${messageId}]` : `[${messageId}]`;
        console.error(`${logPrefix} Error in event handler for "${fullSubjectKey}":`, error);
        throw error;
      }),
    );
  }

  await Promise.all(promises);
}

/**
 * Emit an event from a bus instance (the entry for SENDS).
 *
 * Enters through {@link enterSend}, which derives the context the event carries
 * from the sending instance's carrier and the passed `call` (caller is the
 * carrier, principal and attestation come from `call`) and reports a send of an
 * own context, and delivers through {@link emitReceived}. Public send surfaces pass the carrier
 * and `call` through; none derives or checks the call itself.
 *
 * Local handlers are invoked synchronously after a fully synchronous
 * interceptor chain completes, then execute in parallel and are awaited before
 * this resolves, so an awaited emit orders subsequent work after the handlers'
 * effects. An asynchronous interceptor defers handler admission until it
 * settles; a stopped chain does not invoke handlers. Handler
 * errors are logged and never stop sibling handlers, but they reject the
 * returned promise.
 * @param context - Makaio bus context
 * @param carrier - Carrier of the sending bus instance
 * @param call - Call context the sender passed
 * @param subjectDefinition - Concrete event subject (wildcards not allowed)
 * @param payload - Event payload
 * @param options - Emit options (messageId, correlationId, transports)
 * @throws InvalidCallContextError When `call` was not minted by the core.
 * @throws ForeignOwnContextError When `call` belongs to another carrier or bus context.
 * @see {@link IMakaioBus.emit} for full documentation and examples.
 */
export async function emit<T extends SubjectDefinition>(
  context: MakaioBusContext,
  carrier: PartyRef,
  call: CallContext,
  subjectDefinition: T,
  payload: T['$meta']['payload'],
  options?: InternalEmitOptions,
): Promise<void> {
  const sent = enterSend(call, context, carrier, getFullSubjectForSubjectDefinition(subjectDefinition));
  await emitReceived(context, sent, subjectDefinition, payload, options);
}

/**
 * Deliver an event whose call context already stands (the entry for contexts
 * that are ALREADY MINTED, i.e. received messages).
 *
 * The transport receive path builds the context with `callFromReceive` and
 * enters here; nothing is derived or checked again. `emit` enters here after
 * {@link enterSend}.
 * @param context - Makaio bus context
 * @param call - The finished call context the handlers and interceptors see
 * @param subjectDefinition - Concrete event subject (wildcards not allowed)
 * @param payload - Event payload
 * @param options - Emit options (messageId, correlationId, transports)
 */
// eslint-disable-next-line max-lines-per-function -- effectiveTransports resolution, message construction for canSend-aware routing, and transport dispatch are one routing decision; splitting would fragment it
export async function emitReceived<T extends SubjectDefinition>(
  context: MakaioBusContext,
  call: CallContext,
  subjectDefinition: T,
  payload: T['$meta']['payload'],
  options?: InternalEmitOptions,
): Promise<void> {
  const subject = subjectDefinition.subject;
  const fullSubjectKey = getFullSubjectForSubjectDefinition(subjectDefinition);

  warnIfUnregistered(context, subjectDefinition, fullSubjectKey);

  const messageId = options?.messageId ?? nanoid();
  const correlationId = options?.correlationId;
  // Determine effective transports early so localOnly telemetry reflects the
  // actual routing decision (including defaultTransports suppression).
  const effectiveTransports = resolveEffectiveTransports(
    context,
    subjectDefinition,
    fullSubjectKey,
    options?.transports,
  );
  const localOnly =
    subjectDefinition.$meta.local ||
    context.namespaceRegistry.isCollectorOnlySubject(fullSubjectKey) ||
    isExplicitLocalOnlyTransportSpec(effectiveTransports);

  // Validate payload in development (skip for namespaces with Zod version conflicts)
  validateEventPayload(context, fullSubjectKey, payload);

  // Run interceptors BEFORE handlers (may transform payload or stop propagation)
  // Note: executeInterceptors returns synchronously if no interceptors are registered
  // to preserve timing semantics. Only await if we get a promise back.
  const interceptorResultOrPromise = executeInterceptors(
    call,
    context,
    fullSubjectKey,
    payload,
    messageId,
    correlationId,
  );
  const interceptorResult =
    interceptorResultOrPromise instanceof Promise ? await interceptorResultOrPromise : interceptorResultOrPromise;

  // If an interceptor stopped propagation, skip handlers and transports entirely
  if (interceptorResult.stopped) {
    return;
  }

  // Use the (possibly transformed) payload from interceptors
  const finalPayload = interceptorResult.payload;

  // Find all handlers matching this subject (exact or wildcard patterns)
  const handlers = getMatchingHandlers(context, fullSubjectKey);

  // Invoke __onAny handlers (debugging/testing) - fires for all events
  invokeAnyHandlers(
    context,
    'event',
    fullSubjectKey,
    subjectDefinition.$meta.namespace,
    finalPayload,
    messageId,
    correlationId,
  );

  // Notify production-capable message observers (fire-and-forget)
  notifyMessageObservers(context, {
    type: 'event',
    namespace: subjectDefinition.$meta.namespace,
    subject: subject,
    payload: finalPayload,
    messageId,
    correlationId,
    transport: options?.transport,
    caller: { kind: call.caller.kind, id: call.caller.id },
    principal: { kind: call.principal.kind, id: call.principal.id },
    localOnly,
  });

  // Execute local handlers in parallel
  if (handlers.length > 0) {
    const eventContext: EventContext = {
      payload: finalPayload,
      messageId,
      correlationId,
      subject: fullSubjectKey,
      isRequest: false,
      call,
      transport: options?.transport,
    };
    await executeHandlers(handlers, eventContext, fullSubjectKey);
  }

  // Build the outbound event message once so it can be used for both transport
  // selection (canSend gate) and the actual wire send — avoids duplicating the
  // object literal and keeps the two uses in sync.
  const eventMessage: BusEventMessage = {
    type: 'event',
    subject: subject,
    namespace: subjectDefinition.$meta.namespace,
    payload: finalPayload,
    messageId,
    correlationId,
    ...wireMetadataField(context, call),
  };

  // effectiveTransports was resolved above alongside localOnly.
  // Pass the event message so transports with canSend can apply per-message
  // eligibility (e.g. relay codec passing control-plane frames pre-session).
  const transportTargets = normalizeTransportTargets(context, effectiveTransports, subjectDefinition, eventMessage);

  // Send to transports if applicable
  if (transportTargets.length > 0) {
    const transportPromises: Promise<unknown>[] = [];

    for (const transport of transportTargets) {
      const send =
        options?.connectionId === undefined
          ? transport.send(eventMessage)
          : (transport.sendToConnection?.(eventMessage, options.connectionId) ??
            Promise.reject(new Error(`Transport '${transport.name}' does not support connection-scoped delivery`)));
      transportPromises.push(
        send.catch((error: unknown) => {
          // Log errors but don't fail the whole emission
          const logPrefix = correlationId ? `[${correlationId}][${messageId}]` : `[${messageId}]`;
          console.error(`${logPrefix} Error sending event "${subject}" to transport:`, error);
        }),
      );
    }

    await Promise.all(transportPromises);
  }
}
