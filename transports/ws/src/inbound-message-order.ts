import type { BusMessage, BusSubscribeMessage, BusUnsubscribeMessage } from '@makaio/bus-core';
import { ConnectionExchangeAuth } from './auth/connection-exchange-auth.js';
import { createInboundQueue } from './deferred-subscription-replay.js';
import { anchorInboundBudget } from './inbound-request-budget.js';
import type { MessageHandlerDeps, routeMessage } from './server-message-handler.js';
import type { WebSocketLike } from './types.js';

type RouteMessage = typeof routeMessage;

/** Release the routing turn and handle a failed publication after handoff. */
export interface RoutingHandoff {
  readonly release: () => void;
  readonly retire: () => void;
}

/**
 * Identify subscription state updates that must run in arrival order.
 * @param message - Inbound bus message.
 * @returns Whether this is a subscribe or unsubscribe message.
 */
export function isSubscriptionMessage(message: BusMessage): message is BusSubscribeMessage | BusUnsubscribeMessage {
  return message.type === 'subscribe' || message.type === 'unsubscribe';
}

/**
 * Check owner authority and wait for routing handoff while observing dispatch errors.
 * @param admission - Owner check and retirement for the source session.
 * @param route - Routing operation for the checked frame.
 */
async function routeProtectedMessage(
  admission: NonNullable<ReturnType<ConnectionExchangeAuth['getRunMessageAdmission']>>,
  route: (handoff: RoutingHandoff) => Promise<void>,
): Promise<void> {
  if (!(await admission.verify())) return;
  const handedOff = Promise.withResolvers<void>();
  const dispatch = route({
    release: () => handedOff.resolve(),
    retire: admission.retire,
  });
  // A refusal or synchronous routing effect can finish without invoking any handlers.
  // Keep observing the routing promise even when handoff wins.
  await Promise.race([dispatch, handedOff.promise]);
}

/**
 * Share the subscription and protected-frame ordering boundary for this socket.
 * @param socket - Sending connection.
 * @param deps - Handler dependencies.
 * @param routeMessage - The normal application routing operation.
 * @param lifetime - Aborted when the connection is detached.
 * @returns An ingress dispatcher for parsed messages.
 */
export function createInboundRouter(
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  routeMessage: RouteMessage,
  lifetime?: AbortSignal,
) {
  const { auth, registry } = deps;
  const exchange = auth instanceof ConnectionExchangeAuth ? auth : undefined;
  const queue = createInboundQueue(
    socket,
    deps,
    registry.deferredSubscriptionsFor(socket),
    (message, replay) => {
      const admission = exchange?.getRunMessageAdmission(socket);
      return admission === undefined
        ? routeMessage(message, socket, deps, replay)
        : routeProtectedMessage(admission, (handoff) =>
            routeMessage(message, socket, deps, replay, undefined, handoff),
          );
    },
    lifetime,
  );

  return (message: BusMessage, data: string | Buffer): Promise<void> => {
    const subscription = isSubscriptionMessage(message);
    const replay = subscription ? queue.replay : undefined;
    const admission = message.type === 'heartbeat' ? undefined : exchange?.getRunMessageAdmission(socket);
    if (admission !== undefined) {
      const budget = anchorInboundBudget(message, deps.normalizeBroadcastTimeout, deps.now);
      const bytes = Buffer.byteLength(data);
      return queue.enqueue(
        () =>
          routeProtectedMessage(admission, (handoff) => routeMessage(message, socket, deps, replay, budget, handoff)),
        { bytes, subscriptionBytes: subscription ? bytes : 0, maxBytes: admission.maxQueuedBytes },
        admission.retire,
      );
    }
    if (subscription) {
      const bytes = Buffer.byteLength(data);
      return queue.enqueue(
        () => routeMessage(message, socket, deps, replay),
        { bytes, subscriptionBytes: bytes },
        () => socket.close(1008, 'Queued subscription frames exceed byte limit'),
      );
    }
    return routeMessage(message, socket, deps);
  };
}
