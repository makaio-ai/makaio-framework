import type { SubscriptionDeliveryClass } from '../types/transports.js';

/**
 * Normalize untrusted subscription delivery metadata without weakening relay boundaries.
 * @param value - Delivery-class value received from a transport message
 * @returns `relayable` only for the explicit known value; otherwise `first-hop-only`
 */
export function normalizeSubscriptionDeliveryClass(value: unknown): SubscriptionDeliveryClass {
  return value === 'relayable' ? 'relayable' : 'first-hop-only';
}
