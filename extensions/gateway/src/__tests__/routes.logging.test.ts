/**
 * Operator-logging tests for {@link createGatewayRouter}.
 *
 * Architecture: a real Hono sub-app with a real compiled routing table, mounted
 * on a parent app and driven through `app.fetch()`, against real `node:http`
 * mock upstreams. Nothing under test is mocked — the log sink is a real
 * implementation of the router's own `logger` seam, so these tests assert the
 * output contract rather than how it reaches a terminal.
 *
 * The invariant under test: every request that reaches the gateway produces
 * exactly one line, whether it was routed or rejected, and no line ever
 * contains a credential.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { compileRules } from '../routing/match.js';
import { parseGatewayConfig } from '../config.js';
import { createGatewayRouter, type GatewayRuntime } from '../routes.js';
import type { RequestRoutedEvent } from '../contracts/schemas.js';
import type { GatewayLogger } from '../logging.js';
import { createCapturingLogger, type CapturingLogger } from './helpers/capturing-logger.js';
import { startMockServer, type MockServer } from './helpers/mock-upstream.js';

// ---------------------------------------------------------------------------
// Secrets used across the suite — no log line may contain any of them.
// ---------------------------------------------------------------------------

/** Resolved LiteLLM master key injected into every LiteLLM upstream request. */
const MASTER_KEY = 'sk-litellm-master-must-never-appear';
/** Resolved gateway access token callers must present. */
const ACCESS_TOKEN = 'gw-access-token-must-never-appear';
/** Bearer token a client sends through to an Anthropic pass-through upstream. */
const CLIENT_OAUTH_TOKEN = 'client-oauth-must-never-appear';
/** API key a client sends in `x-api-key`. */
const CLIENT_API_KEY = 'client-api-key-must-never-appear';

/** Credential an upstream echoes back inside its error body. */
const ECHOED_BEARER = 'upstream-echoed-bearer-must-never-appear';
/** Prompt fragment an upstream echoes back inside its error body. */
const ECHOED_PROMPT = 'echoed-private-prompt-must-never-appear';

/** Every secret value that must be absent from the gateway's output. */
const ALL_SECRETS = [
  MASTER_KEY,
  ACCESS_TOKEN,
  CLIENT_OAUTH_TOKEN,
  CLIENT_API_KEY,
  ECHOED_BEARER,
  ECHOED_PROMPT,
] as const;

/**
 * Gate held by the `latched` and `hanging` upstream modes.
 *
 * Both send error response headers immediately and withhold the body, which is
 * what separates "the client has its headers" from "the log line is ready".
 */
let bodyGate: { readonly released: Promise<void>; readonly release: () => void };

/**
 * Create a fresh body gate.
 * @returns A promise the upstream awaits before ending its body, and its opener.
 */
function createBodyGate(): { readonly released: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Anthropic mock — responds according to the request's `x-mock-mode` header. */
let anthropicMock: MockServer;
/** LiteLLM mock — always a plain 200. */
let litellmMock: MockServer;

/**
 * Response shapes the Anthropic mock can be asked for via `x-mock-mode`.
 *
 * Keyed by header value so a test picks its upstream behaviour per request
 * without needing its own server.
 */
const ANTHROPIC_MOCK_MODES: Record<string, { status: number; contentType: string; body: string }> = {
  envelopeEcho: {
    status: 400,
    contentType: 'application/json',
    // A realistic upstream error body: a recognised envelope alongside an echo
    // of the offending request. Only the envelope may be logged.
    body: JSON.stringify({
      error: { type: 'invalid_request_error', message: 'model not found: claude-nope' },
      request: {
        headers: { authorization: `Bearer ${ECHOED_BEARER}`, 'x-api-key': CLIENT_API_KEY },
        messages: [{ role: 'user', content: ECHOED_PROMPT }],
      },
    }),
  },
  ok: { status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'message', id: 'ok' }) },
  notFound: {
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: { type: 'not_found_error', message: 'model not found: claude-nope' } }),
  },
  messageOnly: {
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
  },
  controlChars: {
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'line one\nline two\r\n\tline three\u0007' } }),
  },
  htmlError: { status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' },
  longError: { status: 500, contentType: 'text/plain', body: `E${'x'.repeat(8000)}E` },
  emptyError: { status: 503, contentType: 'text/plain', body: '' },
};

