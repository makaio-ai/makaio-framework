import { describe, expect, it } from 'bun:test';
import { serializeTransportError } from '@makaio/bus-core';
import { waitForSocketOpen } from '../transport-helpers.js';
import { MockWebSocket } from './test-helpers.js';

describe('serializeTransportError', () => {
  it('handles null and undefined without throwing', () => {
    expect(serializeTransportError(null)).toEqual({
      message: 'null',
      code: undefined,
      data: undefined,
    });
    expect(serializeTransportError(undefined)).toEqual({
      message: 'undefined',
      code: undefined,
      data: undefined,
    });
  });

  it('preserves message when error is already transport-error shaped', () => {
    const result = serializeTransportError({
      message: 'transport failed',
      code: 'WS_TIMEOUT',
      data: { retryable: true },
    });

    expect(result).toEqual({
      message: 'transport failed',
      code: 'WS_TIMEOUT',
      data: { retryable: true },
    });
  });
});

describe('waitForSocketOpen', () => {
  it('resolves immediately when socket is already open', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 1; // OPEN
    await expect(waitForSocketOpen(ws)).resolves.toBeUndefined();
  });

  it('rejects immediately when socket is CLOSED', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 3; // CLOSED
    await expect(waitForSocketOpen(ws)).rejects.toThrow('WebSocket closed before opening');
  });

  it('rejects immediately when socket is CLOSING', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 2; // CLOSING
    await expect(waitForSocketOpen(ws)).rejects.toThrow('WebSocket closed before opening');
  });

  it('resolves when open event fires', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 0; // CONNECTING
    const promise = waitForSocketOpen(ws);
    ws.emit('open', new Event('open'));
    await expect(promise).resolves.toBeUndefined();
    // Listeners should be cleaned up
    expect(ws.listeners.get('open')?.size ?? 0).toBe(0);
    expect(ws.listeners.get('error')?.size ?? 0).toBe(0);
    expect(ws.listeners.get('close')?.size ?? 0).toBe(0);
  });

  it('rejects with message from ErrorEvent-shaped error', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 0;
    const promise = waitForSocketOpen(ws);
    // Node ws fires ErrorEvent with .message property
    ws.emit('error', { message: 'Connection refused' });
    await expect(promise).rejects.toThrow('WebSocket connection failed — Connection refused');
  });

  it('rejects with fallback for browser-like plain Event', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 0;
    const promise = waitForSocketOpen(ws);
    // Browsers fire plain Event without .message
    ws.emit('error', new Event('error'));
    await expect(promise).rejects.toThrow('WebSocket connection failed — unknown error');
  });

  it('rejects when close fires before open', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 0;
    const promise = waitForSocketOpen(ws);
    ws.emit('close', new Event('close'));
    await expect(promise).rejects.toThrow('WebSocket closed before opening');
  });
});
