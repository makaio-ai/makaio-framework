import { describe, it, expect, spyOn } from 'bun:test';
import { ServerTransport } from '../server-transport.js';
import { MockWebSocket, MockWebSocketServer } from './test-helpers.js';
import type { BusBroadcastMessage, BusEventMessage, BusRequestMessage } from '@makaio/bus-core';
import { NO_HANDLER_ERROR_CODE, NoHandlerError } from '@makaio/bus-core';
import type { TransportAuth, WebSocketLike, WebSocketServerLike } from '../types.js';

class FailingSendWebSocket extends MockWebSocket {
  send(_data: string | BufferSource | Blob): void {
    throw new Error('simulated send failure');
  }
}

class CountingWebSocketServer implements WebSocketServerLike {
  public readonly connectionListeners = new Set<(socket: WebSocketLike) => void>();
  public readonly onCalls: number[] = [];
  public readonly offCalls: number[] = [];

  public on(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  public on(event: 'error', listener: (error: Error) => void): void;
  public on(event: 'close', listener: () => void): void;
  public on(
    event: 'connection' | 'error' | 'close',
    listener: ((socket: WebSocketLike) => void) | ((error: Error) => void) | (() => void),
  ): void {
    if (event === 'connection') {
      this.connectionListeners.add(listener as (socket: WebSocketLike) => void);
      this.onCalls.push(this.connectionListeners.size);
    }
  }

  public off(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  public off(event: 'error', listener: (error: Error) => void): void;
  public off(event: 'close', listener: () => void): void;
  public off(
    event: 'connection' | 'error' | 'close',
    listener: ((socket: WebSocketLike) => void) | ((error: Error) => void) | (() => void),
  ): void {
    if (event === 'connection') {
      this.connectionListeners.delete(listener as (socket: WebSocketLike) => void);
      this.offCalls.push(this.connectionListeners.size);
    }
  }

  public close(callback?: (err?: Error) => void): void {
    callback?.();
  }
}

describe('Server mode behavior', () => {
  it('manages multiple client connections and broadcasts', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({
      websocket: wss,
    });

    try {
      await transport.connect();

      const client1 = new MockWebSocket();
      const client2 = new MockWebSocket();

      wss.simulateConnection(client1);
      wss.simulateConnection(client2);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const eventMessage: BusEventMessage = {
        type: 'event',
        namespace: 'test',
        subject: 'broadcast',
        payload: { message: 'hello all' },
        messageId: 'evt-broadcast',
      };

      await transport.send(eventMessage);

      expect(client1.sentMessages).toHaveLength(1);
      expect(client2.sentMessages).toHaveLength(1);
      expect(JSON.parse(client1.sentMessages[0])).toMatchObject({
        namespace: 'test',
        subject: 'broadcast',
      });
    } finally {
      await transport.disconnect();
    }
  });

  it('rejects a second connect and unregisters the connection listener on disconnect', async () => {
    const wss = new CountingWebSocketServer();
    const transport = new ServerTransport({
      websocket: wss,
    });

    try {
      await transport.connect();
      expect(wss.connectionListeners.size).toBe(1);
      expect(wss.onCalls).toEqual([1]);

      await expect(transport.connect()).rejects.toThrow('ServerTransport.connect() called while already connected');
      expect(wss.connectionListeners.size).toBe(1);
      expect(wss.onCalls).toEqual([1]);

      await transport.disconnect();
      expect(wss.connectionListeners.size).toBe(0);
      expect(wss.offCalls).toEqual([0]);
    } finally {
      await transport.disconnect();
      expect(wss.connectionListeners.size).toBe(0);
    }
  });

  it('removes disconnected clients', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({
      websocket: wss,
    });

    try {
      await transport.connect();

      const client = new MockWebSocket();

      wss.simulateConnection(client);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Test that client is connected by sending a message successfully
      const testMessage: BusEventMessage = {
        type: 'event',
        namespace: 'test',
        subject: 'event',
        payload: {},
        messageId: 'evt-test',
      };
      await expect(transport.send(testMessage)).resolves.toBeTruthy();

      client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // After client disconnects, sending should return false
      await expect(transport.send(testMessage)).resolves.toBeFalsy();
    } finally {
      await transport.disconnect();
    }
  });

  it('returns false when sending event with no clients connected', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({
      websocket: wss,
    });

    try {
      await transport.connect();

      const eventMessage: BusEventMessage = {
        type: 'event',
        namespace: 'test',
        subject: 'event',
        payload: {},
        messageId: 'evt-fail',
      };

      await expect(transport.send(eventMessage)).resolves.toBeFalsy();
    } finally {
      await transport.disconnect();
    }
  });