/** Error body the `latched` upstream releases once its gate opens. */
const LATCHED_BODY = JSON.stringify({ error: { type: 'overloaded_error', message: 'upstream is busy' } });

beforeAll(async () => {
  anthropicMock = await startMockServer((req) => {
    const mode = typeof req.headers['x-mock-mode'] === 'string' ? req.headers['x-mock-mode'] : 'ok';

    if (mode === 'trickle') {
      return {
        status: 502,
        headers: { 'content-type': 'application/json' },
        // Part of an error envelope, then silence. Only an abort can end a read
        // of this body.
        body: (res) => {
          res.flushHeaders();
          res.write('{"error":{"mes');
        },
      };
    }

    if (mode === 'latched' || mode === 'hanging') {
      return {
        status: 503,
        headers: { 'content-type': 'application/json' },
        // Flush headers now, withhold the body. `hanging` never ends at all —
        // only an abort can finish that read.
        body: (res) => {
          res.flushHeaders();
          if (mode === 'latched') {
            void bodyGate.released.then(() => res.end(LATCHED_BODY));
          }
        },
      };
    }

    const shape = ANTHROPIC_MOCK_MODES[mode] ?? ANTHROPIC_MOCK_MODES['ok'];
    if (shape === undefined) throw new Error(`Unknown mock mode: ${mode}`);
    return { status: shape.status, headers: { 'content-type': shape.contentType }, body: shape.body };
  });

  litellmMock = await startMockServer(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', id: 'litellm-ok' }),
  }));
});

beforeEach(() => {
  bodyGate = createBodyGate();
});

afterEach(() => {
  // Never leave a mock upstream holding a socket open for the next test.
  bodyGate.release();
});

afterAll(async () => {
  await anthropicMock.close();
  await litellmMock.close();
});

/** A mounted gateway with its captured log lines and bus events. */
interface Harness {
  /** Parent app with the gateway mounted at `/gateway`. */
  readonly app: Hono;
  /** Live view over what the gateway logged. */
  readonly captured: CapturingLogger;
  /** Events the gateway published, for cross-checking against the log. */
  readonly events: RequestRoutedEvent[];
}

/** Per-harness overrides for the parts of the gateway a test cares about. */
interface HarnessOptions {
  /** Access token the gateway requires, or `null` for no authentication. */
  readonly accessToken?: string | null;
  /** Body cap in bytes. */
  readonly maxBodyBytes?: number;
  /** Anthropic upstream URL, for pointing at a closed port. */
  readonly anthropicUrl?: string;
  /** Shutdown signal, for tests that abort an in-flight request. */
  readonly shutdownSignal?: AbortSignal;
  /** Log sink override, for tests that need a misbehaving one. */
  readonly logger?: GatewayLogger;
}

/**
 * Build a gateway mounted on a parent app, with a capturing log sink.
 *
 * Each harness is independent, so a test never sees a line produced by another.
 * @param options - Overrides for the access token, body cap, and upstream URL.
 * @returns The mounted app plus live views over the log and the bus events.
 */
