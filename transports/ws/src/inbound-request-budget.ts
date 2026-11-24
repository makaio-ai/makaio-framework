import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveInboundRequestBudget,
  serializeTransportError,
  TimeoutError,
  type BusMessage,
  type BusRequestMessage,
} from '@makaio/bus-core';
import type { WebSocketLike } from './types.js';

interface InboundRequestBudget {
  /** Original relative wire budget, in milliseconds. */
  timeout: number;
  /** Deadline on the receiving host's clock. */
  deadline: number;
}

/**
 * Anchor the relative wire budget before the transport awaits authorization.
 * @param message - Incoming frame.
 * @returns Bounded request budget, if applicable.
 */
export function anchorInboundRequestBudget(message: BusMessage): InboundRequestBudget | undefined {
  if (message.type !== 'request') return undefined;
  const timeout = resolveInboundRequestBudget(message.timeout) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return timeout > 0 ? { timeout, deadline: Date.now() + timeout } : undefined;
}

/**
 * Charge transport time to the request before handing it to the bus.
 * @param request - Incoming request.
 * @param budget - Budget anchored at the transport boundary.
 * @param socket - Requesting connection.
 * @param send - Safe callback for sending an expired request's response.
 * @returns Request carrying the remaining timeout, or undefined after expiry.
 */
export function prepareInboundRequest(
  request: BusRequestMessage,
  budget: InboundRequestBudget | undefined,
  socket: WebSocketLike,
  send: (socket: WebSocketLike, frame: string) => void,
): BusRequestMessage | undefined {
  if (budget === undefined) return { ...request, timeout: 0 };
  const remaining = budget.deadline - Date.now();
  if (remaining > 0) return { ...request, timeout: remaining };
  const error = new TimeoutError(`${request.namespace}.${request.subject}`, budget.timeout);
  send(
    socket,
    JSON.stringify({ type: 'response', correlationId: request.correlationId, error: serializeTransportError(error) }),
  );
  return undefined;
}
