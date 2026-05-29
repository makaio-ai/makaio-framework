/**
 * Subscription management helpers for `WebSocketClientTransport`.
 *
 * Extracts the subscribe/unsubscribe logic from the transport class so the
 * main module stays focused on the `BusTransport` contract, lifecycle
 * orchestration, and state management.
 */

import type { WebSocketLike, ClientTransportCodec } from './types.js';
import { sendEncoded } from './transport-helpers.js';
import { buildSubscribeMessage, buildUnsubscribeMessage, type SubscriptionEntry } from './subscribe-message.js';
import type { PayloadFilter } from '@makaio/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pending acknowledgement for a dynamic subscription control message.
 */
export interface SubscriptionAckHandle {
  ackId: string;
  promise: Promise<void>;
  reject(error: unknown): void;
}

/**
 * Dependencies required by the subscription helpers.
 */
export interface SubscriptionDeps {
  /** Transport name used in debug log prefixes. */
  readonly name: string;
  /** Whether verbose debug logging is enabled. */
  readonly debug: boolean;
  /** Wire codec used to encode subscription messages. */
  readonly codec: ClientTransportCodec;
  /** Active socket, or `null` when not connected. */
  readonly socket: WebSocketLike | null;
  /** Buffered local subscription map to persist across reconnects. */
  readonly localSubscriptions: Map<string, SubscriptionEntry>;
  /** Begin tracking an acknowledgement for a dynamic subscription update. */
  readonly beginSubscriptionAck?: () => SubscriptionAckHandle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Add or update a subject subscription, persisting it for reconnect replay.
 *
 * If the socket is open, sends the subscribe message immediately.
 * Replaces any existing entry — the full priority set is always sent, so
 * appending would double-count previously reported priorities.
 * @param subject - Subject pattern (supports wildcards like `'adapter.*'`)
 * @param filter - Optional payload filter; `undefined` preserves the existing filter
 * @param priorities - Handler priorities registered for this subject
 * @param deps - Subscription context
 */
export async function addSubscription(
  subject: string,
  filter: PayloadFilter | undefined,
  priorities: number[],
  deps: SubscriptionDeps,
): Promise<void> {
  const existingFilter = deps.localSubscriptions.get(subject)?.filter;
  const resolvedFilter = filter ?? existingFilter;
  deps.localSubscriptions.set(subject, { filter: resolvedFilter, priorities });

  if (deps.socket !== null && deps.socket.readyState === 1) {
    const ack = deps.beginSubscriptionAck?.();
    const message = buildSubscribeMessage(new Map([[subject, { filter: resolvedFilter, priorities }]]), ack?.ackId);
    try {
      await sendEncoded(message, deps.codec, deps.socket);
      await ack?.promise;
    } catch (error) {
      ack?.reject(error);
      throw error;
    }
  }

  if (deps.debug) {
    console.info(
      `[WebSocketClientTransport:${deps.name}] Subscribed to ${subject}${resolvedFilter ? ' with filter' : ''}`,
    );
  }
}

/**
 * Remove a subject subscription, clearing it from the replay buffer.
 *
 * If the socket is open, sends the unsubscribe message immediately.
 * @param subject - Subject to unsubscribe from
 * @param deps - Subscription context
 */
export async function removeSubscription(subject: string, deps: SubscriptionDeps): Promise<void> {
  const existing = deps.localSubscriptions.get(subject);
  deps.localSubscriptions.delete(subject);

  if (deps.socket !== null && deps.socket.readyState === 1) {
    const ack = deps.beginSubscriptionAck?.();
    const message = buildUnsubscribeMessage({ [subject]: existing?.priorities ?? [] }, ack?.ackId);
    try {
      await sendEncoded(message, deps.codec, deps.socket);
      await ack?.promise;
    } catch (error) {
      ack?.reject(error);
      throw error;
    }
  }

  if (deps.debug) {
    console.info(`[WebSocketClientTransport:${deps.name}] Unsubscribed from ${subject}`);
  }
}
