import type { BusMessage, MakaioBusContext } from '../types/index.js';
import { pushAdvertisedSubjectsToPeers } from './advertised-state.js';
import { normalizeSubscriptionDeliveryClass } from './subscription-delivery.js';
import type { BusTransportKeys } from './transport-registry.js';

/**
 * Replace remote subscription state for one transport and update peer advertisements.
 * @param context - Bus context containing remote subscription registries
 * @param sourceTransportName - Transport that sent the subscription
 * @param message - Full-replacement subscribe message
 */
export async function propagateSubscribe(
  context: MakaioBusContext,
  sourceTransportName: BusTransportKeys,
  message: Extract<BusMessage, { type: 'subscribe' }>,
): Promise<void> {
  const sourceName = String(sourceTransportName);
  for (const [subject, priorities] of Object.entries(message.subjects)) {
    const deliveryClass = normalizeSubscriptionDeliveryClass(message.deliveryClasses?.[subject]);
    const existing = context.remoteRequestHandlers.get(subject);
    const filtered = existing ? existing.filter((entry) => entry.transport !== sourceName) : [];
    for (const priority of priorities) {
      filtered.push({ transport: sourceName, priority });
    }
    if (filtered.length > 0) {
      context.remoteRequestHandlers.set(subject, filtered);
    } else {
      context.remoteRequestHandlers.delete(subject);
    }

    const deliveryByTransport = context.remoteSubscriptionDeliveryClasses.get(subject) ?? new Map();
    deliveryByTransport.set(sourceName, deliveryClass);
    context.remoteSubscriptionDeliveryClasses.set(subject, deliveryByTransport);

    if (priorities.length === 0) {
      const eventTransports = context.remoteEventHandlers.get(subject) ?? new Set<string>();
      eventTransports.add(sourceName);
      context.remoteEventHandlers.set(subject, eventTransports);
    } else {
      removeRemoteEventSubscription(context, subject, sourceName);
    }
  }

  await pushAdvertisedSubjectsToPeers(context, sourceTransportName, Object.keys(message.subjects));
}

/**
 * Remove remote subscription state for one transport and update peer advertisements.
 * @param context - Bus context containing remote subscription registries
 * @param sourceTransportName - Transport that sent the unsubscription
 * @param message - Full-removal unsubscribe message
 */
export async function propagateUnsubscribe(
  context: MakaioBusContext,
  sourceTransportName: BusTransportKeys,
  message: Extract<BusMessage, { type: 'unsubscribe' }>,
): Promise<void> {
  const sourceName = String(sourceTransportName);
  for (const subject of Object.keys(message.subjects)) {
    const existing = context.remoteRequestHandlers.get(subject);
    if (existing) {
      const filtered = existing.filter((entry) => entry.transport !== sourceName);
      if (filtered.length === 0) {
        context.remoteRequestHandlers.delete(subject);
      } else {
        context.remoteRequestHandlers.set(subject, filtered);
      }
    }

    removeRemoteEventSubscription(context, subject, sourceName);
    const deliveryByTransport = context.remoteSubscriptionDeliveryClasses.get(subject);
    deliveryByTransport?.delete(sourceName);
    if (deliveryByTransport?.size === 0) {
      context.remoteSubscriptionDeliveryClasses.delete(subject);
    }
  }

  await pushAdvertisedSubjectsToPeers(context, sourceTransportName, Object.keys(message.subjects));
}

/**
 * Purge every subscription learned through a disconnected transport.
 * @param context - Bus context containing remote subscription registries
 * @param transportName - Transport being removed
 */
export function purgeRemoteHandlersForTransport(context: MakaioBusContext, transportName: string): void {
  const affectedSubjects = new Set<string>();
  for (const [subject, entries] of context.remoteRequestHandlers) {
    const filtered = entries.filter((entry) => entry.transport !== transportName);
    if (filtered.length === entries.length) continue;
    if (filtered.length === 0) {
      context.remoteRequestHandlers.delete(subject);
    } else {
      context.remoteRequestHandlers.set(subject, filtered);
    }
    affectedSubjects.add(subject);
  }
  for (const [subject, transportSet] of context.remoteEventHandlers) {
    if (!transportSet.delete(transportName)) continue;
    if (transportSet.size === 0) {
      context.remoteEventHandlers.delete(subject);
    }
    affectedSubjects.add(subject);
  }
  for (const [subject, deliveryByTransport] of context.remoteSubscriptionDeliveryClasses) {
    if (!deliveryByTransport.delete(transportName)) continue;
    if (deliveryByTransport.size === 0) {
      context.remoteSubscriptionDeliveryClasses.delete(subject);
    }
    affectedSubjects.add(subject);
  }

  if (affectedSubjects.size > 0) {
    void pushAdvertisedSubjectsToPeers(context, transportName as BusTransportKeys, [...affectedSubjects]);
  }
}

/**
 * Remove one event-only subscription and its empty subject container.
 * @param context - Bus context containing event-only subscription state
 * @param subject - Subject pattern whose source is being removed
 * @param transportName - Source transport to remove
 */
function removeRemoteEventSubscription(context: MakaioBusContext, subject: string, transportName: string): void {
  const eventTransports = context.remoteEventHandlers.get(subject);
  eventTransports?.delete(transportName);
  if (eventTransports?.size === 0) {
    context.remoteEventHandlers.delete(subject);
  }
}
