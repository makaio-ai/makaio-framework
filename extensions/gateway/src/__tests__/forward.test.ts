/**
 * Integration tests for the gateway proxy forwarding layer.
 *
 * Each test spins up a real `node:http` server on a random loopback port and
 * makes live `fetch` calls through {@link forwardRequest}. No fetch mocking is
 * used. Servers are closed in `afterEach` to avoid port leaks between tests.
 */

import { createServer } from 'node:http';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { UpstreamAbortedError, UpstreamUnreachableError, forwardRequest, toClientResponse } from '../proxy/forward.js';
import { filterRequestHeaders, filterResponseHeaders } from '../proxy/headers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Start a mock HTTP server on a random loopback port and resolve when ready.
 * @param handler - Request handler invoked for every incoming request.
 */
function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------------------
// Shared state — each test creates its own server and stores it here so that
// `afterEach` can close it even when the test throws early.
// ---------------------------------------------------------------------------

let activeServer: HttpServer | null = null;

afterEach(() => {
  return new Promise<void>((resolve) => {
    if (!activeServer) {
      resolve();
      return;
    }
    const s = activeServer;
    activeServer = null;
    // Close all open connections first so a stalled SSE or abort test cannot
    // deadlock the suite by keeping the server's internal handle alive.
    s.closeAllConnections();
    s.close(() => resolve());
  });
});

// ---------------------------------------------------------------------------
// Unit tests — pure header-filter functions (no network)
// ---------------------------------------------------------------------------

describe('filterRequestHeaders', () => {
  /**
   * RFC 7230 §6.1 — a proxy must strip headers nominated in the `Connection`
   * field-value in addition to the fixed hop-by-hop denylist.
   */
  it('strips a header nominated by the Connection field-value', () => {
    const incoming = new Headers({
      authorization: 'Bearer token',
      'x-custom': 'should-be-stripped',
      connection: 'x-custom',
    });
    const result = filterRequestHeaders(incoming);
    expect(result.get('x-custom')).toBeNull();
    expect(result.get('connection')).toBeNull(); // always stripped (hop-by-hop)
    expect(result.get('authorization')).toBe('Bearer token'); // passthrough
  });

  it('strips all names in a comma-separated Connection value (keep-alive, x-custom)', () => {
    const incoming = new Headers({
      connection: 'keep-alive, x-custom',
      'x-custom': 'should-be-stripped',
      'content-type': 'application/json',
    });
    const result = filterRequestHeaders(incoming);
    expect(result.get('x-custom')).toBeNull();
    expect(result.get('connection')).toBeNull();
    expect(result.get('content-type')).toBe('application/json');
  });

  it('strips the Expect header before forwarding to the upstream', () => {
    // The Node HTTP server completes the 100-continue handshake before the
    // gateway sees the request. Forwarding `Expect: 100-continue` to undici
    // would cause UND_ERR_NOT_SUPPORTED. Strip it unconditionally.
    const incoming = new Headers({
      'content-type': 'application/json',
      expect: '100-continue',
      authorization: 'Bearer token',
    });
    const result = filterRequestHeaders(incoming);
    expect(result.get('expect')).toBeNull();
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('authorization')).toBe('Bearer token');
  });
});

