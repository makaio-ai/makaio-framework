/**
 * Generic transport utilities for subscription filtering and correlation handling.
 *
 * These helpers are transport-agnostic and shared by all transport implementations
 * (WebSocket, MessageChannel, etc.) to provide consistent filtering and
 * correlation tracking logic.
 */

import type {
  BusMessage,
  BusResponseMessage,
  BusBroadcastResponseMessage,
  BusRequestMessage,
  BusBroadcastMessage,
  BusTransportError,
} from '../types/index.js';
import { matchesAnySubscription } from './subscription-matching.js';
import { matchesFilter } from './payload-filter.js';
import { deserializeTransportError } from './transport.js';
import type { PayloadFilter } from '@makaio/core';
import type { CorrelationTracker } from './correlation-tracker.js';

/**
 * Check if a client/tab wants to receive a message based on subscriptions and filters.
 *
 * **Filtering logic:**
 * - No subscriptions = receive all (default broadcast mode)
 * - With subscriptions: check if message subject matches any subscription pattern
 * - Apply payload filters if the client has filters for this subject
 * @param subject - The message subject (if any)
 * @param payload - The message payload (if any)
 * @param subscriptions - Set of subscription patterns
 * @param filters - Map of payload filters per subject
 * @returns true if the client should receive the message
 */
export function shouldReceiveMessage(
  subject: string | undefined,
  payload: unknown,
  subscriptions: Set<string>,
  filters: Map<string, PayloadFilter>,
): boolean {
  // No subscriptions = receive all (default broadcast mode)
  // Otherwise, check if message subject matches any subscription pattern
  if (subscriptions.size > 0 && subject && !matchesAnySubscription(subject, subscriptions)) {
    return false;
  }

  // Check payload filter if client has one for this subject
  if (subject && payload !== undefined) {
    for (const [filterSubject, filter] of filters) {
      // Check if this filter applies to the message subject
      if (filterSubject === subject || matchesAnySubscription(subject, new Set([filterSubject]))) {
        if (!matchesFilter(payload, filter)) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Handle response messages for correlation tracking.
 *
 * Processes both regular response and broadcast-response messages,
 * resolving or rejecting the corresponding correlation promise.
 * @param message - Decoded bus message
 * @param correlations - Correlation tracker instance
 * @returns true if the message was a response and was handled
 */
export function handleCorrelationResponse(message: BusMessage, correlations: CorrelationTracker): boolean {
  if (message.type === 'response') {
    const response = message as BusResponseMessage;
    if (response.error) {
      correlations.reject(response.correlationId, deserializeTransportError(response.error));
    } else {
      correlations.resolve(response.correlationId, response.result);
    }
    return true;
  }

  if (message.type === 'broadcast-response') {
    const response = message as BusBroadcastResponseMessage;
    if (response.error) {
      correlations.reject(response.correlationId, deserializeTransportError(response.error));
    } else {
      correlations.resolve(response.correlationId, response.results ?? []);
    }
    return true;
  }

  return false;
}

/**
 * Type guard for request messages.
 * @param message - Bus message to check
 * @returns true if message is a request
 */
function isRequestMessage(message: BusMessage): message is BusRequestMessage {
  return message.type === 'request';
}

/**
 * Type guard for broadcast messages.
 * @param message - Bus message to check
 * @returns true if message is a broadcast
 */
function isBroadcastMessage(message: BusMessage): message is BusBroadcastMessage {
  return message.type === 'broadcast';
}

/**
 * Track correlation for request/broadcast messages and return appropriate result type.
 *
 * **Behavior by message type:**
 * - Request: Returns promise tracking correlation (resolves to response payload)
 * - Broadcast: Returns promise tracking correlation (resolves to array of results)
 * - Other: Returns true immediately (no correlation tracking needed)
 *
 * **Timeout semantics:**
 * Pass `0` to disable automatic timeout — the correlation entry stays open
 * until resolved or rejected externally. All callers must supply an explicit
 * value; there is no default so callers cannot accidentally rely on a hidden timeout.
 * @param message - Bus message to process
 * @param correlations - Correlation tracker instance
 * @param timeout - Timeout in milliseconds; `0` means no automatic timeout
 * @param signal - Optional AbortSignal forwarded to correlation tracking cleanup
 * @returns Promise resolving to response data, broadcast results, or boolean
 */
export function trackMessageCorrelation<TMessage extends BusMessage>(
  message: TMessage,
  correlations: CorrelationTracker,
  timeout: number,
  signal?: AbortSignal,
): Promise<
  TMessage extends BusRequestMessage
    ? unknown
    : TMessage extends BusBroadcastMessage
      ? Array<{ nodeId: string; payload: unknown }>
      : boolean
> {
  type ReturnType = TMessage extends BusRequestMessage
    ? unknown
    : TMessage extends BusBroadcastMessage
      ? Array<{ nodeId: string; payload: unknown }>
      : boolean;

  // Track request correlation
  if (isRequestMessage(message)) {
    return correlations.track(message.correlationId, timeout, signal) as Promise<ReturnType>;
  }

  // Track broadcast correlation
  if (isBroadcastMessage(message)) {
    return correlations.track(message.correlationId, timeout, signal) as Promise<ReturnType>;
  }

  // For other message types (events, heartbeats, etc.), return true immediately
  return Promise.resolve(true as ReturnType);
}

/**
 * Serialize an error into a transport-safe structure.
 *
 * Preserves `subject` alongside `code` so that `isNoHandlerErrorForSubject`
 * can match deserialized errors without fragile message-string comparisons.
 * @param error - The error to serialize
 * @returns Structured error payload
 */
export function serializeTransportError(error: unknown): BusTransportError {
  const typed =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown; code?: string; subject?: unknown; data?: Record<string, unknown> })
      : {};
  const message =
    error instanceof Error ? error.message : typeof typed.message === 'string' ? typed.message : String(error);

  return {
    message,
    code: typed.code,
    subject: typeof typed.subject === 'string' ? typed.subject : undefined,
    data: typed.data,
  };
}
