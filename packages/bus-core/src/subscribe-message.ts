/**
 * Shared utilities for building subscribe and unsubscribe wire messages.
 */

import type { PayloadFilter } from '@makaio/core';
import type { BusSubscribeMessage, BusUnsubscribeMessage } from './types/transports.js';

/**
 * Per-subject subscription state tracked locally on a client transport.
 */
export interface SubscriptionEntry {
  /** Optional payload filter for server-side smart-routing. */
  filter?: PayloadFilter;
  /** Handler priorities registered for this subject. Empty array = event-only. */
  priorities: number[];
}

/**
 * Build a BusSubscribeMessage from local subscription state.
 * @param subscriptions - Map of subject patterns to their subscription entries
 * @returns Wire-format subscribe message
 */
export function buildSubscribeMessage(subscriptions: Map<string, SubscriptionEntry>): BusSubscribeMessage {
  const subjects: Record<string, number[]> = {};
  const filters: Record<string, PayloadFilter> = {};

  for (const [subject, entry] of subscriptions) {
    subjects[subject] = entry.priorities;
    if (entry.filter !== undefined) {
      filters[subject] = entry.filter;
    }
  }

  return {
    type: 'subscribe',
    subjects,
    ...(Object.keys(filters).length > 0 && { filters }),
  };
}

/**
 * Build a BusUnsubscribeMessage for specific subjects and priorities.
 * @param subjects - Map of subject patterns to priorities being removed
 * @returns Wire-format unsubscribe message
 */
export function buildUnsubscribeMessage(subjects: Record<string, number[]>): BusUnsubscribeMessage {
  return {
    type: 'unsubscribe',
    subjects,
  };
}