function buildHarness(options: HarnessOptions = {}): Harness {
  const config = parseGatewayConfig({
    upstreams: {
      anthropic: { kind: 'anthropic', url: options.anthropicUrl ?? `http://127.0.0.1:${anthropicMock.port}` },
      litellm: {
        kind: 'litellm',
        url: `http://127.0.0.1:${litellmMock.port}`,
        masterKey: 'env:LITELLM_MASTER_KEY',
      },
    },
    default: 'anthropic',
    rules: [{ match: 'deepseek-*', to: 'litellm', model: 'DeepSeek-V4-Flash', reasoning: { mode: 'passthrough' } }],
  });

  const captured = createCapturingLogger();
  const events: RequestRoutedEvent[] = [];
  // An already-resolved runtime: these suites assert on the lines a request
  // produces, so the credentials are in hand before the first one arrives. The
  // lines written while they are *not* are asserted in `gateway-service.test.ts`.
  const runtime: GatewayRuntime = {
    compiled: compileRules(config, new Map([['litellm', MASTER_KEY]])),
    accessToken: options.accessToken ?? null,
  };
  const router = createGatewayRouter({
    ensureRuntime: () => Promise.resolve(runtime),
    emit: (event) => events.push(event),
    maxBodyBytes: options.maxBodyBytes ?? 64 * 1024 * 1024,
    shutdownSignal: options.shutdownSignal ?? new AbortController().signal,
    logger: options.logger ?? captured.logger,
  });

  const app = new Hono();
  app.route('/gateway', router);
  return { app, captured, events };
}

/**
 * Send a POST through the harness with a caller-supplied raw body.
 * @param harness - Harness to send through.
 * @param rawBody - Exact body string to send.
 * @param extraHeaders - Additional request headers.
 * @param path - Path relative to `/gateway`.
 * @returns The response the gateway produced.
 */