  it('retries next client when first client reports no handler', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({
      websocket: wss,
    });

    try {
      await transport.connect();

      const client1 = new MockWebSocket();
      const client2 = new MockWebSocket();

      wss.simulateConnection(client1);
      wss.simulateConnection(client2);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const request: BusRequestMessage = {
        type: 'request',
        namespace: 'dialog',
        subject: 'confirm',
        payload: { title: 'Tool approval' },
        correlationId: 'corr-dialog-confirm',
        messageId: 'req-dialog-confirm',
      };

      const responsePromise = transport.send(request);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const firstDispatch = JSON.parse(client1.sentMessages[0]);
      client1.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: firstDispatch.correlationId,
          error: {
            message: 'No handler registered for request subject "dialog.confirm"',
            code: NO_HANDLER_ERROR_CODE,
            data: { subject: 'dialog.confirm' },
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(client2.sentMessages).toHaveLength(1);
      const secondDispatch = JSON.parse(client2.sentMessages[0]);
      client2.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: secondDispatch.correlationId,
          result: { selectedOptionId: 'allow' },
        }),
      );

      await expect(responsePromise).resolves.toEqual({ selectedOptionId: 'allow' });
    } finally {
      await transport.disconnect();
    }
  });

  it('ignores stale first-attempt responses after retrying another client', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({
      websocket: wss,
    });

    try {
      await transport.connect();

      const client1 = new MockWebSocket();
      const client2 = new MockWebSocket();

      wss.simulateConnection(client1);
      wss.simulateConnection(client2);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const request: BusRequestMessage = {
        type: 'request',
        namespace: 'dialog',
        subject: 'confirm',
        payload: { title: 'Tool approval' },
        correlationId: 'corr-dialog-race',
        messageId: 'req-dialog-race',
      };

      const responsePromise = transport.send(request);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const firstDispatch = JSON.parse(client1.sentMessages[0]);
      client1.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: firstDispatch.correlationId,
          error: {
            message: 'No handler registered for request subject "dialog.confirm"',
            code: NO_HANDLER_ERROR_CODE,
            data: { subject: 'dialog.confirm' },
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      const secondDispatch = JSON.parse(client2.sentMessages[0]);
      expect(secondDispatch.correlationId).not.toBe(firstDispatch.correlationId);

      // Simulate a delayed duplicate response from the first client after retry started.
      client1.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: firstDispatch.correlationId,
          error: {
            message: 'No handler registered for request subject "dialog.confirm"',
            code: NO_HANDLER_ERROR_CODE,
            data: { subject: 'dialog.confirm' },
          },
        }),
      );

      client2.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: secondDispatch.correlationId,
          result: { selectedOptionId: 'allow' },
        }),
      );

      await expect(responsePromise).resolves.toEqual({ selectedOptionId: 'allow' });
    } finally {
      await transport.disconnect();
    }
  });

  it('continues client-initiated broadcast when one target client send throws', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss });

    try {
      await transport.connect();

      const sender = new MockWebSocket();
      const failingTarget = new FailingSendWebSocket();
      const healthyTarget = new MockWebSocket();

      wss.simulateConnection(sender);
      wss.simulateConnection(failingTarget);
      wss.simulateConnection(healthyTarget);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const broadcast: BusBroadcastMessage = {
        type: 'broadcast',
        namespace: 'test',
        subject: 'fanout',
        payload: { msg: 'hello' },
        correlationId: 'corr-client-broadcast',
        messageId: 'msg-client-broadcast',
      };

      sender.receiveMessage(JSON.stringify(broadcast));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(healthyTarget.sentMessages).toHaveLength(1);
      expect(JSON.parse(healthyTarget.sentMessages[0])).toMatchObject({
        type: 'broadcast',
        namespace: 'test',
        subject: 'fanout',
      });
    } finally {
      await transport.disconnect();
    }
  });

  it('bounds client-supplied broadcast timeouts before tracking aggregation state', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss });
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    try {
      await transport.connect();

      const sender = new MockWebSocket();
      const target = new MockWebSocket();

      wss.simulateConnection(sender);
      wss.simulateConnection(target);
      await new Promise((resolve) => setTimeout(resolve, 50));
      setTimeoutSpy.mockClear();

      const oversizedBroadcast: BusBroadcastMessage = {
        type: 'broadcast',
        namespace: 'test',
        subject: 'fanout',
        payload: { msg: 'hello' },
        correlationId: 'corr-client-broadcast-oversized-timeout',
        messageId: 'msg-client-broadcast-oversized-timeout',
        timeout: Number.MAX_SAFE_INTEGER,
      };
      const disabledTimeoutBroadcast: BusBroadcastMessage = {
        ...oversizedBroadcast,
        correlationId: 'corr-client-broadcast-disabled-timeout',
        messageId: 'msg-client-broadcast-disabled-timeout',
        timeout: 0,
      };

      sender.receiveMessage(JSON.stringify(oversizedBroadcast));
      sender.receiveMessage(JSON.stringify(disabledTimeoutBroadcast));

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
    } finally {
      setTimeoutSpy.mockRestore();
      await transport.disconnect();
    }
  });

  it('sends requests to clients regardless of subscription state', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss });

    try {
      await transport.connect();

      const client = new MockWebSocket();
      wss.simulateConnection(client);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Subscribe to a DIFFERENT subject — request should still reach this client
      client.receiveMessage(
        JSON.stringify({
          type: 'subscribe',
          subjects: { 'dialog.other': [] },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const request: BusRequestMessage = {
        type: 'request',
        namespace: 'dialog',
        subject: 'confirm',
        payload: { title: 'Tool approval' },
        correlationId: 'corr-unfiltered',
        messageId: 'req-unfiltered',
      };

      const responsePromise = transport.send(request);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(client.sentMessages).toHaveLength(1);
      const dispatched = JSON.parse(client.sentMessages[0]);
      client.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: dispatched.correlationId,
          result: { selectedOptionId: 'allow' },
        }),
      );

      await expect(responsePromise).resolves.toEqual({ selectedOptionId: 'allow' });
    } finally {
      await transport.disconnect();
    }
  });

  it('prioritizes matching subscriptions before catch-all clients for requests', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss });

    try {
      await transport.connect();

      const catchAllClient = new MockWebSocket();
      const matchingClient = new MockWebSocket();

      // Connect catch-all first so insertion order alone would pick it.
      wss.simulateConnection(catchAllClient);
      wss.simulateConnection(matchingClient);
      await new Promise((resolve) => setTimeout(resolve, 50));

      matchingClient.receiveMessage(
        JSON.stringify({
          type: 'subscribe',
          subjects: { 'dialog.confirm': [] },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const request: BusRequestMessage = {
        type: 'request',
        namespace: 'dialog',
        subject: 'confirm',
        payload: { title: 'Tool approval' },
        correlationId: 'corr-priority',
        messageId: 'req-priority',
      };

      const responsePromise = transport.send(request, 5000);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(matchingClient.sentMessages).toHaveLength(1);
      expect(catchAllClient.sentMessages).toHaveLength(0);

      const dispatched = JSON.parse(matchingClient.sentMessages[0]);
      matchingClient.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: dispatched.correlationId,
          result: { selectedOptionId: 'allow' },
        }),
      );

      await expect(responsePromise).resolves.toEqual({ selectedOptionId: 'allow' });
    } finally {
      await transport.disconnect();
    }
  });

  it('propagates onBroadcastResults errors to the originating client', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss });

    try {
      await transport.connect();

      const sender = new MockWebSocket();
      wss.simulateConnection(sender);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const broadcast: BusBroadcastMessage = {
        type: 'broadcast',
        namespace: 'test',
        subject: 'fanout',
        payload: { msg: 'hello' },
        correlationId: 'corr-node-error',
        messageId: 'msg-node-error',
      };

      sender.receiveMessage(JSON.stringify(broadcast));
      await new Promise((resolve) => setTimeout(resolve, 20));

      transport.onBroadcastResults?.(broadcast.correlationId, [], {
        message: 'Node execution failed',
        code: 'NODE_FAILED',
      });

      expect(sender.sentMessages).toHaveLength(1);
      expect(JSON.parse(sender.sentMessages[0])).toEqual({
        type: 'broadcast-response',
        correlationId: 'corr-node-error',
        error: {
          message: 'Node execution failed',
          code: 'NODE_FAILED',
        },
      });
    } finally {
      await transport.disconnect();
    }
  });

  it('throws NoHandlerError when no clients are connected for a request', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss });

    try {
      await transport.connect();

      const request: BusRequestMessage = {
        type: 'request',
        namespace: 'dialog',
        subject: 'confirm',
        payload: { title: 'Tool approval' },
        correlationId: 'corr-no-clients',
        messageId: 'req-no-clients',
      };

      await expect(transport.send(request)).rejects.toThrow(NoHandlerError);
    } finally {
      await transport.disconnect();
    }
  });

  it('throws NoHandlerError when all clients decline with no-handler', async () => {
    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss });

    try {
      await transport.connect();

      const client = new MockWebSocket();
      wss.simulateConnection(client);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const request: BusRequestMessage = {
        type: 'request',
        namespace: 'dialog',
        subject: 'confirm',
        payload: { title: 'Tool approval' },
        correlationId: 'corr-no-handling',
        messageId: 'req-no-handling',
      };

      const sendPromise = transport.send(request);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const dispatched = JSON.parse(client.sentMessages[0]);
      client.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: dispatched.correlationId,
          error: {
            message: 'No handler registered for request subject "dialog.confirm"',
            code: NO_HANDLER_ERROR_CODE,
            data: { subject: 'dialog.confirm' },
          },
        }),
      );

      await expect(sendPromise).rejects.toThrow(NoHandlerError);
    } finally {
      await transport.disconnect();
    }
  });

  it('closes sockets that are still authenticating during disconnect', async () => {
    let releaseAuth: (() => void) | undefined;
    let cleanupSocketCalls = 0;
    const auth: TransportAuth = {
      authenticateClient: async () => {},
      authenticateServer: async () =>
        await new Promise<void>((resolve) => {
          releaseAuth = resolve;
        }),
      handleAuthMessage: () => false,
      cleanupSocket: () => {
        cleanupSocketCalls += 1;
      },
      cleanup: () => {},
    };

    const wss = new MockWebSocketServer();
    const transport = new ServerTransport({ websocket: wss, auth });
    const client = new MockWebSocket();

    await transport.connect();
    wss.simulateConnection(client);
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      await transport.disconnect();

      expect(client.readyState).toBe(3);
      expect(cleanupSocketCalls).toBeGreaterThan(0);
    } finally {
      releaseAuth?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
});
