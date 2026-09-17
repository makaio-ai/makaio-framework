/**
 * Integration tests for {@link createGatewayRouter} — AC1, AC2, AC3, AC4,
 * AC5, AC7, AC10 plus invalid-body and upstream-unreachable cases.
 *
 * Architecture: real Hono sub-app with real `compileRules`, mounted on a
 * parent Hono app served via `app.fetch()`. Two real `node:http` mock upstream
 * servers handle the Anthropic and LiteLLM targets. No module-under-test
 * code is mocked; real SSE streaming verifies incremental relay (AC3).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { compileRules } from '../routing/match.js';
import { parseGatewayConfig } from '../config.js';
import { createGatewayRouter } from '../routes.js';
import type { GatewayRouterOptions, GatewayRuntime } from '../routes.js';
import type { RequestRoutedEvent } from '../contracts/schemas.js';
import { createCapturingLogger } from './helpers/capturing-logger.js';
import { startMockServer, type MockServer } from './helpers/mock-upstream.js';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

/**
 * Body cap used by every test that is not exercising the 413 path.
 *
 * Matches the schema default, so the shared fixture behaves like a
 * default-configured gateway.
 */
const TEST_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Build a gateway router, defaulting the options that most tests do not care
 * about.
 *
 * Keeps the router's required-option surface in one place so a new option does
 * not have to be threaded through every construction site.
 * The default logger is a capturing sink that nothing reads: these suites
 * assert on responses and bus events, so the per-request lines are captured
 * only to keep them out of the test runner's output. Logging itself is asserted
 * in `routes.logging.test.ts`.
 * `compiled` and `accessToken` are taken here rather than passed through,
 * because the router resolves them lazily through `ensureRuntime` in
 * production. These suites assert on routing and proxying, not on readiness, so
 * they hand it an already-resolved runtime; the lazy path itself is covered in
 * `gateway-service.test.ts`.
 * @param options - Router options; `compiled` and `emit` are always required,
 *   the rest default to an unauthenticated router with the schema-default body
 *   cap, a shutdown signal that never fires, and a discarded log sink.
 * @returns The configured gateway sub-app.
 */
function buildRouter(
  options: Partial<Omit<GatewayRouterOptions, 'ensureRuntime'>> &
    Pick<GatewayRouterOptions, 'emit'> & {
      readonly compiled: GatewayRuntime['compiled'];
      readonly accessToken?: GatewayRuntime['accessToken'];
    },
): Hono {
  const { compiled, accessToken = null, ...rest } = options;
  const runtime: GatewayRuntime = { compiled, accessToken };
  return createGatewayRouter({
    maxBodyBytes: TEST_MAX_BODY_BYTES,
    shutdownSignal: new AbortController().signal,
    logger: createCapturingLogger().logger,
    ...rest,
    ensureRuntime: () => Promise.resolve(runtime),
  });
}

/** Events collected by the capture emitter. */
let capturedEvents: RequestRoutedEvent[];

/**
 * Emitter injected into the gateway router to capture routing events for
 * assertions.
 * @param event - Routing telemetry emitted by the gateway for each request.
 */
function captureEmit(event: RequestRoutedEvent): void {
  capturedEvents.push(event);
}

/** Resolved LiteLLM master key used in tests. */
const MASTER_KEY = 'sk-litellm-test-key';

/** Anthropic mock server — captures requests and returns a simple 200. */
let anthropicMock: MockServer;
/** LiteLLM mock server — captures requests and returns a simple 200. */
let litellmMock: MockServer;
/** Parent Hono app with the gateway sub-app mounted at `/gateway`. */
let parentApp: Hono;

beforeAll(async () => {
  anthropicMock = await startMockServer(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', id: 'anthropic-resp' }),
  }));

  litellmMock = await startMockServer(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', id: 'litellm-resp' }),
  }));

  const config = parseGatewayConfig({
    upstreams: {
      anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropicMock.port}` },
      litellm: {
        kind: 'litellm',
        url: `http://127.0.0.1:${litellmMock.port}`,
        masterKey: 'env:LITELLM_MASTER_KEY',
      },
    },
    default: 'anthropic',
    rules: [
      // Explicit anthropic rule to test non-null ruleIndex
      { match: 'claude-explicit-*', to: 'anthropic' },
      // LiteLLM rule with model rename
      {
        match: 'deepseek-*',
        to: 'litellm',
        model: 'DeepSeek-V4-Flash-0731',
        reasoning: { mode: 'passthrough' },
      },
    ],
  });

  const compiled = compileRules(config, new Map([['litellm', MASTER_KEY]]));
  const router = buildRouter({ compiled, emit: captureEmit });

  parentApp = new Hono();
  parentApp.route('/gateway', router);
});

afterAll(async () => {
  await anthropicMock.close();
  await litellmMock.close();
});

// Clear the shared mock captures and the event buffer before every test.
// Tests that build their own router and call `app.fetch` directly bypass the
// request helpers, so the reset has to be unconditional — otherwise an
// assertion can pass against a capture left behind by an earlier test.
beforeEach(() => {
  capturedEvents = [];
  anthropicMock.clearLastRequest();
  litellmMock.clearLastRequest();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a POST request with a caller-supplied raw body through the parent app.
 *
 * Resets the captured events and both shared mock servers first, so every
 * assertion that follows observes state produced by this request alone.
 * @param path - Path relative to `/gateway`, e.g. `/v1/messages`.
 * @param rawBody - Exact request body string to send, byte for byte.
 * @param extraHeaders - Additional headers to include.
 * @param queryString - Optional query string, e.g. `?beta=true`.
 * @returns The Hono response.
 */
async function postRaw(
  path: string,
  rawBody: string,
  extraHeaders: Record<string, string> = {},
  queryString = '',
): Promise<Response> {
  capturedEvents = [];
  anthropicMock.clearLastRequest();
  litellmMock.clearLastRequest();
  const url = `http://localhost/gateway${path}${queryString}`;
  return parentApp.fetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: rawBody,
    }),
  );
}