async function postRaw(
  harness: Harness,
  rawBody: string,
  extraHeaders: Record<string, string> = {},
  path = '/v1/messages',
): Promise<Response> {
  return await harness.app.fetch(
    new Request(`http://localhost/gateway${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: rawBody,
    }),
  );
}

/**
 * Wait for the harness to produce exactly one line, then return it.
 *
 * Asynchronous because a line describing an upstream error is written when the
 * bounded read of that error body finishes, which is deliberately *after* the
 * client response has been handed back.
 * @param harness - Harness to read from.
 * @param level - Severity the line is expected to carry.
 * @returns The single captured message.
 */
async function soleLine(harness: Harness, level: 'info' | 'warn'): Promise<string> {
  await vi.waitFor(() => {
    expect(harness.captured.lines).toHaveLength(1);
  });
  const [line] = harness.captured.lines;
  if (line === undefined) throw new Error('unreachable: length already asserted');
  expect(line.level).toBe(level);
  return line.message;
}

// ---------------------------------------------------------------------------
// Routed requests
// ---------------------------------------------------------------------------

describe('routed requests produce one line derived from the emitted event', () => {
  it('logs a default-routed 200 at info with every field the event carries', async () => {
    const harness = buildHarness();

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }));

    expect(response.status).toBe(200);
    const line = await soleLine(harness, 'info');
    expect(line).toMatch(
      /^POST \/v1\/messages model="claude-opus-4-5" upstream="anthropic" kind=anthropic rule=default outcome=completed status=200 streamed=false duration=\d+ms$/,
    );
  });

  it('omits upstreamModel when no rule renamed the model', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }));

    expect(await soleLine(harness, 'info')).not.toContain('upstreamModel=');
  });

  it('reports the rule index, the renamed upstream model, and the stream flag', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'deepseek-r1', messages: [], stream: true }));

    const line = await soleLine(harness, 'info');
    expect(line).toContain('model="deepseek-r1"');
    expect(line).toContain('upstream="litellm" kind=litellm');
    expect(line).toContain('upstreamModel="DeepSeek-V4-Flash"');
    expect(line).toContain('rule=0');
    expect(line).toContain('streamed=true');
  });

  it('reports the routed path for count_tokens', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5' }), {}, '/v1/messages/count_tokens');

    expect(await soleLine(harness, 'info')).toContain('POST /v1/messages/count_tokens');
  });

  it('agrees with the emitted event on every shared field', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'deepseek-r1', messages: [], stream: true }));

    const [event] = harness.events;
    if (event === undefined) throw new Error('expected exactly one event');
    const line = await soleLine(harness, 'info');
    expect(line).toContain(`model="${event.requestedModel}"`);
    expect(line).toContain(`upstream="${event.upstream}"`);
    expect(line).toContain(`kind=${event.target}`);
    expect(line).toContain(`upstreamModel="${event.upstreamModel}"`);
    expect(line).toContain(`rule=${String(event.ruleIndex)}`);
    expect(line).toContain(`status=${String(event.status)}`);
    expect(line).toContain(`streamed=${String(event.streamed)}`);
    expect(line).toContain(`duration=${String(Math.round(event.durationMs))}ms`);
  });

  it('collapses a client-supplied model containing newlines into one line', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'claude\n\u0007injected line\nopus', messages: [] }));

    const line = await soleLine(harness, 'info');
    expect(line).not.toContain('\n');
    expect(line).toContain('model="claude injected line opus"');
  });
});

// ---------------------------------------------------------------------------
// Upstream failures
// ---------------------------------------------------------------------------

describe('upstream errors are summarised, never quoted raw', () => {
  it('logs the type and message of a recognised error envelope', async () => {
    const harness = buildHarness();

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-nope', messages: [] }), {
      'x-mock-mode': 'notFound',
    });

    expect(response.status).toBe(404);
    const line = await soleLine(harness, 'warn');
    expect(line).toContain('status=404');
    expect(line).toContain('upstreamError="not_found_error: model not found: claude-nope"');
  });

  it('logs the message alone when the envelope carries no type', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'messageOnly',
    });

    expect(await soleLine(harness, 'warn')).toContain('upstreamError="rate limit exceeded"');
  });

  it('logs only the envelope fields when the body also echoes the request', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'claude-nope', messages: [{ role: 'user', content: 'hi' }] }), {
      'x-mock-mode': 'envelopeEcho',
    });

    const line = await soleLine(harness, 'warn');
    expect(line).toContain('upstreamError="invalid_request_error: model not found: claude-nope"');
    // The upstream echoed a credential and a prompt back in its error body.
    // Only the allowlisted envelope fields may survive into the log.
    expect(line).not.toContain(ECHOED_BEARER);
    expect(line).not.toContain(ECHOED_PROMPT);
    expect(line).not.toContain(CLIENT_API_KEY);
  });

  it('flattens control characters inside an envelope message', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'controlChars',
    });

    const line = await soleLine(harness, 'warn');
    expect(line).not.toContain('\n');
    expect(line).toContain('upstreamError="line one line two line three"');
  });

  it('degrades to a byte count and content type for a body that is not an envelope', async () => {
    const harness = buildHarness();

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'htmlError',
    });

    const line = await soleLine(harness, 'warn');
    expect(line).toContain('status=502');
    expect(line).toContain('upstreamErrorBytes=37');
    expect(line).toContain('upstreamContentType="text/html"');
    // The body itself is never quoted, only described.
    expect(line).not.toContain('Bad Gateway');
    expect(await response.text()).toBe('<html><body>Bad Gateway</body></html>');
  });

  it('reports a zero-length error body rather than staying silent', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'emptyError',
    });

    const line = await soleLine(harness, 'warn');
    expect(line).toContain('status=503');
    expect(line).toContain('upstreamErrorBytes=0');
  });

  it('retains exactly the byte cap from an oversized error body and forwards it in full', async () => {
    const harness = buildHarness();

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'longError',
    });

    // The client still receives every byte the upstream sent.
    expect(await response.text()).toHaveLength(8002);

    const line = await soleLine(harness, 'warn');
    // Exactly the bound, not the bound plus whatever the crossing chunk held.
    expect(line).toContain('upstreamErrorBytes=4096+');
    expect(line).not.toContain('upstreamError=');
    expect(line.length).toBeLessThan(400);
  });

  it('logs an unreachable upstream at warn with no status', async () => {
    const closed = await startMockServer(() => ({ status: 200, headers: {}, body: '' }));
    const deadPort = closed.port;
    await closed.close();
    const harness = buildHarness({ anthropicUrl: `http://127.0.0.1:${deadPort}` });

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }));

    expect(response.status).toBe(502);
    const line = await soleLine(harness, 'warn');
    expect(line).toContain('outcome=upstream-unreachable');
    expect(line).toContain('status=-');
    expect(line).not.toContain('upstreamError');
  });
});