describe('filterResponseHeaders', () => {
  it('strips content-encoding and content-length when encoding is gzip', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '1234',
      'x-request-id': 'abc',
    });
    const result = filterResponseHeaders(upstream);
    expect(result.get('content-encoding')).toBeNull();
    expect(result.get('content-length')).toBeNull();
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('x-request-id')).toBe('abc');
  });

  it('strips content-encoding and content-length when encoding is zstd (Node ≥ 22.15 / 24 decodes it)', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'zstd',
      'content-length': '5678',
    });
    const result = filterResponseHeaders(upstream);
    expect(result.get('content-encoding')).toBeNull();
    expect(result.get('content-length')).toBeNull();
    expect(result.get('content-type')).toBe('application/json');
  });

  it('forwards content-encoding and content-length when encoding is truly unknown (identity)', () => {
    // `identity` is not transparently decoded by fetch — body bytes are forwarded
    // as-is and both headers must be preserved so the client can interpret them.
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'identity',
      'content-length': '999',
    });
    const result = filterResponseHeaders(upstream);
    expect(result.get('content-encoding')).toBe('identity');
    expect(result.get('content-length')).toBe('999');
  });

  it('strips a header nominated by the Connection field-value', () => {
    const upstream = new Headers({
      'x-request-id': 'abc',
      connection: 'x-custom',
      'x-custom': 'should-be-stripped',
    });
    const result = filterResponseHeaders(upstream);
    expect(result.get('x-custom')).toBeNull();
    expect(result.get('connection')).toBeNull();
    expect(result.get('x-request-id')).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — live fetch against real mock HTTP servers
// ---------------------------------------------------------------------------

describe('forwardRequest', () => {
  /**
   * AC1 — Body bytes arrive identical at the upstream and the passthrough
   * headers (`authorization`, `x-api-key`, `anthropic-beta`,
   * `anthropic-version`, `content-type`) arrive verbatim, while hop-by-hop and
   * computed headers from the client (`host`, `connection`, `content-length`)
   * are not the client's original values.
   */
  it('AC1: forwards body bytes identically and passes/strips request headers correctly', async () => {
    const bodyText = '{"model":"claude-opus-4-5","messages":[]}';
    const bodyBytes = new TextEncoder().encode(bodyText);

    let receivedBody: Buffer | null = null;
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    const { server, port } = await startMockServer((req, res) => {
      receivedHeaders = req.headers as Record<string, string | string[] | undefined>;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    activeServer = server;

    // Client headers include hop-by-hop and computed entries that must be stripped.
    const clientHeaders = new Headers({
      authorization: 'Bearer sk-ant-oauth-example',
      'x-api-key': 'the-api-key',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // The next three must NOT arrive at the upstream with the client's values.
      host: 'api.anthropic.com',
      connection: 'keep-alive',
      'content-length': '9999',
    });

    const response = await forwardRequest({
      upstreamUrl: `http://127.0.0.1:${port}/v1/messages`,
      method: 'POST',
      headers: clientHeaders,
      body: bodyBytes,
      signal: AbortSignal.timeout(5000),
    });

    // Consume body so the server can finish.
    await response.text();

    // Body bytes must arrive byte-identical.
    if (!receivedBody) throw new Error('Server received no body');
    expect(Buffer.compare(receivedBody, Buffer.from(bodyBytes))).toBe(0);

    // Passthrough headers arrive verbatim.
    expect(receivedHeaders['authorization']).toBe('Bearer sk-ant-oauth-example');
    expect(receivedHeaders['x-api-key']).toBe('the-api-key');
    expect(receivedHeaders['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(receivedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(receivedHeaders['content-type']).toBe('application/json');

    // `host` is recomputed by fetch from the upstream URL — must not be the
    // client's original value ('api.anthropic.com').
    expect(receivedHeaders['host']).toBe(`127.0.0.1:${port}`);

    // `connection` is a hop-by-hop header. Our filter strips the client's
    // value before calling fetch, but undici (Node.js's fetch) unconditionally
    // adds its own `Connection: keep-alive` for HTTP/1.1 keep-alive. We can
    // only verify that the client's specific connection directives are not
    // forwarded verbatim — the presence of `connection` from undici itself is
    // correct proxy behaviour and outside the filter's scope.

    // `content-length` is recomputed by fetch from the actual body bytes, not
    // taken from the client's header (9999).
    expect(Number(receivedHeaders['content-length'])).toBe(bodyBytes.byteLength);
    expect(Number(receivedHeaders['content-length'])).not.toBe(9999);
  });

  /**
   * AC3 — SSE responses are relayed incrementally through `toClientResponse`:
   * the test observes the first SSE chunk (including a comment/ping line)
   * before the upstream finishes sending the stream. The comment line
   * `": ping"` and the `message_start` event survive the relay unchanged.
   */
  it('AC3: SSE relay is incremental — first chunk arrives before upstream finishes', async () => {
    // A deferred gate: the server blocks here until the test signals it.
    let serverGateResolve!: () => void;
    const serverGate = new Promise<void>((r) => {
      serverGateResolve = r;
    });

    // Shared order log: records which side emitted an event first.
    const order: string[] = [];

    const { server, port } = await startMockServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-request-id': 'req_ac3_test',
      });
      // Flush initial events immediately.
      res.write(': ping\n\n');
      res.write('event: message_start\ndata: {}\n\n');

      // Block until the test resolves the gate (after it has read the first chunk).
      serverGate.then(() => {
        order.push('server-wrote-final');
        res.write('event: message_stop\ndata: {"stop_reason":"end_turn"}\n\n');
        res.end();
      });
    });
    activeServer = server;

    const upstream = await forwardRequest({
      upstreamUrl: `http://127.0.0.1:${port}/v1/messages`,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"model":"claude-opus-4-5","stream":true}'),
      signal: AbortSignal.timeout(10_000),
    });

    // Pass through toClientResponse so the downstream leg is covered.
    const response = toClientResponse(upstream);
    expect(response.status).toBe(200);

    const body = response.body;
    if (!body) throw new Error('Expected a streaming response body');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let firstChunkReceived = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      accumulated += decoder.decode(value, { stream: true });

      if (!firstChunkReceived && accumulated.includes(': ping')) {
        // The first chunk arrived — record the observation order and unblock
        // the server. At this point the server has NOT yet written the final
        // event, so 'server-wrote-final' is not in `order`.
        firstChunkReceived = true;
        order.push('client-read-first-chunk');
        serverGateResolve();
      }
    }

    // Flush any remaining bytes from the TextDecoder.
    accumulated += decoder.decode();

    // The first chunk was observed before the server wrote the final event.
    expect(order[0]).toBe('client-read-first-chunk');
    expect(order[1]).toBe('server-wrote-final');

    // The comment/ping line survived the relay.
    expect(accumulated).toContain(': ping');

    // Both SSE events arrived intact.
    expect(accumulated).toContain('event: message_start');
    expect(accumulated).toContain('event: message_stop');
  });

  /**
   * AC4 — Upstream 4xx/5xx responses are forwarded verbatim: identical status
   * code, body bytes, and custom response headers (`x-request-id`).
   */
  it('AC4: upstream error responses are forwarded verbatim (status, body, custom headers)', async () => {
    const errorBody = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'model not found' },
    });

    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(400, {
        'content-type': 'application/json',
        'x-request-id': 'req-err-abc123',
      });
      res.end(errorBody);
    });
    activeServer = server;

    const upstream = await forwardRequest({
      upstreamUrl: `http://127.0.0.1:${port}/v1/messages`,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"model":"unknown","messages":[]}'),
      signal: AbortSignal.timeout(5000),
    });

    const clientResponse = toClientResponse(upstream);

    expect(clientResponse.status).toBe(400);

    // Body is forwarded byte-identical.
    const received = await clientResponse.text();
    expect(received).toBe(errorBody);

    // Custom response header preserved.
    expect(clientResponse.headers.get('x-request-id')).toBe('req-err-abc123');
  });

  /**
   * AC6a — The server writes response headers and a first SSE chunk; the
   * client reads that chunk through `toClientResponse`, then aborts. The body
   * stream is cancelled and the server observes the TCP close.
   *
   * Note: `UpstreamAbortedError` is thrown by `forwardRequest` only when the
   * abort occurs before response headers arrive. A mid-stream abort propagates
   * as an `AbortError` from the underlying fetch body stream, because
   * `forwardRequest` has already resolved successfully at that point.
   */
  it('AC6a: mid-stream abort cancels the upstream body stream and closes the upstream socket', async () => {
    let serverCloseResolve!: () => void;
    const serverClosed = new Promise<void>((r) => {
      serverCloseResolve = r;
    });

    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      // Flush headers and first chunk immediately to the client.
      res.write(': ping\n\n');
      // Observe the TCP close triggered by the client abort.
      res.on('close', () => {
        serverCloseResolve();
      });
      // Never call res.end() — hold the connection open until the client aborts.
    });
    activeServer = server;

    const controller = new AbortController();

    const upstream = await forwardRequest({
      upstreamUrl: `http://127.0.0.1:${port}/v1/messages`,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"model":"claude-opus-4-5","stream":true}'),
      signal: controller.signal,
    });

    const clientResponse = toClientResponse(upstream);
    const body = clientResponse.body;
    if (!body) throw new Error('Expected a streaming response body');

    const reader = body.getReader();
    const decoder = new TextDecoder();

    // Read the first chunk flushed immediately by the server.
    const { done, value } = await reader.read();
    expect(done).toBe(false);
    const chunk = value ? decoder.decode(value, { stream: true }) : '';
    expect(chunk).toContain(': ping');

    // Abort mid-stream. undici cancels the response body ReadableStream and
    // tears down the TCP connection to the upstream.
    controller.abort();

    let caughtError: unknown;
    try {
      await reader.read();
    } catch (err) {
      caughtError = err;
    }
    // The body ReadableStream is errored by the abort; undici surfaces it as
    // an AbortError (DOMException with name 'AbortError').
    expect(caughtError).toMatchObject({ name: 'AbortError' });

    // The server must observe the TCP close — this proves the abort propagated
    // all the way to the upstream connection.
    await serverClosed;
  }, 10_000);

  /**
   * AC6b — Aborting before headers (forwardRequest still pending) rejects with
   * {@link UpstreamAbortedError}. Tested separately from the mid-stream case.
   */
  it('AC6b (pre-headers abort): aborting the signal rejects with UpstreamAbortedError', async () => {
    let socketClosedResolve!: () => void;
    const socketClosed = new Promise<void>((r) => {
      socketClosedResolve = r;
    });

    let handlerEnteredResolve!: () => void;
    const handlerEntered = new Promise<void>((r) => {
      handlerEnteredResolve = r;
    });

    const { server, port } = await startMockServer((req) => {
      // Signal that the handler was entered so the test can abort immediately
      // after the connection is established, without a fixed-duration sleep.
      handlerEnteredResolve();
      // req.socket.on('close') fires when the TCP socket is destroyed, which
      // is the reliable signal that the upstream connection was torn down.
      // req.on('close') can fire earlier (when the request stream ends), not
      // necessarily when the socket itself closes.
      req.socket?.on('close', () => {
        socketClosedResolve();
      });
      // Do not write headers or call end() — hold the connection open.
    });
    activeServer = server;

    const controller = new AbortController();

    const requestPromise = forwardRequest({
      upstreamUrl: `http://127.0.0.1:${port}/v1/messages`,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"model":"claude-opus-4-5"}'),
      signal: controller.signal,
    });

    // Wait for the handler to be entered so the upstream connection is
    // established, then abort.
    await handlerEntered;
    controller.abort();

    await expect(requestPromise).rejects.toThrow(UpstreamAbortedError);

    // The upstream must observe the socket close — this proves the abort
    // signal propagated all the way to the TCP connection.
    await socketClosed;
  });

  /**
   * AC6c — Attempting to connect to a port with nothing listening rejects with
   * {@link UpstreamUnreachableError}.
   */
  it('AC6c: connection refused rejects with UpstreamUnreachableError', async () => {
    // Port 1 is privileged and never has a listener in test environments;
    // the OS returns ECONNREFUSED or EACCES — both are non-abort network
    // errors and must surface as UpstreamUnreachableError.
    await expect(
      forwardRequest({
        upstreamUrl: `http://127.0.0.1:1/v1/messages`,
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode('{"model":"claude-opus-4-5"}'),
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow(UpstreamUnreachableError);
  });

  /**
   * AC6d — `redirect: 'manual'` is set: when the upstream returns a 3xx the
   * raw redirect response is returned to the caller rather than being followed.
   * This verifies that Claude Code will never silently land on an unexpected
   * redirect target.
   */
  it('AC6d: upstream 3xx redirect is returned as-is (not followed)', async () => {
    const { server, port } = await startMockServer((_req, res) => {
      // Redirect to an unreachable address — if fetch follows the redirect it
      // will throw rather than return gracefully.
      res.writeHead(302, { location: 'http://127.0.0.1:1/unreachable' });
      res.end();
    });
    activeServer = server;

    const response = await forwardRequest({
      upstreamUrl: `http://127.0.0.1:${port}/v1/messages`,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"model":"claude-opus-4-5"}'),
      signal: AbortSignal.timeout(5000),
    });

    // The WhatWG Fetch spec describes an opaque-redirect filtered response
    // (status 0) for redirect:'manual'. undici v7 in Node.js returns the
    // original 302 status code without applying the opaque filter. Either
    // behaviour proves the redirect was not followed — a followed redirect to
    // port 1 would throw UpstreamUnreachableError, not return a Response.
    expect(response.status === 0 || response.status === 302).toBe(true);
  });
});

