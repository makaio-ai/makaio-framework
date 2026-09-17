/**
 * Tests for {@link isAuthConnectionError}'s classification of bus connection
 * failures.
 *
 * The distinction matters beyond the warning text: `main` maps the result onto
 * `connectionFailure: 'auth' | 'transport'`, and only `'transport'` is allowed
 * to arm the built-in hook failure cool-down. Misreading a transport failure as
 * an auth failure therefore makes every hook pay the full probe timeout while
 * the server is down.
 */

import { describe, expect, it } from 'vitest';
import { WebSocketConnectionError } from '@makaio/bus-transport-websocket';
import { isAuthConnectionError } from './bus-client.js';

/**
 * Reproduce the wrapping the CLI actually sees: the transport error is wrapped
 * once by `bus.connect()` and once by `connectBusClient` before reaching
 * `main`'s classification call.
 * @param cause - Typed transport error raised by the WebSocket transport.
 * @returns The doubly-wrapped error as observed at the `main` call site.
 */
function wrapAsCliObserves(cause: Error): Error {
  const transportWrapped = new Error(`Failed to connect transport "ws-client": ${cause.message}`, { cause });
  return new Error('Could not connect to Makaio.\n(tried ws://127.0.0.1:6252/bus)', { cause: transportWrapped });
}

describe('isAuthConnectionError — typed transport codes', () => {
  it('classifies an explicit HMAC rejection as an auth failure', () => {
    const error = new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'HMAC authentication failed: mismatch');
    expect(isAuthConnectionError(error)).toBe(true);
  });

  it('classifies a policy rejection as an auth failure', () => {
    // The server closes with 1008 for exactly this code and WS_AUTHENTICATION_REJECTED.
    const error = new WebSocketConnectionError('WS_POLICY_REJECTED', 'WebSocket connection rejected by peer policy');
    expect(isAuthConnectionError(error)).toBe(true);
  });

  it('classifies a mid-handshake disconnect as transport despite its message', () => {
    const error = new WebSocketConnectionError(
      'WS_CONNECTION_UNAVAILABLE',
      'Socket disconnected during HMAC authentication',
    );
    expect(isAuthConnectionError(error)).toBe(false);
  });

  it('classifies a handshake timeout as transport despite its message', () => {
    const error = new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'Authentication challenge timeout');
    expect(isAuthConnectionError(error)).toBe(false);
  });

  it('classifies a connection timeout as transport', () => {
    const error = new WebSocketConnectionError('WS_CONNECTION_TIMEOUT', 'WebSocket connection timeout');
    expect(isAuthConnectionError(error)).toBe(false);
  });
});

describe('isAuthConnectionError — wrapped causes', () => {
  it('reads the code through the two wrappers the CLI adds for a rejection', () => {
    const wrapped = wrapAsCliObserves(
      new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'HMAC authentication failed: mismatch'),
    );
    expect(isAuthConnectionError(wrapped)).toBe(true);
  });

  it('reads the code through the two wrappers the CLI adds for a timeout', () => {
    const wrapped = wrapAsCliObserves(
      new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'Authentication result timeout'),
    );
    expect(isAuthConnectionError(wrapped)).toBe(false);
  });

  it('keeps walking past a cause link that carries no code', () => {
    const inner = new WebSocketConnectionError('WS_POLICY_REJECTED', 'rejected');
    const middle = new Error('intermediate', { cause: inner });
    expect(isAuthConnectionError(new Error('outer', { cause: middle }))).toBe(true);
  });
});

describe('isAuthConnectionError — untyped failures', () => {
  it('treats the connect-timeout Error as transport', () => {
    expect(isAuthConnectionError(new Error('Bus connection timed out'))).toBe(false);
  });

  it('honours a numeric HTTP status code', () => {
    expect(isAuthConnectionError({ code: 401, message: 'nope' })).toBe(true);
    expect(isAuthConnectionError({ status: 403, message: 'nope' })).toBe(true);
  });

  it('falls back to the message keyword when no code is present', () => {
    expect(isAuthConnectionError(new Error('missing credential'))).toBe(true);
    expect(isAuthConnectionError('unauthorized')).toBe(true);
    expect(isAuthConnectionError(new Error('ECONNRESET'))).toBe(false);
  });

  it('returns false for values that carry neither code nor message', () => {
    expect(isAuthConnectionError(null)).toBe(false);
    expect(isAuthConnectionError(undefined)).toBe(false);
    expect(isAuthConnectionError(42)).toBe(false);
    expect(isAuthConnectionError({})).toBe(false);
  });
});