// ---------------------------------------------------------------------------
// The summary read is off the response path
// ---------------------------------------------------------------------------

describe('summarising an upstream error never delays the client', () => {
  it('returns headers before the upstream releases its error body', async () => {
    const harness = buildHarness();

    // The upstream flushes 503 headers and then withholds its body until the
    // gate opens. If the gateway awaited the summary read before responding,
    // this await would never resolve — the gate is only opened afterwards.
    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'latched',
    });

    expect(response.status).toBe(503);
    // The bus event is published at header time, so it is already here and its
    // duration cannot include the body delay.
    expect(harness.events).toHaveLength(1);
    // No line yet: the summary read is still waiting on the upstream body.
    expect(harness.captured.lines).toHaveLength(0);

    bodyGate.release();

    const line = await soleLine(harness, 'warn');
    expect(line).toContain('upstreamError="overloaded_error: upstream is busy"');
    // The line reports the header-time duration the event recorded, not the
    // time the summary took to arrive.
    const [event] = harness.events;
    if (event === undefined) throw new Error('expected exactly one event');
    expect(line).toContain(`duration=${String(Math.round(event.durationMs))}ms`);
  });

  it('still writes exactly one line when the error body never ends and the runtime shuts down', async () => {
    const shutdown = new AbortController();
    const harness = buildHarness({ shutdownSignal: shutdown.signal });

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'hanging',
    });

    expect(response.status).toBe(503);
    expect(harness.captured.lines).toHaveLength(0);

    // Two things end the read, and neither needs the upstream to cooperate:
    // the excerpt signal this request owns, and the shared upstream stream
    // erroring once the shutdown abort cancels the fetch.
    shutdown.abort();

    const line = await soleLine(harness, 'warn');
    expect(line).toContain('status=503');
    // `+`: cancelling a reader resolves its pending read with `done`, so the
    // read must not be mistaken for one that saw the body end.
    expect(line).toContain('upstreamErrorBytes=0+');
  });

  it('terminates the error-body read when the client cancels the response body', async () => {
    const harness = buildHarness();

    // The upstream sends part of an error body and then holds the connection
    // open forever. Nothing in this test ever lets it finish.
    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }), {
      'x-mock-mode': 'trickle',
    });

    expect(response.status).toBe(502);
    expect(harness.captured.lines).toHaveLength(0);

    // The client walks away mid-stream. The gateway's abort link is released at
    // that point, so only a lifetime the request itself owns can still stop the
    // error-body read — if it cannot, this test hangs and no line is written.
    await response.body?.cancel();

    const line = await soleLine(harness, 'warn');
    expect(line).toContain('status=502');
    expect(line).toMatch(/upstreamErrorBytes=\d+\+/);
    // A read cut short must never be parsed as if it were the whole envelope.
    expect(line).not.toContain('upstreamError=');
  });
});

// ---------------------------------------------------------------------------
// Pre-routing rejections
// ---------------------------------------------------------------------------

