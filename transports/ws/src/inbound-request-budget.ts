import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveInboundRequestBudget,
  TimeoutError,
  type BusBroadcastMessage,
  type BusMessage,
  type BusRequestMessage,
} from '@makaio/bus-core';
import { sendRejectedMessage } from './server-boundary-access.js';
import type { WebSocketLike } from './types.js';

export interface InboundBudget {
  /** Effective timeout at ingress, in milliseconds. */
  readonly timeout: number;
  /** Deadline on the receiving host's clock. */
  readonly deadline: number;
  /** Clock used to measure elapsed authorization time. */
  readonly now: () => number;
}

/**
 * Anchor the relative wire budget before the transport awaits authorization.
 * @param message - Incoming frame.
 * @param normalizeBroadcastTimeout - The server's broadcast timeout policy.
 * @param now - Clock used throughout the lifetime of the budget.
 * @returns Bounded request or broadcast budget, if applicable.
 */
export function anchorInboundBudget(
  message: BusMessage,
  normalizeBroadcastTimeout: (timeout: unknown) => number,
  now: () => number = Date.now,
): InboundBudget | undefined {
  if (message.type !== 'request' && message.type !== 'broadcast') return undefined;
  const timeout =
    message.type === 'broadcast'
      ? normalizeBroadcastTimeout(message.timeout)
      : (resolveInboundRequestBudget(message.timeout) ?? DEFAULT_REQUEST_TIMEOUT_MS);
  return timeout > 0 ? { timeout, deadline: now() + timeout, now } : undefined;
}

/**
 * Charge authorization time before dispatch or fan-out.
 * @param message - Incoming request or broadcast.
 * @param budget - Budget anchored at the transport boundary.
 * @param socket - Requesting connection.
 * @param send - Safe callback for sending the timeout response.
 * @returns Message carrying the remaining timeout, or undefined after expiry.
 */
export function prepareInboundMessage<T extends BusRequestMessage | BusBroadcastMessage>(
  message: T,
  budget: InboundBudget | undefined,
  socket: WebSocketLike,
  send: (socket: WebSocketLike, frame: string) => void,
): (T & { timeout: number }) | undefined {
  if (budget === undefined) return { ...message, timeout: 0 };
  const remaining = budget.deadline - budget.now();
  if (remaining > 0) return { ...message, timeout: remaining };
  sendRejectedMessage(
    message,
    socket,
    send,
    new TimeoutError(`${message.namespace}.${message.subject}`, budget.timeout),
  );
  return undefined;
}
