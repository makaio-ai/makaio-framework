import { createBusInstance } from '@makaio/bus-core';
import type { WebSocketLike } from '@makaio/bus-transport-websocket';
import { createBusNamespace } from '@makaio/core';
import { vi } from 'vitest';
import { z } from 'zod';

/** An open browser socket for exchanging frames with the transport. */
class FixtureWebSocket implements WebSocketLike {
  private readonly events = new EventTarget();
  public readyState = 1;

  /**
   * Register a listener for a browser socket event.
   * @param type - Socket event name.
   * @param listener - Listener to register.
   */
  public addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ): void {
    this.events.addEventListener(type, listener as EventListener);
  }

  /**
   * Remove a listener for a browser socket event.
   * @param type - Socket event name.
   * @param listener - Listener to remove.
   */
  public removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ): void {
    this.events.removeEventListener(type, listener as EventListener);
  }

  /**
   * Complete subscription sync when the client finishes its own sync.
   * @param data - Frame sent by the client.
   */
  public send(data: string | BufferSource | Blob): void {
    if (data === '{"type":"subscribe-sync-complete"}') this.receiveMessage(data);
  }

  /** Close the socket and notify its listeners. */
  public close(): void {
    this.readyState = 3;
    this.events.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  }

  /**
   * Deliver a frame from the peer to the client.
   * @param data - Frame to deliver.
   */
  public receiveMessage(data: string): void {
    this.events.dispatchEvent(new MessageEvent('message', { data }));
  }
}

/**
 * Set up a real bus and a fake WebSocket peer that can send a principal claim.
 * @returns The bus, socket, and observer for the call delivered to the bus handler.
 */
export function createPrincipalClaimFixture() {
  const bus = createBusInstance();
  const { subjects } = bus.registerNamespace(createBusNamespace('test', { received: z.object({}) }));
  const socket = new FixtureWebSocket();
  const createSocket = vi.fn(function FakeWebSocket() {
    return socket;
  });
  vi.stubGlobal('WebSocket', createSocket);
  const received = vi.fn();
  bus.on(subjects.received, ({ call }) => received(call));

  const principal = { kind: 'makaio.host', id: 'remote-host' };
  const sendClaim = (): void => {
    socket.receiveMessage(
      JSON.stringify({
        type: 'event',
        namespace: 'test',
        subject: 'received',
        messageId: 'received-principal',
        payload: {},
        metadata: { principal },
      }),
    );
  };
  return { bus, socket, createSocket, received, principal, sendClaim };
}