describe('pre-routing rejections are logged even though they emit no event', () => {
  it('distinguishes a missing access token from an invalid one', async () => {
    const missing = buildHarness({ accessToken: ACCESS_TOKEN });
    const invalid = buildHarness({ accessToken: ACCESS_TOKEN });

    const missingResponse = await postRaw(missing, JSON.stringify({ model: 'claude-opus-4-5' }));
    const invalidResponse = await postRaw(invalid, JSON.stringify({ model: 'claude-opus-4-5' }), {
      'x-gateway-token': 'wrong-token',
    });

    expect(missingResponse.status).toBe(401);
    expect(invalidResponse.status).toBe(401);
    expect(missing.events).toHaveLength(0);
    expect(invalid.events).toHaveLength(0);

    expect(await soleLine(missing, 'warn')).toBe(
      'POST /gateway/v1/messages rejected status=401 reason="access token missing"',
    );
    expect(await soleLine(invalid, 'warn')).toBe(
      'POST /gateway/v1/messages rejected status=401 reason="access token invalid"',
    );
  });

  it('reports the observed size and the configured limit for a declared oversized body', async () => {
    const harness = buildHarness({ maxBodyBytes: 256 });

    const response = await harness.app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '900' },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(413);
    expect(harness.events).toHaveLength(0);
    const line = await soleLine(harness, 'warn');
    expect(line).toContain('POST /v1/messages rejected status=413');
    expect(line).toContain('bytes=900 limit=256');
  });

  it('reports the received size when an undeclared body runs past the limit', async () => {
    const harness = buildHarness({ maxBodyBytes: 256 });
    const body = JSON.stringify({ model: 'claude-opus-4-5', messages: [{ role: 'user', content: 'x'.repeat(512) }] });

    const request = new Request('http://localhost/gateway/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    // Guard the premise: with no declared length only the streaming counter can
    // catch this body, so `bytes=` must come from the running total.
    expect(request.headers.get('content-length')).toBeNull();

    const response = await harness.app.fetch(request);

    expect(response.status).toBe(413);
    expect(await soleLine(harness, 'warn')).toMatch(/status=413 .*bytes=\d+ limit=256$/);
  });

  it('names the declared length once when the body contradicts its own framing', async () => {
    const harness = buildHarness({ maxBodyBytes: 256 });

    const response = await harness.app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '5' },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(400);
    const line = await soleLine(harness, 'warn');
    expect(line).toBe(
      'POST /v1/messages rejected status=400 ' +
        'reason="Request body is larger than its declared content-length of 5 bytes."',
    );
  });

  it('logs the catch-all 404 for an unknown path', async () => {
    const harness = buildHarness();

    const response = await harness.app.fetch(new Request('http://localhost/gateway/v1/complete', { method: 'POST' }));

    expect(response.status).toBe(404);
    expect(harness.events).toHaveLength(0);
    expect(await soleLine(harness, 'warn')).toBe(
      'POST /gateway/v1/complete rejected status=404 reason="unknown route"',
    );
  });

  it('logs the catch-all 404 for an unsupported method on a routed path', async () => {
    const harness = buildHarness();

    const response = await harness.app.fetch(new Request('http://localhost/gateway/v1/messages'));

    expect(response.status).toBe(404);
    expect(await soleLine(harness, 'warn')).toBe('GET /gateway/v1/messages rejected status=404 reason="unknown route"');
  });

  it('logs a 401 rather than a 404 when an unknown path is probed without a token', async () => {
    // The guard runs ahead of route matching, so an unauthenticated caller
    // still learns nothing about which paths exist — and only one line is
    // written, not one per layer.
    const harness = buildHarness({ accessToken: ACCESS_TOKEN });

    const response = await harness.app.fetch(new Request('http://localhost/gateway/v1/complete', { method: 'POST' }));

    expect(response.status).toBe(401);
    expect(await soleLine(harness, 'warn')).toBe(
      'POST /gateway/v1/complete rejected status=401 reason="access token missing"',
    );
  });

  it('caps an oversized client-supplied model', async () => {
    const harness = buildHarness();

    await postRaw(harness, JSON.stringify({ model: 'm'.repeat(50_000), messages: [] }));

    const line = await soleLine(harness, 'info');
    expect(line).toContain('...');
    // 200 model characters plus the rest of the line — nowhere near 50 000.
    expect(line.length).toBeLessThan(400);
  });

  it('logs the client-facing message for an unparseable body', async () => {
    const harness = buildHarness();

    const response = await postRaw(harness, 'not json at all');

    expect(response.status).toBe(400);
    expect(harness.events).toHaveLength(0);
    expect(await soleLine(harness, 'warn')).toBe(
      'POST /v1/messages rejected status=400 reason="Request body is not valid JSON."',
    );
  });

  it('logs the client-facing message for a body with no model', async () => {
    const harness = buildHarness();

    const response = await postRaw(harness, JSON.stringify({ messages: [] }));

    expect(response.status).toBe(400);
    const line = await soleLine(harness, 'warn');
    expect(line).toContain('rejected status=400');
    // The quoting keeps the message's own quotes unambiguous rather than
    // truncating the field at the first one.
    expect(line).toContain('\\"model\\"');
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('no log line ever contains a credential', () => {
  it('keeps every secret out of the output for a routed LiteLLM request', async () => {
    const harness = buildHarness({ accessToken: ACCESS_TOKEN });

    const response = await postRaw(harness, JSON.stringify({ model: 'deepseek-r1', messages: [] }), {
      'x-gateway-token': ACCESS_TOKEN,
      authorization: `Bearer ${CLIENT_OAUTH_TOKEN}`,
      'x-api-key': CLIENT_API_KEY,
    });

    expect(response.status).toBe(200);
    // Premise: the gateway really did inject the master key upstream, so its
    // absence from the log is a redaction result and not a routing accident.
    expect(litellmMock.lastRequest?.headers.authorization).toBe(`Bearer ${MASTER_KEY}`);

    const { text } = harness.captured;
    expect(text).not.toBe('');
    for (const secret of ALL_SECRETS) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps the expected and the supplied token out of a 401 line', async () => {
    const harness = buildHarness({ accessToken: ACCESS_TOKEN });

    await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5' }), {
      'x-gateway-token': CLIENT_API_KEY,
      authorization: `Bearer ${CLIENT_OAUTH_TOKEN}`,
    });

    const { text } = harness.captured;
    expect(text).toContain('status=401');
    for (const secret of ALL_SECRETS) {
      expect(text).not.toContain(secret);
    }
  });

  it('never logs request body content', async () => {
    const harness = buildHarness();
    const secretPrompt = 'the-users-private-prompt-text';

    await postRaw(
      harness,
      JSON.stringify({ model: 'claude-opus-4-5', messages: [{ role: 'user', content: secretPrompt }] }),
    );

    expect(harness.captured.text).not.toContain(secretPrompt);
  });
});

// ---------------------------------------------------------------------------
// A broken sink is never the client's problem
// ---------------------------------------------------------------------------

describe('a throwing log sink cannot affect the response', () => {
  /** A real sink that fails every call, in both of the ways a sink can fail. */
  const throwingLogger: GatewayLogger = {
    /**
     * Fail synchronously.
     * @param message - Ignored.
     */
    info(message: string): void {
      throw new Error(`sink is broken: ${message}`);
    },
    /**
     * Fail synchronously.
     * @param message - Ignored.
     */
    warn(message: string): void {
      throw new Error(`sink is broken: ${message}`);
    },
    /**
     * Fail synchronously.
     * @param message - Ignored.
     */
    error(message: string): void {
      throw new Error(`sink is broken: ${message}`);
    },
  };

  it('leaves a routed response intact', async () => {
    const harness = buildHarness({ logger: throwingLogger });

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5', messages: [] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 'message', id: 'ok' });
    expect(harness.events).toHaveLength(1);
  });

  it('leaves an upstream-error response intact, body and all', async () => {
    const harness = buildHarness({ logger: throwingLogger });

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-nope', messages: [] }), {
      'x-mock-mode': 'notFound',
    });

    expect(response.status).toBe(404);
    // The sink throws when the deferred summary lands; the body must still be
    // fully readable afterwards.
    expect(await response.text()).toContain('model not found: claude-nope');
  });

  it('leaves a 401 rejection intact', async () => {
    const harness = buildHarness({ accessToken: ACCESS_TOKEN, logger: throwingLogger });

    const response = await postRaw(harness, JSON.stringify({ model: 'claude-opus-4-5' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: expect.stringContaining('x-gateway-token') },
    });
  });
});

