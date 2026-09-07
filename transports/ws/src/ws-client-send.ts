import {
  ConnectionLostError,
  trackMessageCorrelation,
  type BusBroadcastMessage,
  type BusMessage,
  type BusRequestMessage,
  type CorrelationTracker,
} from '@makaio/bus-core';
import type { ClientTransportCodec } from './types.js';
import { ClientSocketSession, observeUntilAborted } from './ws-client-socket-session.js';

/** Existing BusTransport response shape, preserved by the session-bound send path. */
export type ClientSendResult<TMessage extends BusMessage> = TMessage extends BusRequestMessage
  ? unknown
  : TMessage extends BusBroadcastMessage
    ? Array<{ nodeId: string; payload: unknown }>
    : boolean;

/** Outbound work captures its socket session, never a mutable transport socket pointer. */
export interface ClientSendContext {
  readonly session: ClientSocketSession | null;
  readonly currentSession: () => ClientSocketSession | null;
  readonly name: string;
  readonly codec: ClientTransportCodec;
  readonly correlations: CorrelationTracker;
}

/**
 * Install request/broadcast correlation timeout/cancellation before async encoding
 * so encoding and CLOSING observation share that scope. Uncorrelated messages
 * reject unwritable sockets immediately instead of waiting without a deadline.
 * @param context - Captured session and current-owner lookup.
 * @param message - Message to send.
 * @param timeout - Existing correlation timeout; zero remains unlimited.
 * @returns Response or successful uncorrelated transmission.
 */
export async function sendClientMessage<TMessage extends BusMessage>(
  context: ClientSendContext,
  message: TMessage,
  timeout: number,
): Promise<ClientSendResult<TMessage>> {
  const session = context.session;
  if (session === null) throw new ConnectionLostError(context.name);
  // A terminal session cannot acquire fresh correlations that an immediate
  // reconnect could reject with a different outcome before transmit observes it.
  session.signal.throwIfAborted();
  if (message.type !== 'request' && message.type !== 'broadcast') {
    await transmit(context, session, message);
    return trackMessageCorrelation(message, context.correlations, timeout);
  }
  const cancellation = new AbortController();
  const reply = trackMessageCorrelation(message, context.correlations, timeout);
  const result = reply.then(
    (value) => {
      cancellation.abort();
      return value;
    },
    (error: unknown) => {
      cancellation.abort(error);
      throw error;
    },
  );
  void transmit(context, session, message, cancellation.signal).catch((failure: unknown) => {
    if (cancellation.signal.aborted) return;
    const error = failure instanceof Error ? failure : new Error('WebSocket send failed', { cause: failure });
    context.correlations.reject(message.correlationId, error);
  });
  return result;
}

/**
 * Encode and send only on the captured, still-current socket session.
 * @param context - Transport dependencies.
 * @param session - Session captured at send entry.
 * @param message - Outbound message.
 * @param signal - Existing correlation cancellation and timeout; absent for uncorrelated sends.
 */
async function transmit(
  context: ClientSendContext,
  session: ClientSocketSession,
  message: BusMessage,
  signal?: AbortSignal,
): Promise<void> {
  const initiallyWritable = session.writable(context.currentSession(), signal);
  if (initiallyWritable instanceof Promise) await initiallyWritable;
  const scope = signal === undefined ? session.signal : AbortSignal.any([signal, session.signal]);
  scope.throwIfAborted();
  const payload = await observeUntilAborted(context.codec.encode(message), scope);
  const socket = session.writable(context.currentSession(), signal);
  // An open-socket check and send share one synchronous turn. CLOSING rejects
  // immediately or waits for a correlated rejection, never permission to send.
  if (socket instanceof Promise) await socket;
  else socket.send(payload);
}
