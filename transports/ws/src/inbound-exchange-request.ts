import type { BusRequestMessage } from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import type { ClientRegistry } from './client-registry.js';
import { ConnectionExchangeAuth } from './auth/connection-exchange-auth.js';
import type { TransportAuth, WebSocketLike } from './types.js';

/**
 * Bind an exchange request to a host-local response origin before dispatch.
 * @param request - Admitted request and remaining budget.
 * @param socket - Requesting connection.
 * @param deps - Authentication and response registry.
 * @param receiveContext - Locally verified connection context.
 * @returns Request and context for dispatch, or undefined when no origin can be bound.
 */
export function bindInboundRequest(
  request: BusRequestMessage,
  socket: WebSocketLike,
  deps: { readonly auth: TransportAuth | undefined; readonly registry: ClientRegistry },
  receiveContext?: TransportReceiveContext,
) {
  const exchange = deps.auth instanceof ConnectionExchangeAuth && deps.auth.hasExchangeSession(socket);
  if (exchange && typeof request.correlationId !== 'string') return undefined;
  const local = exchange ? { ...request, correlationId: globalThis.crypto.randomUUID() } : request;
  const origin = deps.registry.trackRequestOrigin(socket, local, exchange ? request.correlationId : undefined);
  if (exchange && origin === undefined) return undefined;
  const context = origin && receiveContext ? { ...receiveContext, requestOrigin: origin } : receiveContext;
  return { request: local, receiveContext: context };
}
