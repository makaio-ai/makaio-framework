/**
 * Unit tests for {@link LoopbackTransport}.
 *
 * Covers the full public surface:
 * - Constructor name assignment
 * - send() / cancelRequest() / isReady() / onBroadcastResults() delegation
 * - Graceful handling of optional target methods (cancelRequest, isReady,
 *   onBroadcastResults) being absent
 * - connect() / disconnect() / subscribe() / unsubscribe() as no-ops
 * - onReceive() returns a no-op unsubscribe and never forwards to the target
 */

import { describe, it, expect, vi } from 'vitest';
import type { BusMessage, BusRequestMessage, BusEventMessage, BusTransport, BusTransportError } from '@makaio/bus-core';
import { LoopbackTransport } from '../loopback-transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid {@link BusRequestMessage} for send() delegation tests.
 */
function makeRequestMessage(): BusRequestMessage {
  return {
    type: 'request',
    subject: 'test',
    namespace: 'ns',
    payload: { x: 1 },
    correlationId: 'corr-1',
    messageId: 'msg-1',
  };
}

/**
 * Minimal valid {@link BusEventMessage} for send() delegation tests.
 */
function makeEventMessage(): BusEventMessage {
  return {
    type: 'event',
    subject: 'test',
    namespace: 'ns',
    payload: { x: 2 },
    messageId: 'msg-2',
  };
}

/**
 * Build a fully-featured mock target transport with vi.fn() spies on every
 * optional method. All optional methods are present by default; individual
 * tests remove them to exercise the absent-method branches.
 */
function makeFullTarget(): BusTransport {
  return {
    name: 'mock-target',
    send: vi.fn().mockResolvedValue(true),
    cancelRequest: vi.fn(),
    onReceive: vi.fn().mockReturnValue(() => undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    onBroadcastResults: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoopbackTransport', () => {
  describe('constructor', () => {
    it('sets name from options', () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'electron' });

      expect(loopback.name).toBe('electron');
    });
  });

  describe('send()', () => {
    it('delegates to target send() with the same message and timeout', async () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });
      const message = makeRequestMessage();

      await loopback.send(message, 5000);

      expect(target.send).toHaveBeenCalledOnce();
      expect(target.send).toHaveBeenCalledWith(message, 5000);
    });

    it('returns whatever the target send() resolves with', async () => {
      const target = makeFullTarget();
      vi.mocked(target.send).mockResolvedValue({ output: 'delegated' });
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      const result = await loopback.send(makeEventMessage());

      expect(result).toEqual({ output: 'delegated' });
    });
  });

  describe('cancelRequest()', () => {
    it('delegates to target cancelRequest() with correlationId and error', () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });
      const err = new Error('cancelled');

      loopback.cancelRequest('corr-42', err);

      expect(target.cancelRequest).toHaveBeenCalledOnce();
      expect(target.cancelRequest).toHaveBeenCalledWith('corr-42', err);
    });

    it('does not throw when target has no cancelRequest method', () => {
      const target = makeFullTarget();
      delete (target as Partial<BusTransport>).cancelRequest;
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      expect(() => loopback.cancelRequest('corr-99')).not.toThrow();
    });
  });

  describe('isReady()', () => {
    it('delegates to target isReady() and returns its value', () => {
      const target = makeFullTarget();
      vi.mocked(target.isReady!).mockReturnValue(false);
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      expect(loopback.isReady()).toBe(false);
      expect(target.isReady).toHaveBeenCalledOnce();
    });

    it('returns true when target has no isReady method', () => {
      const target = makeFullTarget();
      delete (target as Partial<BusTransport>).isReady;
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      expect(loopback.isReady()).toBe(true);
    });
  });

  describe('onBroadcastResults()', () => {
    it('delegates to target onBroadcastResults() with all args', () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });
      const results: ReadonlyArray<{ nodeId: string; payload: unknown }> = [
        { nodeId: 'node-1', payload: { ok: true } },
      ];
      const error: BusTransportError = { message: 'partial failure', code: 'ERR' };

      loopback.onBroadcastResults('corr-bc', results, error);

      expect(target.onBroadcastResults).toHaveBeenCalledOnce();
      expect(target.onBroadcastResults).toHaveBeenCalledWith('corr-bc', results, error);
    });

    it('does not throw when target has no onBroadcastResults method', () => {
      const target = makeFullTarget();
      delete (target as Partial<BusTransport>).onBroadcastResults;
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      expect(() => loopback.onBroadcastResults('corr-bc', [])).not.toThrow();
    });
  });

  describe('connect()', () => {
    it('resolves without calling any target method', async () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      await expect(loopback.connect()).resolves.toBeUndefined();
      expect(target.connect).not.toHaveBeenCalled();
    });
  });

  describe('disconnect()', () => {
    it('resolves without calling any target method', async () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      await expect(loopback.disconnect()).resolves.toBeUndefined();
      expect(target.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('onReceive()', () => {
    it('does not forward to target onReceive', () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });
      const handler = (_msg: BusMessage): Promise<void> => Promise.resolve();

      loopback.onReceive(handler);

      expect(target.onReceive).not.toHaveBeenCalled();
    });

    it('returns a no-op unsubscribe function that does not throw', () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });
      const handler = (_msg: BusMessage): Promise<void> => Promise.resolve();

      const unsubscribe = loopback.onReceive(handler);

      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('subscribe()', () => {
    it('resolves without calling target subscribe', async () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      await expect(loopback.subscribe()).resolves.toBeUndefined();
      expect(target.subscribe).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribe()', () => {
    it('resolves without calling target unsubscribe', async () => {
      const target = makeFullTarget();
      const loopback = new LoopbackTransport({ target, name: 'loopback' });

      await expect(loopback.unsubscribe()).resolves.toBeUndefined();
      expect(target.unsubscribe).not.toHaveBeenCalled();
    });
  });
});