// ---------------------------------------------------------------------------
// No request leaves the gateway unaccounted for
// ---------------------------------------------------------------------------

describe('a request that fails in no anticipated way is still logged', () => {
  /**
   * Build a request whose body stream fails partway through the upload.
   * @param signal - Signal to attach, so the handler can tell a disconnect from
   *   an internal fault.
   * @returns A request the gateway cannot finish reading.
   */
  function requestWithFailingBody(signal: AbortSignal): Request {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"claude-opus-4-5",'));
        controller.error(new Error('socket hang up'));
      },
    });
    return new Request('http://localhost/gateway/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
      // @ts-expect-error — duplex is an undici-specific extension.
      duplex: 'half',
    });
  }

  it('logs a client disconnect when the upload fails and the client is gone', async () => {
    const harness = buildHarness();
    const clientAbort = new AbortController();
    const request = requestWithFailingBody(clientAbort.signal);
    clientAbort.abort();

    // Hono's own error boundary turns the rethrown transport error into a
    // 500. The gateway's job is to have said what happened before that.
    expect((await harness.app.fetch(request)).status).toBe(500);

    expect(harness.events).toHaveLength(0);
    expect(await soleLine(harness, 'warn')).toBe('POST /v1/messages rejected status=499 reason="client disconnected"');
  });

  it('logs an internal error, without the error message, when the client is still there', async () => {
    const harness = buildHarness();
    const request = requestWithFailingBody(new AbortController().signal);

    // Hono's own error boundary turns the rethrown transport error into a
    // 500. The gateway's job is to have said what happened before that.
    expect((await harness.app.fetch(request)).status).toBe(500);

    const line = await soleLine(harness, 'warn');
    expect(line).toBe('POST /v1/messages rejected status=500 reason="internal error"');
    // The underlying message could quote a fragment of the body it was reading.
    expect(line).not.toContain('socket hang up');
  });
});

