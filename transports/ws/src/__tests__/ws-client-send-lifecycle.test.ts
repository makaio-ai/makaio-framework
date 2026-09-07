import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionLostError, TimeoutError, type BusMessage, type BusRequestMessage } from '@makaio/bus-core';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { DEFAULT_CODEC } from '../ws-client-options.js';
import type { ClientTransportCodec } from '../types.js';
import { MockWebSocket } from './test-helpers.js';
import { waitForCondition } from './test-utils.js';

/**
 * Construct a unique real transport request.
 * @param id - Request identity for correlation and wire assertions.
 * @returns Request message.
 */
function request(id: string): BusRequestMessage {
  return { type: 'request', namespace: 'test', subject: 'work', messageId: id, correlationId: id, payload: {} };
}

const uncorrelatedMessages = [
  { type: 'event', namespace: 'test', subject: 'changed', messageId: 'event', payload: {} },
  { type: 'response', correlationId: 'incoming-request', result: {} },
  { type: 'subscribe-sync-complete' },
] satisfies BusMessage[];

const uncorrelatedClosingCases = uncorrelatedMessages.flatMap((message) =>
  [2, 3].map((readyState) => ({ type: message.type, message, readyState })),
);

describe('socket-session send lifecycle', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /**
   * Own real transport instances with deterministic socket transitions.
   * @param codec - Optional asynchronous encoding seam.
   * @returns Transport and adopted socket history.
   */
  async function connected(codec?: ClientTransportCodec) {
    const sockets: MockWebSocket[] = [];
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      autoReconnect: false,
      heartbeat: false,
      codec,
      createWebSocket: () => {
        const socket = new MockWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    cleanups.push(() => transport.disconnect());
    await transport.connect();
    return { transport, sockets };
  }

  it.each([
    [1000, 'CONNECTION_LOST'],
    [1008, 'WS_POLICY_REJECTED'],
  ] as const)('retains close %s classification between exchanges and through explicit cleanup', async (code, expected) => {
    const { transport, sockets } = await connected();
    sockets[0]!.close(code);
    await expect(transport.send(request('after-close'))).rejects.toMatchObject({ code: expected });
    await transport.disconnect();
    await expect(transport.send(request('after-cleanup'))).rejects.toMatchObject({ code: expected });
  });

  it('preserves a released policy outcome when send is immediately followed by connect', async () => {
    const { transport, sockets } = await connected();
    sockets[0]!.close(1008);
    // Let close drain release the socket while retaining its terminal session.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = transport.send(request('released-policy'), 0);
    const refused = expect(pending).rejects.toMatchObject({ code: 'WS_POLICY_REJECTED' });
    await transport.connect();
    await refused;
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sentMessages).toEqual([]);
    expect(transport.isReady()).toBe(true);
  });

  it.each([
    [1000, 'CONNECTION_LOST'],
    [1008, 'WS_POLICY_REJECTED'],
  ] as const)('observes CLOSING until close %s supplies a genuine classification', async (code, expected) => {
    const { transport, sockets } = await connected();
    const socket = sockets[0]!;
    socket.readyState = 2;
    let settled = false;
    const sending = transport.send(request('closing'), 0);
    void sending.finally(() => (settled = true)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    expect(socket.sentMessages).toEqual([]);
    const failed = expect(sending).rejects.toMatchObject({ code: expected });
    socket.close(code);
    await failed;
  });

  it.each([
    [1000, 'CONNECTION_LOST'],
    [1008, 'WS_POLICY_REJECTED'],
  ] as const)('does not send encoding completed during CLOSING before close %s', async (code, expected) => {
    const encoding = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    const { transport, sockets } = await connected({
      encode: () => {
        entered.resolve();
        return encoding.promise;
      },
      decode: DEFAULT_CODEC.decode,
    });
    const sending = transport.send(request('encode-closing'), 0);
    const failed = expect(sending).rejects.toMatchObject({ code: expected });
    await entered.promise;
    sockets[0]!.readyState = 2;
    encoding.resolve(JSON.stringify(request('encode-closing')));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets[0]!.sentMessages).toEqual([]);
    sockets[0]!.close(code);
    await failed;
  });

  it('fences late encoding and stale close callbacks away from a replacement session', async () => {
    const encoding = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    let encodes = 0;
    const { transport, sockets } = await connected({
      encode: async (message) => {
        if (++encodes === 1) {
          entered.resolve();
          return encoding.promise;
        }
        return JSON.stringify(message);
      },
      decode: DEFAULT_CODEC.decode,
    });
    const sending = transport.send(request('old'), 0);
    const failed = expect(sending).rejects.toBeInstanceOf(ConnectionLostError);
    await entered.promise;
    const old = sockets[0]!;
    const oldCloseListeners = [...(old.listeners.get('close') ?? [])];
    old.close();
    await failed;
    await transport.connect();
    const next = sockets[1]!;
    const nextReply = transport.send(request('new'), 1000);
    await waitForCondition(() => next.sentMessages.some((message) => message.includes('"new"')));
    encoding.resolve(JSON.stringify(request('old')));
    for (const listener of oldCloseListeners) listener({ code: 1008 });
    next.receiveMessage(JSON.stringify({ type: 'response', correlationId: 'new', result: 'fresh' }));
    await expect(nextReply).resolves.toBe('fresh');
    expect(next.sentMessages.some((message) => message.includes('"old"'))).toBe(false);
    expect(transport.isReady()).toBe(true);
  });

  it('uses the original request timeout to bound CLOSING observation', async () => {
    const { transport, sockets } = await connected();
    sockets[0]!.readyState = 2;
    await expect(transport.send(request('timed'), 20)).rejects.toBeInstanceOf(TimeoutError);
    sockets[0]!.close(1008);
    expect(sockets[0]!.sentMessages).toEqual([]);
  });

  it.each(uncorrelatedClosingCases)('rejects an uncorrelated $type without waiting in state $readyState', async ({
    message,
    readyState,
  }) => {
    const { transport, sockets } = await connected();
    const socket = sockets[0]!;
    socket.readyState = readyState;
    const failure = await transport.send(message, 0).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('code');
    expect(socket.sentMessages).toEqual([]);
    expect(socket.readyState).toBe(readyState);
  });

  it.each(uncorrelatedClosingCases)('does not wait or send an encoded $type after entering state $readyState', async ({
    message,
    readyState,
  }) => {
    const encoding = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    const { transport, sockets } = await connected({
      encode: () => {
        entered.resolve();
        return encoding.promise;
      },
      decode: DEFAULT_CODEC.decode,
    });
    const failure = transport.send(message, 0).catch((error: unknown) => error);
    await entered.promise;
    sockets[0]!.readyState = readyState;
    encoding.resolve(JSON.stringify(message));
    expect(await failure).toBeInstanceOf(Error);
    expect(await failure).not.toHaveProperty('code');
    expect(sockets[0]!.sentMessages).toEqual([]);
    expect(sockets[0]!.readyState).toBe(readyState);
  });

  it.each([
    [1000, 'CONNECTION_LOST'],
    [1008, 'WS_POLICY_REJECTED'],
  ] as const)('preserves recorded close %s for an uncorrelated send', async (code, expected) => {
    const { transport, sockets } = await connected();
    sockets[0]!.close(code);
    await expect(transport.send(uncorrelatedMessages[0]!, 0)).rejects.toMatchObject({ code: expected });
  });

  it.each(['closing', 'encoding'] as const)('cancelRequest stops %s without sending later', async (phase) => {
    const encoding = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    const { transport, sockets } = await connected({
      encode: () => {
        entered.resolve();
        return encoding.promise;
      },
      decode: DEFAULT_CODEC.decode,
    });
    if (phase === 'closing') sockets[0]!.readyState = 2;
    const failure = new Error('caller cancelled this request');
    const sending = transport.send(request('cancelled'), 0);
    const failed = expect(sending).rejects.toBe(failure);
    if (phase === 'encoding') await entered.promise;
    transport.cancelRequest('cancelled', failure);
    await failed;
    encoding.resolve(JSON.stringify(request('cancelled')));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets[0]!.sentMessages).toEqual([]);
  });

  it('explicit disconnect settles CLOSING observers and removes socket listeners', async () => {
    const { transport, sockets } = await connected();
    const socket = sockets[0]!;
    socket.readyState = 2;
    const failed = expect(transport.send(request('disconnect'), 0)).rejects.toBeInstanceOf(ConnectionLostError);
    await transport.disconnect();
    await failed;
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
});