/**
 * Send a POST request through the parent Hono app with a JSON-encoded body.
 * @param path - Path relative to `/gateway`, e.g. `/v1/messages`.
 * @param body - JSON-serialisable request body.
 * @param extraHeaders - Additional headers to include.
 * @param queryString - Optional query string, e.g. `?beta=true`.
 * @returns The Hono response.
 */
async function post(
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  queryString = '',
): Promise<Response> {
  return postRaw(path, JSON.stringify(body), extraHeaders, queryString);
}

// ---------------------------------------------------------------------------
// AC1 — Anthropic pass-through
// ---------------------------------------------------------------------------

describe('AC1: Anthropic pass-through', () => {
  it('forwards original body bytes verbatim to the Anthropic mock', async () => {
    // Hand-written JSON with irregular whitespace, a non-canonical key order,
    // and escapes that JSON.stringify would normalise away. Comparing the raw
    // bytes — not the re-parsed object — is what proves the pass-through branch
    // never round-trips the body.
    const rawBody =
      '{ "messages" :[ {"role":"user",\n  "content":"caf\\u00e9 \\"quoted\\"\\ttabbed"} ],\t"model":"claude-opus-4-5" }';
    const response = await postRaw('/v1/messages', rawBody, {
      authorization: 'Bearer sk-test-auth',
      'x-api-key': 'my-api-key',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'anthropic-version': '2023-06-01',
    });

    expect(response.status).toBe(200);
    const captured = anthropicMock.lastRequest;
    expect(captured).not.toBeNull();
    expect(captured?.body).toBe(rawBody);
    expect(Buffer.from(captured?.body ?? '', 'utf-8').equals(Buffer.from(rawBody, 'utf-8'))).toBe(true);
  });

  it('preserves Authorization, x-api-key, anthropic-beta, anthropic-version headers', async () => {
    await post(
      '/v1/messages',
      { model: 'claude-opus-4-5', messages: [] },
      {
        authorization: 'Bearer sk-forwarded',
        'x-api-key': 'forwarded-key',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'anthropic-version': '2023-06-01',
      },
    );

    const headers = anthropicMock.lastRequest!.headers;
    expect(headers['authorization']).toBe('Bearer sk-forwarded');
    expect(headers['x-api-key']).toBe('forwarded-key');
    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('preserves the query string (e.g. ?beta=true) in the forwarded URL', async () => {
    await post('/v1/messages', { model: 'claude-opus-4-5', messages: [] }, {}, '?beta=true');

    expect(anthropicMock.lastRequest!.url).toBe('/v1/messages?beta=true');
  });
});

// ---------------------------------------------------------------------------
// AC2 — LiteLLM routing
// ---------------------------------------------------------------------------

describe('AC2: LiteLLM routing', () => {
  it('forwards to litellm with Authorization: Bearer <key> and no x-api-key', async () => {
    await post(
      '/v1/messages',
      { model: 'deepseek-v3', messages: [{ role: 'user', content: 'Hi' }] },
      {
        authorization: 'Bearer sk-original',
        'x-api-key': 'should-be-removed',
      },
    );

    const headers = litellmMock.lastRequest!.headers;
    expect(headers['authorization']).toBe(`Bearer ${MASTER_KEY}`);
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('substitutes the upstream model name in the forwarded body', async () => {
    await post('/v1/messages', {
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const forwarded = JSON.parse(litellmMock.lastRequest!.body);
    expect(forwarded.model).toBe('DeepSeek-V4-Flash-0731');
  });

  it('leaves other body fields unchanged', async () => {
    const reqBody = {
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
      system: 'You are helpful.',
    };
    await post('/v1/messages', reqBody);

    const forwarded = JSON.parse(litellmMock.lastRequest!.body);
    expect(forwarded.messages).toEqual(reqBody.messages);
    expect(forwarded.max_tokens).toBe(512);
    expect(forwarded.system).toBe('You are helpful.');
  });

  it('injects allowed_openai_params for passthrough reasoning mode', async () => {
    await post('/v1/messages', {
      model: 'deepseek-v3',
      messages: [],
    });

    const forwarded = JSON.parse(litellmMock.lastRequest!.body);
    expect(forwarded['allowed_openai_params']).toContain('reasoning_effort');
  });
});

// ---------------------------------------------------------------------------
// AC3 — SSE incremental relay
// ---------------------------------------------------------------------------

describe('AC3: SSE incremental relay', () => {
  it('relays SSE chunks incrementally including ping comments', async () => {
    // Gate pattern (same as forward.test.ts AC3): the server blocks on a
    // deferred promise until the test signals it has read the first chunk.
    // This proves incrementality without relying on a wall-clock delay.
    let serverGateResolve!: () => void;
    const serverGate = new Promise<void>((r) => {
      serverGateResolve = r;
    });
    const order: string[] = [];

    const sseServer = await startMockServer((_req) => ({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: (res: http.ServerResponse) => {
        // First wave: immediately flushed.
        res.write(': ping\n\n');
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        // Second wave: gated on the client having read the first chunk.
        void serverGate.then(() => {
          order.push('server-wrote-final');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        });
      },
    }));

    try {
      const sseConfig = parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${sseServer.port}` } },
        default: 'anthropic',
        rules: [],
      });
      const sseCompiled = compileRules(sseConfig, new Map());
      const sseRouter = buildRouter({ compiled: sseCompiled, emit: () => undefined });
      const sseApp = new Hono();
      sseApp.route('/gateway', sseRouter);

      const response = await sseApp.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-5', messages: [], stream: true }),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      // Read the first chunk — it must contain the immediately-flushed ping
      // comment, proving the gateway relays data before the stream is complete.
      const { value: firstChunk, done: firstDone } = await reader.read();
      expect(firstDone).toBe(false);
      accumulated += decoder.decode(firstChunk, { stream: true });
      expect(accumulated).toContain(': ping');

      // Signal the server to write the final event. At this point
      // 'server-wrote-final' is not yet in `order`.
      order.push('client-read-first-chunk');
      serverGateResolve();

      // Drain the rest of the stream.
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
          accumulated += decoder.decode(value, { stream: !done });
        }
      }

      // The client observed the first chunk BEFORE the server wrote the final event.
      expect(order[0]).toBe('client-read-first-chunk');
      expect(order[1]).toBe('server-wrote-final');

      expect(accumulated).toContain(': ping\n\n');
      expect(accumulated).toContain('event: message_start');
      expect(accumulated).toContain('event: message_stop');
    } finally {
      await sseServer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — Upstream error verbatim
// ---------------------------------------------------------------------------

describe('AC4: Upstream error responses are forwarded verbatim', () => {
  it('returns the upstream 429 status and body unchanged', async () => {
    const errorBody = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded.' },
    });
    const errorServer = await startMockServer(() => ({
      status: 429,
      headers: { 'content-type': 'application/json' },
      body: errorBody,
    }));

    try {
      const errorConfig = parseGatewayConfig({
        upstreams: {
          anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${errorServer.port}` },
        },
        default: 'anthropic',
        rules: [],
      });
      const compiled = compileRules(errorConfig, new Map());
      const router = buildRouter({ compiled, emit: () => undefined });
      const app = new Hono();
      app.route('/gateway', router);

      const response = await app.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
        }),
      );

      expect(response.status).toBe(429);
      const body = await response.text();
      expect(body).toBe(errorBody);
    } finally {
      await errorServer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — count_tokens follows the same rule
// ---------------------------------------------------------------------------

describe('AC5: count_tokens follows the same rule as messages', () => {
  it('routes deepseek-* count_tokens to the LiteLLM mock', async () => {
    const response = await post('/v1/messages/count_tokens', { model: 'deepseek-v3', messages: [] }, {}, '?beta=true');

    expect(response.status).toBe(200);
    expect(litellmMock.lastRequest!.url).toBe('/v1/messages/count_tokens?beta=true');
  });

  it('routes claude-opus count_tokens to the Anthropic mock', async () => {
    await post('/v1/messages/count_tokens', { model: 'claude-opus-4-5', messages: [] });

    expect(anthropicMock.lastRequest!.url).toBe('/v1/messages/count_tokens');
  });
});

// ---------------------------------------------------------------------------
// AC7 — exactly one requestRouted event per request
// ---------------------------------------------------------------------------

describe('AC7: exactly one requestRouted event per request', () => {
  it('emits one event for an anthropic request with correct fields', async () => {
    const response = await post(
      '/v1/messages',
      { model: 'claude-opus-4-5', messages: [], stream: false },
      { authorization: 'Bearer sk-test' },
    );

    expect(response.status).toBe(200);
    expect(capturedEvents).toHaveLength(1);

    const event = capturedEvents[0]!;
    expect(event.target).toBe('anthropic');
    expect(event.upstream).toBe('anthropic');
    expect(event.path).toBe('/v1/messages');
    expect(event.requestedModel).toBe('claude-opus-4-5');
    expect(event.upstreamModel).toBe('claude-opus-4-5');
    expect(event.ruleIndex).toBeNull(); // default route, no rule matched
    expect(event.outcome).toBe('completed');
    expect(event.status).toBe(200);
    expect(event.streamed).toBe(false);
    expect(typeof event.durationMs).toBe('number');
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits one event for a litellm request with correct fields', async () => {
    const response = await post('/v1/messages', {
      model: 'deepseek-v3',
      messages: [],
      stream: true,
    });

    expect(response.status).toBe(200);
    expect(capturedEvents).toHaveLength(1);

    const event = capturedEvents[0]!;
    expect(event.target).toBe('litellm');
    expect(event.upstream).toBe('litellm');
    expect(event.path).toBe('/v1/messages');
    expect(event.requestedModel).toBe('deepseek-v3');
    expect(event.upstreamModel).toBe('DeepSeek-V4-Flash-0731');
    expect(typeof event.ruleIndex).toBe('number');
    expect(event.ruleIndex).toBeGreaterThanOrEqual(0);
    expect(event.outcome).toBe('completed');
    expect(event.status).toBe(200);
    expect(event.streamed).toBe(true);
  });

  it('emits one event for an explicit anthropic rule with non-null ruleIndex', async () => {
    await post('/v1/messages', { model: 'claude-explicit-v1', messages: [] });

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0]!;
    expect(event.target).toBe('anthropic');
    expect(event.upstream).toBe('anthropic');
    // Rule index 0 is the explicit anthropic rule in the config
    expect(event.ruleIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC8 — glob and exact rule matching
// ---------------------------------------------------------------------------

describe('AC8: rule matching (glob and exact)', () => {
  it('glob rule deepseek-* matches deepseek-v3 and deepseek-coder', async () => {
    await post('/v1/messages', { model: 'deepseek-v3', messages: [] });
    expect(capturedEvents[0]!.target).toBe('litellm');

    await post('/v1/messages', { model: 'deepseek-coder', messages: [] });
    expect(capturedEvents[0]!.target).toBe('litellm');
  });

  it('unmatched model falls through to Anthropic default', async () => {
    await post('/v1/messages', { model: 'gpt-4o', messages: [] });
    expect(capturedEvents[0]!.target).toBe('anthropic');
    expect(capturedEvents[0]!.ruleIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC10 — unknown paths return 404
// ---------------------------------------------------------------------------

describe('AC10: unknown paths return 404', () => {
  it('GET /gateway/api/hello returns 404', async () => {
    const response = await parentApp.fetch(new Request('http://localhost/gateway/api/hello', { method: 'GET' }));
    expect(response.status).toBe(404);
  });

  it('POST /gateway/unknown-path returns 404', async () => {
    const response = await parentApp.fetch(
      new Request('http://localhost/gateway/unknown-path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Invalid request body → 400
// ---------------------------------------------------------------------------

describe('Invalid request body', () => {
  it('returns 400 with Anthropic-shaped error for invalid JSON', async () => {
    capturedEvents = [];
    const response = await parentApp.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
    // No event emitted for invalid requests (cannot determine target/model)
    expect(capturedEvents).toHaveLength(0);
  });

  it('returns 400 when model field is missing', async () => {
    const response = await parentApp.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
  });
});

// ---------------------------------------------------------------------------
// Upstream unreachable → 502
// ---------------------------------------------------------------------------

describe('Upstream unreachable', () => {
  it('returns 502 with Anthropic-shaped error body and emits upstream-unreachable event', async () => {
    // Port 1 is privileged and always refuses connections in test environments
    // (ECONNREFUSED or EACCES), guaranteeing an UpstreamUnreachableError.
    const deadConfig = parseGatewayConfig({
      upstreams: {
        litellm: {
          kind: 'litellm',
          url: 'http://127.0.0.1:1',
          masterKey: 'env:LITELLM_MASTER_KEY',
        },
      },
      default: 'litellm',
      rules: [{ match: 'my-dead-model', to: 'litellm' }],
    });
    const deadCompiled = compileRules(deadConfig, new Map([['litellm', MASTER_KEY]]));
    const deadEvents: RequestRoutedEvent[] = [];
    const deadRouter = buildRouter({
      compiled: deadCompiled,
      emit: (e) => deadEvents.push(e),
    });
    const deadApp = new Hono();
    deadApp.route('/gateway', deadRouter);

    const response = await deadApp.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'my-dead-model', messages: [] }),
      }),
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({
      type: 'error',
      error: { type: 'api_error' },
    });

    expect(deadEvents).toHaveLength(1);
    expect(deadEvents[0]!.outcome).toBe('upstream-unreachable');
    expect(deadEvents[0]!.status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Abort handling — client disconnects before upstream responds
// ---------------------------------------------------------------------------

describe('Abort handling', () => {
  /**
   * Start a server that accepts connections and reads the request body but
   * never writes response headers. Used to keep `forwardRequest` pending until
   * the caller aborts the signal.
   * @returns Port, the server handle, a promise that resolves when the server
   *   handler is first entered (use this instead of a fixed delay to
   *   synchronize the abort), and a promise that resolves when the upstream
   *   connection is closed.
   */
  function startNeverRespondingServer(): Promise<{
    port: number;
    server: http.Server;
    handlerEntered: Promise<void>;
    connectionClosed: Promise<void>;
  }> {
    return new Promise((resolve) => {
      let closedResolve!: () => void;
      const connectionClosed = new Promise<void>((r) => {
        closedResolve = r;
      });
      let handlerEnteredResolve!: () => void;
      const handlerEntered = new Promise<void>((r) => {
        handlerEnteredResolve = r;
      });
      const server = http.createServer((req, res) => {
        // Signal that the handler was entered so callers can abort immediately
        // after the connection is established, without a fixed-duration sleep.
        handlerEnteredResolve();
        // Drain the request body so the client's network send completes,
        // but never call res.writeHead() — keep the client's forwardRequest
        // pending until the signal fires.
        req.resume();
        // res.on('close') fires when the underlying socket is destroyed,
        // which is the reliable signal that the TCP connection was torn down.
        // req.on('close') fires when the request stream is done, which can
        // happen before the socket itself closes.
        res.on('close', () => {
          closedResolve();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({ port, server, handlerEntered, connectionClosed });
      });
    });
  }

  it('returns 499 and emits aborted event for the anthropic branch', async () => {
    const { port, server, handlerEntered, connectionClosed } = await startNeverRespondingServer();

    try {
      const config = parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${port}` } },
        default: 'anthropic',
        rules: [],
      });
      const compiled = compileRules(config, new Map());
      const abortEvents: RequestRoutedEvent[] = [];
      const router = buildRouter({ compiled, emit: (e) => abortEvents.push(e) });
      const app = new Hono();
      app.route('/gateway', router);

      const controller = new AbortController();
      const fetchPromise = app.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
          signal: controller.signal,
        }),
      );

      // Wait for the server handler to be entered so the upstream connection
      // is established before aborting; avoids a fixed-duration sleep.
      await handlerEntered;
      controller.abort();

      const response = await fetchPromise;
      expect(response.status).toBe(499);

      expect(abortEvents).toHaveLength(1);
      expect(abortEvents[0]!.outcome).toBe('aborted');
      expect(abortEvents[0]!.status).toBeNull();

      // Verify the abort propagated to the upstream TCP connection.
      await connectionClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10_000);

  it('returns 499 and emits aborted event for the litellm branch', async () => {
    const { port, server, handlerEntered, connectionClosed } = await startNeverRespondingServer();

    try {
      const config = parseGatewayConfig({
        upstreams: {
          litellm: {
            kind: 'litellm',
            url: `http://127.0.0.1:${port}`,
            masterKey: 'env:LITELLM_MASTER_KEY',
          },
        },
        default: 'litellm',
        rules: [{ match: 'abort-model', to: 'litellm', reasoning: { mode: 'drop' } }],
      });
      const compiled = compileRules(config, new Map([['litellm', MASTER_KEY]]));
      const abortEvents: RequestRoutedEvent[] = [];
      const router = buildRouter({ compiled, emit: (e) => abortEvents.push(e) });
      const app = new Hono();
      app.route('/gateway', router);

      const controller = new AbortController();
      const fetchPromise = app.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'abort-model', messages: [] }),
          signal: controller.signal,
        }),
      );

      await handlerEntered;
      controller.abort();

      const response = await fetchPromise;
      expect(response.status).toBe(499);

      expect(abortEvents).toHaveLength(1);
      expect(abortEvents[0]!.outcome).toBe('aborted');
      expect(abortEvents[0]!.status).toBeNull();
      expect(abortEvents[0]!.target).toBe('litellm');

      await connectionClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10_000);

  it('returns 499 and emits aborted event when the runtime shutdown signal fires', async () => {
    const { port, server, handlerEntered, connectionClosed } = await startNeverRespondingServer();
    const shutdown = new AbortController();

    try {
      const config = parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${port}` } },
        default: 'anthropic',
        rules: [],
      });
      const abortEvents: RequestRoutedEvent[] = [];
      const router = buildRouter({
        compiled: compileRules(config, new Map()),
        emit: (e) => abortEvents.push(e),
        shutdownSignal: shutdown.signal,
      });
      const app = new Hono();
      app.route('/gateway', router);

      // The client never disconnects — only shutdown does.
      const fetchPromise = app.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
        }),
      );

      await handlerEntered;
      shutdown.abort();

      const response = await fetchPromise;
      expect(response.status).toBe(499);
      expect(abortEvents).toHaveLength(1);
      expect(abortEvents[0]?.outcome).toBe('aborted');
      expect(abortEvents[0]?.status).toBeNull();

      // The in-flight upstream connection was actually cancelled.
      await connectionClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10_000);

  it('shutdown abort after headers cancels the SSE body stream and closes the upstream socket', async () => {
    // This test proves that the abort link is kept alive through body
    // streaming (not released at first-byte). Without withSettleCallback, a
    // shutdownSignal.abort() fired after response headers arrive would be a
    // no-op because the link's listener was already removed, leaving the
    // upstream connection open indefinitely.
    let serverSocketClosedResolve!: () => void;
    const serverSocketClosed = new Promise<void>((r) => {
      serverSocketClosedResolve = r;
    });

    let firstChunkWrittenResolve!: () => void;
    const firstChunkWritten = new Promise<void>((r) => {
      firstChunkWrittenResolve = r;
    });

    const sseServer = await new Promise<{ port: number; server: http.Server }>((resolve) => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          });
          res.write(': ping\n\n');
          firstChunkWrittenResolve();
          // Observe socket close — signals the upstream connection was torn down.
          res.on('close', () => {
            serverSocketClosedResolve();
          });
          // Never call res.end() — hold the stream open until the signal fires.
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({ port, server });
      });
    });

    try {
      const shutdown = new AbortController();
      const config = parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${sseServer.port}` } },
        default: 'anthropic',
        rules: [],
      });
      const router = buildRouter({
        compiled: compileRules(config, new Map()),
        emit: () => undefined,
        shutdownSignal: shutdown.signal,
      });
      const app = new Hono();
      app.route('/gateway', router);

      const response = await app.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-5', messages: [], stream: true }),
        }),
      );

      expect(response.status).toBe(200);

      const reader = response.body!.getReader();

      // Read the first chunk — proves the gateway is streaming correctly.
      const { done: firstDone } = await reader.read();
      expect(firstDone).toBe(false);

      // Wait for the server to confirm the first chunk was flushed, then abort.
      await firstChunkWritten;
      shutdown.abort();

      // The body stream must error after the shutdown signal fires.
      let bodyError: unknown;
      try {
        await reader.read();
      } catch (err) {
        bodyError = err;
      }
      expect(bodyError).toBeDefined();

      // The upstream must observe the socket close — proves the abort link was
      // still active during body streaming and propagated to the TCP connection.
      await serverSocketClosed;
    } finally {
      sseServer.server.closeAllConnections();
      await new Promise<void>((r) => sseServer.server.close(() => r()));
    }
  }, 10_000);

  it('leaves no abort listener on the long-lived shutdown signal after a request settles', async () => {
    const shutdown = new AbortController();
    const config = parseGatewayConfig({
      upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropicMock.port}` } },
      default: 'anthropic',
    });
    const router = buildRouter({
      compiled: compileRules(config, new Map()),
      emit: () => undefined,
      shutdownSignal: shutdown.signal,
    });
    const app = new Hono();
    app.route('/gateway', router);

    const before = getEventListeners(shutdown.signal, 'abort').length;
    // Pin the baseline so the assertion below cannot pass vacuously. The
    // preceding test proves the listener is attached and does fire; this one
    // proves it does not accumulate.
    expect(before).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      const response = await app.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
        }),
      );
      expect(response.status).toBe(200);
      // The link is released when the response body settles, not at first
      // byte, so the body must be drained before the count is meaningful.
      await response.text();
    }

    // A per-request registration that outlived its request would accumulate
    // here — the exact leak that rules out AbortSignal.any for this seam.
    expect(getEventListeners(shutdown.signal, 'abort').length).toBe(before);
  });

  it('releases the abort link when the consumer cancels the response body mid-stream', async () => {
    // Proves that withSettleCallback's pipeTo-rejection path releases the
    // abort link even when cancellation is initiated by the client consumer
    // (reader.cancel()), not by the shutdown signal. Without the settle
    // callback, the shutdown listener would leak on the long-lived signal.
    let serverSocketClosedResolve!: () => void;
    const serverSocketClosed = new Promise<void>((r) => {
      serverSocketClosedResolve = r;
    });

    let firstChunkWrittenResolve!: () => void;
    const firstChunkWritten = new Promise<void>((r) => {
      firstChunkWrittenResolve = r;
    });

    const sseServer = await new Promise<{ port: number; server: http.Server }>((resolve) => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          });
          res.on('close', () => {
            serverSocketClosedResolve();
          });
          res.write(': ping\n\n');
          firstChunkWrittenResolve();
          // Never call res.end() — hold the stream open until consumer cancels.
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({ port, server });
      });
    });

    try {
      const shutdown = new AbortController();
      const config = parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${sseServer.port}` } },
        default: 'anthropic',
      });
      const router = buildRouter({
        compiled: compileRules(config, new Map()),
        emit: () => undefined,
        shutdownSignal: shutdown.signal,
      });
      const app = new Hono();
      app.route('/gateway', router);

      // No listener before any request has been issued.
      expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(0);

      const response = await app.fetch(
        new Request('http://localhost/gateway/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-5', messages: [], stream: true }),
        }),
      );

      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      // Read the first SSE chunk to confirm streaming is active.
      await reader.read();
      // Wait for the server to confirm the chunk was flushed before asserting
      // the listener count, so the test does not race the link setup.
      await firstChunkWritten;

      // The abort link must be alive while the body is being streamed.
      expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(1);

      // Consumer cancels — pipeTo rejection path releases the abort link.
      await reader.cancel();

      // Cancelling the consumer side must propagate back to the upstream TCP
      // connection, which the server observes as a socket close.
      await serverSocketClosed;

      // The settle callback fires asynchronously after pipeTo rejects, so
      // vi.waitFor polls until the listener is gone.
      await vi.waitFor(() => expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(0));
    } finally {
      sseServer.server.closeAllConnections();
      await new Promise<void>((r) => sseServer.server.close(() => r()));
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Access token guard
// ---------------------------------------------------------------------------

describe('Access token guard', () => {
  /** Token configured on the guarded router under test. */
  const ACCESS_TOKEN = 'gw-secret-token';

  /**
   * Build a guarded router over the shared Anthropic mock.
   * @returns The parent app plus the events emitted through it.
   */
  function buildGuardedApp(): { app: Hono; events: RequestRoutedEvent[] } {
    const config = parseGatewayConfig({
      upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropicMock.port}` } },
      default: 'anthropic',
    });
    const events: RequestRoutedEvent[] = [];
    const router = buildRouter({
      compiled: compileRules(config, new Map()),
      emit: (e) => events.push(e),
      accessToken: ACCESS_TOKEN,
    });
    const app = new Hono();
    app.route('/gateway', router);
    return { app, events };
  }

  /**
   * Send a request to the guarded app.
   * @param app - Parent app returned by {@link buildGuardedApp}.
   * @param headers - Headers to send in addition to `content-type`.
   * @returns The response from the guarded app.
   */
  async function send(app: Hono, headers: Record<string, string>): Promise<Response> {
    return app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );
  }

  it('returns 401 with an Anthropic-shaped body and emits no event when the token is absent', async () => {
    const { app, events } = buildGuardedApp();

    const response = await send(app, {});

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: expect.stringContaining('x-gateway-token') },
    });
    // Rejected before a routing decision existed, so nothing was routed.
    expect(events).toHaveLength(0);
    expect(anthropicMock.lastRequest).toBeNull();
  });

  it('returns 401 and emits no event when the token is wrong', async () => {
    const { app, events } = buildGuardedApp();

    const response = await send(app, { 'x-gateway-token': 'wrong-token-value' });

    expect(response.status).toBe(401);
    expect(events).toHaveLength(0);
    expect(anthropicMock.lastRequest).toBeNull();
  });

  it('returns 401 for a token that only shares a prefix with the configured one', async () => {
    const { app } = buildGuardedApp();

    const response = await send(app, { 'x-gateway-token': ACCESS_TOKEN.slice(0, -1) });

    expect(response.status).toBe(401);
  });

  it('rejects unknown paths with 401 rather than 404 so routes cannot be probed', async () => {
    const { app } = buildGuardedApp();

    const response = await app.fetch(new Request('http://localhost/gateway/api/hello'));

    expect(response.status).toBe(401);
  });

  it('routes the request and emits one event when the token matches', async () => {
    const { app, events } = buildGuardedApp();

    const response = await send(app, { 'x-gateway-token': ACCESS_TOKEN });

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('completed');
  });

  it('never forwards the access token header upstream', async () => {
    const { app } = buildGuardedApp();

    await send(app, { 'x-gateway-token': ACCESS_TOKEN });

    expect(anthropicMock.lastRequest).not.toBeNull();
    expect(anthropicMock.lastRequest?.headers['x-gateway-token']).toBeUndefined();
  });

  it('strips the token header even when the gateway is unauthenticated', async () => {
    // A client may not smuggle the header through an unguarded gateway either.
    await post('/v1/messages', { model: 'claude-opus-4-5', messages: [] }, { 'x-gateway-token': 'smuggled' });

    expect(anthropicMock.lastRequest?.headers['x-gateway-token']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request body size limit
// ---------------------------------------------------------------------------

describe('Request body size limit', () => {
  /** Small cap so the oversized bodies stay cheap to build. */
  const MAX_BODY_BYTES = 256;

  /**
   * Build a router that rejects bodies over {@link MAX_BODY_BYTES}.
   * @returns The parent app plus the events emitted through it.
   */
  function buildCappedApp(): { app: Hono; events: RequestRoutedEvent[] } {
    const config = parseGatewayConfig({
      upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropicMock.port}` } },
      default: 'anthropic',
    });
    const events: RequestRoutedEvent[] = [];
    const router = buildRouter({
      compiled: compileRules(config, new Map()),
      emit: (e) => events.push(e),
      maxBodyBytes: MAX_BODY_BYTES,
    });
    const app = new Hono();
    app.route('/gateway', router);
    return { app, events };
  }

  /**
   * Build a request body whose serialised length exceeds the cap.
   * @returns A valid Messages body larger than {@link MAX_BODY_BYTES}.
   */
  function oversizedBody(): string {
    return JSON.stringify({ model: 'claude-opus-4-5', messages: [{ role: 'user', content: 'x'.repeat(512) }] });
  }

  it('rejects with 413 before reading when content-length exceeds the cap', async () => {
    const { app, events } = buildCappedApp();

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        // Declared length alone is enough to reject; the body itself is small.
        headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: expect.stringContaining(String(MAX_BODY_BYTES)) },
    });
    expect(events).toHaveLength(0);
    expect(anthropicMock.lastRequest).toBeNull();
  });

  it('rejects with 413 while streaming when the body exceeds the cap without a declared length', async () => {
    const { app, events } = buildCappedApp();
    const body = oversizedBody();

    const request = new Request('http://localhost/gateway/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    // Guard the premise: with no declared length, only the streaming counter
    // can catch this body.
    expect(request.headers.get('content-length')).toBeNull();

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    expect(events).toHaveLength(0);
    expect(anthropicMock.lastRequest).toBeNull();
  });

  it('forwards a body that fits within the cap', async () => {
    const { app, events } = buildCappedApp();

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('returns 400 with an Anthropic-shaped error and emits no event when content-length contradicts the body size', async () => {
    // Verifies the ContentLengthMismatchError → 400 invalid_request_error mapping.
    // content-length: 5 passes the pre-check (5 ≤ MAX_BODY_BYTES), but
    // readBodyWithLimit throws ContentLengthMismatchError when the body stream
    // delivers more bytes than the 5-byte preallocated buffer.
    const { app, events } = buildCappedApp();

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        // Declared 5 bytes; actual JSON body is far larger. The mismatch is
        // caught by the streaming counter before any routing decision is made.
        headers: { 'content-type': 'application/json', 'content-length': '5' },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: expect.stringContaining('5'),
      },
    });
    // Pre-routing rejection: the emit callback must never have been called.
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Upstream trailing-slash normalisation
// ---------------------------------------------------------------------------

describe('Upstream trailing-slash normalisation', () => {
  it('forwards to the correct path when upstream URL has a trailing slash', async () => {
    const trailingSlashConfig = parseGatewayConfig({
      upstreams: {
        // Upstream URL with trailing slash — must not produce double-slash paths.
        anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropicMock.port}/` },
      },
      default: 'anthropic',
      rules: [],
    });
    const compiled = compileRules(trailingSlashConfig, new Map());
    const router = buildRouter({ compiled, emit: () => undefined });
    const app = new Hono();
    app.route('/gateway', router);

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    // The anthropic mock must receive the request at /v1/messages, not //v1/messages.
    expect(anthropicMock.lastRequest!.url).toBe('/v1/messages');
  });
});

// ---------------------------------------------------------------------------
// Connection-header nomination (RFC 7230 §6.1)
// ---------------------------------------------------------------------------

describe('Connection-header nomination (RFC 7230 §6.1)', () => {
  it('litellm branch: injected master key survives a Connection: authorization nomination', async () => {
    // The client nominates `authorization` and `x-api-key` for removal via the
    // Connection header. After our fix, filterRequestHeaders strips both BEFORE
    // prepareLitellmHeaders injects the master key, so the master key arrives
    // at the litellm mock unchanged.
    await post(
      '/v1/messages',
      { model: 'deepseek-v3', messages: [] },
      {
        authorization: 'Bearer sk-client-original',
        'x-api-key': 'client-api-key',
        connection: 'authorization, x-api-key',
      },
    );

    const headers = litellmMock.lastRequest!.headers;
    expect(headers['authorization']).toBe(`Bearer ${MASTER_KEY}`);
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('anthropic branch: Connection-nominated authorization is stripped per RFC', async () => {
    // A client-supplied `Connection: authorization` must strip `authorization`
    // from the forwarded request — the RFC 7230 §6.1 hop-by-hop removal.
    await post(
      '/v1/messages',
      { model: 'claude-opus-4-5', messages: [] },
      {
        authorization: 'Bearer sk-client-forwarded',
        connection: 'authorization',
      },
    );

    const headers = anthropicMock.lastRequest!.headers;
    expect(headers['authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anthropic upstream with auth.apiKey credential injection
// ---------------------------------------------------------------------------

describe('Anthropic upstream auth.apiKey injection', () => {
  it('sets x-api-key to the resolved key, removes authorization, and preserves body bytes', async () => {
    const RESOLVED_KEY = 'sk-gateway-owned-key';
    // Irregular whitespace and escapes, as in the AC1 case: injecting an auth
    // header must not disturb the body bytes either.
    const rawBody = '{  "model" : "claude-opus-4-5" ,\n "messages" : [ ] ,\t"system":"a\\u00e9\\"b\\\\c" }';
    const authConfig = parseGatewayConfig({
      upstreams: {
        'anthropic-auth': {
          kind: 'anthropic',
          url: `http://127.0.0.1:${anthropicMock.port}`,
          auth: { apiKey: 'env:ANTHROPIC_API_KEY' },
        },
      },
      default: 'anthropic-auth',
      rules: [],
    });
    const authEvents: RequestRoutedEvent[] = [];
    const compiled = compileRules(authConfig, new Map([['anthropic-auth', RESOLVED_KEY]]));
    const router = buildRouter({ compiled, emit: (e) => authEvents.push(e) });
    const app = new Hono();
    app.route('/gateway', router);

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-client-token',
          'x-api-key': 'sk-client-key',
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    const req = anthropicMock.lastRequest;
    expect(req).not.toBeNull();
    // Gateway-owned key replaces client credentials.
    expect(req?.headers['x-api-key']).toBe(RESOLVED_KEY);
    // Client authorization header is removed.
    expect(req?.headers['authorization']).toBeUndefined();
    // Body bytes are identical — the anthropic branch never mutates the body.
    expect(req?.body).toBe(rawBody);
    expect(Buffer.from(req?.body ?? '', 'utf-8').equals(Buffer.from(rawBody, 'utf-8'))).toBe(true);
    // Event carries the upstream name.
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0]?.upstream).toBe('anthropic-auth');
    expect(authEvents[0]?.target).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Static strategy with multiple candidates in `to`
// ---------------------------------------------------------------------------

describe('Static strategy: first upstream in `to` always selected', () => {
  it('routes to the first upstream when `to` lists two candidates', async () => {
    // default is 'litellm' so a fall-through would send the request to litellm.
    // The rule targets ['anthropic', 'litellm']; the static strategy must pick
    // 'anthropic' (first), proving that rule matching — not the default — won.
    const multiConfig = parseGatewayConfig({
      upstreams: {
        anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropicMock.port}` },
        litellm: {
          kind: 'litellm',
          url: `http://127.0.0.1:${litellmMock.port}`,
          masterKey: 'env:LITELLM_MASTER_KEY',
        },
      },
      default: 'litellm',
      rules: [
        {
          match: 'multi-target-*',
          to: ['anthropic', 'litellm'],
          strategy: { kind: 'static' },
        },
      ],
    });
    const multiEvents: RequestRoutedEvent[] = [];
    const compiled = compileRules(multiConfig, new Map([['litellm', MASTER_KEY]]));
    const router = buildRouter({ compiled, emit: (e) => multiEvents.push(e) });
    const app = new Hono();
    app.route('/gateway', router);

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'multi-target-v1', messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    // The anthropic mock (first in `to`) must have received the request.
    expect(anthropicMock.lastRequest).not.toBeNull();
    expect(anthropicMock.lastRequest!.url).toBe('/v1/messages');
    // Emitted event names the first upstream and its kind.
    expect(multiEvents).toHaveLength(1);
    expect(multiEvents[0]!.upstream).toBe('anthropic');
    expect(multiEvents[0]!.target).toBe('anthropic');
    // Rule matched at index 0 — not a default fall-through.
    expect(multiEvents[0]!.ruleIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LiteLLM as default upstream: unmatched model falls through to litellm
// ---------------------------------------------------------------------------

describe('LiteLLM default upstream: unmatched model falls through', () => {
  it('routes an unmatched model to the litellm default, event ruleIndex is null', async () => {
    // Config: litellm is the default; one anthropic rule matches 'claude-*'.
    // Sending 'gpt-4o' (no matching rule) must fall through to litellm.
    const llmDefaultConfig = parseGatewayConfig({
      upstreams: {
        litellm: {
          kind: 'litellm',
          url: `http://127.0.0.1:${litellmMock.port}`,
          masterKey: 'env:LITELLM_MASTER_KEY',
        },
        anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropicMock.port}` },
      },
      default: 'litellm',
      rules: [{ match: 'claude-*', to: 'anthropic' }],
    });
    const llmDefaultEvents: RequestRoutedEvent[] = [];
    const compiled = compileRules(llmDefaultConfig, new Map([['litellm', MASTER_KEY]]));
    const router = buildRouter({ compiled, emit: (e) => llmDefaultEvents.push(e) });
    const app = new Hono();
    app.route('/gateway', router);

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    // The litellm mock must have received the request (not the anthropic mock).
    expect(litellmMock.lastRequest).not.toBeNull();
    expect(llmDefaultEvents).toHaveLength(1);

    const event = llmDefaultEvents[0]!;
    expect(event.target).toBe('litellm');
    expect(event.upstream).toBe('litellm');
    // No rule matched — default route, ruleIndex must be null.
    expect(event.ruleIndex).toBeNull();
    expect(event.requestedModel).toBe('gpt-4o');
    expect(event.outcome).toBe('completed');
  });
});