// ---------------------------------------------------------------------------
// Credentials the router does not have yet
// ---------------------------------------------------------------------------

describe('a gateway without resolved credentials turns every request away', () => {
  /**
   * Mount a router whose credential resolution always fails.
   *
   * The failure's own message is deliberately distinctive: a rejection line must
   * report the fault, never the configuration detail behind it — that is written
   * once, at the coordinator-ready barrier.
   * @returns The mounted app and a live view over what it logged.
   */
  function buildUnavailable(): {
    readonly app: Hono;
    readonly captured: CapturingLogger;
    readonly events: RequestRoutedEvent[];
  } {
    const captured = createCapturingLogger();
    const events: RequestRoutedEvent[] = [];
    const app = new Hono();
    app.route(
      '/gateway',
      createGatewayRouter({
        ensureRuntime: () => Promise.reject(new Error('Credential for upstream "litellm" could not be resolved.')),
        emit: (event) => events.push(event),
        maxBodyBytes: 64 * 1024 * 1024,
        shutdownSignal: new AbortController().signal,
        logger: captured.logger,
      }),
    );
    return { app, captured, events };
  }

  it('writes one 503 rejection line naming the reason, not the configuration fault', async () => {
    const { app, captured, events } = buildUnavailable();

    const response = await app.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Gateway upstream credentials are not available yet.' },
    });
    // Nothing was routed, so nothing is published: a 503 is a rejection, not an
    // outcome of a routing decision.
    expect(events).toEqual([]);
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe('warn');
    expect(captured.lines[0]?.message).toBe(
      'POST /gateway/v1/messages rejected status=503 reason="credentials unavailable"',
    );
    // The configuration fault behind the failure belongs to the barrier's error
    // line; repeating it per request would bury it.
    expect(captured.text).not.toContain('litellm');
  });

  it('reports the full pathname, so an unknown path is turned away the same way', async () => {
    const { app, captured } = buildUnavailable();

    // The gate runs ahead of route matching: while the gateway cannot resolve
    // its credentials it is uniformly unavailable, and a caller learns nothing
    // about which paths exist from the difference.
    const response = await app.fetch(new Request('http://localhost/gateway/v1/nope', { method: 'GET' }));

    expect(response.status).toBe(503);
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.message).toBe(
      'GET /gateway/v1/nope rejected status=503 reason="credentials unavailable"',
    );
  });
});
