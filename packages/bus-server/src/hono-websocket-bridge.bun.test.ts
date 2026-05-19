/**
 * Unit tests for {@link HonoWebSocketBridge}.
 *
 * Covers the full public surface:
 * - `accept()` dispatches a socket to all registered connection listeners
 * - Multiple listeners all receive the same socket instance
 * - `off()` removes a specific listener without affecting others
 * - `close()` clears all listeners and invokes the optional callback
 * - `on('error')` and `on('close')` are accepted but are no-ops
 * - `accept()` is a no-op when no listeners are registered
 */

import { describe, it, expect, mock } from 'bun:test';
import type { WebSocketLike } from '@makaio/bus-transport-websocket';
import { HonoWebSocketBridge } from './hono-websocket-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link WebSocketLike} stub.
 *
 * Only the identity of the object matters for these tests — `accept()` passes
 * the reference through without calling any methods on it.
 */
function makeSocket(): WebSocketLike {
  return {
    send: mock(),
    close: mock(),
    addEventListener: mock(),
    removeEventListener: mock(),
    readyState: 1,
  };
}

function buildFixture() {
  return {
    bridge: new HonoWebSocketBridge(),
    socket: makeSocket(),
    listener: mock(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HonoWebSocketBridge', () => {
  describe('accept()', () => {
    it('dispatches the socket to a registered connection listener', () => {
      const { bridge, listener, socket } = buildFixture();

      bridge.on('connection', listener);
      bridge.accept(socket);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(socket);
    });

    it('dispatches the socket to all registered connection listeners', () => {
      const { bridge, socket } = buildFixture();
      const listenerA = mock();
      const listenerB = mock();

      bridge.on('connection', listenerA);
      bridge.on('connection', listenerB);
      bridge.accept(socket);

      expect(listenerA).toHaveBeenCalledOnce();
      expect(listenerA).toHaveBeenCalledWith(socket);
      expect(listenerB).toHaveBeenCalledOnce();
      expect(listenerB).toHaveBeenCalledWith(socket);
    });

    it('deduplicates the same connection listener when registered twice', () => {
      const { bridge, listener, socket } = buildFixture();

      bridge.on('connection', listener);
      bridge.on('connection', listener);
      bridge.accept(socket);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(socket);
    });

    it('is a no-op when no listeners are registered', () => {
      const { bridge, socket } = buildFixture();

      expect(() => bridge.accept(socket)).not.toThrow();
    });
  });

  describe('off()', () => {
    it('removes the specified connection listener', () => {
      const { bridge, listener, socket } = buildFixture();

      bridge.on('connection', listener);
      bridge.off('connection', listener);
      bridge.accept(socket);

      expect(listener).not.toHaveBeenCalled();
    });

    it('leaves other listeners intact when removing one', () => {
      const { bridge, socket } = buildFixture();
      const listenerA = mock();
      const listenerB = mock();

      bridge.on('connection', listenerA);
      bridge.on('connection', listenerB);
      bridge.off('connection', listenerA);
      bridge.accept(socket);

      expect(listenerA).not.toHaveBeenCalled();
      expect(listenerB).toHaveBeenCalledOnce();
      expect(listenerB).toHaveBeenCalledWith(socket);
    });
  });

  describe('close()', () => {
    it('clears all connection listeners', () => {
      const { bridge, listener, socket } = buildFixture();

      bridge.on('connection', listener);
      bridge.close();
      bridge.accept(socket);

      expect(listener).not.toHaveBeenCalled();
    });

    it('invokes the callback after clearing listeners', () => {
      const bridge = new HonoWebSocketBridge();
      const cb = mock();

      bridge.close(cb);

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith();
    });

    it('does not throw when called without a callback', () => {
      const bridge = new HonoWebSocketBridge();

      expect(() => bridge.close()).not.toThrow();
    });
  });

  describe('non-connection events', () => {
    it('accepts on("error") without throwing', () => {
      const bridge = new HonoWebSocketBridge();
      const errorListener = mock();

      expect(() => bridge.on('error', errorListener)).not.toThrow();
    });

    it('accepts on("close") without throwing', () => {
      const bridge = new HonoWebSocketBridge();
      const closeListener = mock();

      expect(() => bridge.on('close', closeListener)).not.toThrow();
    });

    it('accepts off("error") without throwing', () => {
      const bridge = new HonoWebSocketBridge();
      const errorListener = mock();

      expect(() => bridge.off('error', errorListener)).not.toThrow();
    });

    it('accepts off("close") without throwing', () => {
      const bridge = new HonoWebSocketBridge();
      const closeListener = mock();

      expect(() => bridge.off('close', closeListener)).not.toThrow();
    });

    it('does not interfere with connection listeners', () => {
      const { bridge, socket } = buildFixture();
      const connectionListener = mock();
      const errorListener = mock();
      const closeListener = mock();

      bridge.on('connection', connectionListener);
      bridge.on('error', errorListener);
      bridge.on('close', closeListener);
      bridge.accept(socket);

      expect(connectionListener).toHaveBeenCalledOnce();
      expect(connectionListener).toHaveBeenCalledWith(socket);
      expect(errorListener).not.toHaveBeenCalled();
      expect(closeListener).not.toHaveBeenCalled();
    });
  });
});