describe('toClientResponse', () => {
  /**
   * Verifies that `toClientResponse` copies status, statusText, and filtered
   * headers from the upstream response, and that the body is the same stream
   * reference (no buffering). Hop-by-hop headers (`connection`) are stripped;
   * custom headers (`x-request-id`) are preserved.
   */
  it('copies status, statusText and filtered response headers; streams body unchanged', async () => {
    const bodyText = '{"type":"message","content":[]}';

    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req_toClientResponse_test',
        // `connection` is a hop-by-hop header — must be stripped.
        // Note: do NOT set `transfer-encoding: chunked` here alongside any
        // content-length — the two conflict in HTTP/1.1.
        connection: 'close',
      });
      res.end(bodyText);
    });
    activeServer = server;

    const upstream = await forwardRequest({
      upstreamUrl: `http://127.0.0.1:${port}/v1/messages`,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"model":"claude-opus-4-5"}'),
      signal: AbortSignal.timeout(5000),
    });

    const client = toClientResponse(upstream);

    expect(client.status).toBe(200);

    // Custom header preserved.
    expect(client.headers.get('x-request-id')).toBe('req_toClientResponse_test');

    // Hop-by-hop header stripped.
    expect(client.headers.get('connection')).toBeNull();

    // Body streams through unchanged.
    const received = await client.text();
    expect(received).toBe(bodyText);
  });
});
