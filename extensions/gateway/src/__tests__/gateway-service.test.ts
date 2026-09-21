/**
 * Unit tests for {@link GatewayService} — covers lifecycle, the lazy credential
 * resolution seam, what an operator is told when a credential is unavailable,
 * and in-flight request cancellation on destroy.
 *
 * The contract under test is deliberately *not* "init fails on a bad
 * credential". Extension services start in discovery order, so a `stored:`
 * reference can be unresolvable at `init()` and resolvable a moment later; a
 * gateway that failed activation over that would stay dead for a configuration
 * that is entirely correct. These suites therefore assert the replacement:
 * activation always succeeds, requests are turned away with `503` until the
 * credentials exist, the coordinator-ready barrier reports the reason once, and
 * a later attempt heals the gateway without a restart.
 *
 * Uses a real bus instance and real {@link CredentialResolver} implementations
 * backed by in-process state, consistent with the repo policy of testing real
 * implementations rather than mocks of our own code. The upstreams are real
 * `node:http` servers, and the log sink is the real {@link GatewayLogger} seam.
 */

import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CredentialResolver } from '@makaio/contracts';
import type { CredentialRef } from '@makaio/contracts/config';
import { KernelSubjects } from '@makaio/kernel/namespace';
import { parseGatewayConfig, type GatewayConfig } from '../config.js';
import { GatewayService } from '../gateway-service.js';
import { createCapturingLogger, type CapturingLogger } from './helpers/capturing-logger.js';
import { startMockServer, type MockServer } from './helpers/mock-upstream.js';

// ---------------------------------------------------------------------------
// Test resolver implementations
// ---------------------------------------------------------------------------

/**
 * Real {@link CredentialResolver} implementation for tests.
 *
 * Resolves refs from an in-process map. An absent key returns `null` to
 * simulate an unavailable credential. Counts every `resolve` call so tests can
 * assert the resolver was (or was not) invoked.
 */
class MapCredentialResolver implements CredentialResolver {
  private readonly store: ReadonlyMap<string, string>;
  public callCount = 0;

  /**
   * @param entries - Map from credential ref string to plaintext value. Refs
   *   absent from the map resolve to `null`.
   */
  public constructor(entries: Record<string, string> = {}) {
    this.store = new Map(Object.entries(entries));
  }

  /**
   * Resolve a credential reference from the in-process store.
   * @param ref - Branded credential reference string.
   * @returns Plaintext value, or `null` when the ref is not in the store.
   */
  public resolve(ref: CredentialRef): Promise<string | null> {
    this.callCount += 1;
    return Promise.resolve(this.store.get(ref) ?? null);
  }
}

/**
 * Real {@link CredentialResolver} that is unavailable exactly once.
 *
 * Reproduces the host's startup race: the first lookup finds no credential
 * service registered and returns `null` — which is what `StoredCredentialProvider`
 * does, deliberately without caching the miss — and every later lookup succeeds.
 */
class LateCredentialResolver implements CredentialResolver {
  public callCount = 0;

  /**
   * @param value - Plaintext returned from the second call onwards.
   */
  public constructor(private readonly value: string) {}

  /**
   * Resolve a credential reference, reporting it unavailable the first time.
   * @param _ref - Branded credential reference string, ignored.
   * @returns `null` on the first call, the configured plaintext afterwards.
   */
  public resolve(_ref: CredentialRef): Promise<string | null> {
    this.callCount += 1;
    return Promise.resolve(this.callCount === 1 ? null : this.value);
  }
}

/**
 * Real {@link CredentialResolver} whose first lookup the test releases by hand.
 *
 * Models a credential lookup that is still in flight when the service is torn
 * down — the case where a late result must not be memoised into a gateway that
 * has already released its credentials. Later lookups resolve immediately.
 */
class GatedCredentialResolver implements CredentialResolver {
  public callCount = 0;
  /** Resolves once the first lookup has been entered. */
  public readonly entered: Promise<void>;
  private notifyEntered!: () => void;
  private releaseFirst!: (value: string | null) => void;

  /**
   * @param value - Plaintext every lookup ultimately resolves to.
   */
  public constructor(private readonly value: string) {
    this.entered = new Promise<void>((resolve) => {
      this.notifyEntered = resolve;
    });
  }

  /**
   * Resolve a credential reference, gating the first call on {@link release}.
   * @param _ref - Branded credential reference string, ignored.
   * @returns The configured plaintext, once the first call has been released.
   */
  public resolve(_ref: CredentialRef): Promise<string | null> {
    this.callCount += 1;
    if (this.callCount > 1) {
      return Promise.resolve(this.value);
    }
    const gated = new Promise<string | null>((resolve) => {
      this.releaseFirst = resolve;
    });
    this.notifyEntered();
    return gated;
  }

  /** Let the first lookup finish. */
  public release(): void {
    this.releaseFirst(this.value);
  }
}

// ---------------------------------------------------------------------------
// Minimal valid configs
// ---------------------------------------------------------------------------

/** Config with an Anthropic upstream and no rules — no credentials required. */
const ANTHROPIC_ONLY_CONFIG = parseGatewayConfig({
  upstreams: { anthropic: { kind: 'anthropic' } },
});

/** Config with a LiteLLM upstream requiring credential resolution. */
const LITELLM_CONFIG = parseGatewayConfig({
  upstreams: {
    litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:LITELLM_MASTER_KEY' },
  },
  default: 'litellm',
});

/** Body every request in these suites sends. */
const REQUEST_BODY = JSON.stringify({ model: 'claude-opus-4-5', messages: [] });

/**
 * Send a Messages request through a service's own router.
 * @param service - Service whose router should handle the request.
 * @returns The response the gateway produced.
 */
async function post(service: GatewayService): Promise<Response> {
  return service.router.fetch(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQUEST_BODY,
    }),
  );
}

describe('GatewayService', () => {
  let bus: IMakaioBus;
  /** Stands in for the runtime shutdown signal supplied by `ExtensionContext`. */
  let shutdown: AbortController;
  /** Real log sink; asserted on directly rather than spying on the console. */
  let captured: CapturingLogger;

  beforeEach(() => {
    bus = createBusInstance();
    shutdown = new AbortController();
    captured = createCapturingLogger();
  });

  afterEach(() => {
    // Release any listener the service attached to the shutdown signal.
    shutdown.abort();
  });

  /**
   * Send the coordinator-ready barrier the Node runtime broadcasts after
   * `coordinator.startAll()` and before `kernel.ready`.
   * @returns One result per handler that answered the barrier.
   */
  async function coordinatorReady(): Promise<readonly unknown[]> {
    return bus.broadcast(KernelSubjects.phase.coordinatorReady, { machineId: 'test-machine' });
  }

  /**
   * Build a service wired to the suite's bus, shutdown signal, and log sink.
   * @param config - Parsed gateway configuration.
   * @param resolver - Host-supplied resolver, or `undefined` for a host without one.
   * @returns The constructed, not yet initialised service.
   */
  function buildService(config: GatewayConfig, resolver?: CredentialResolver): GatewayService {
    return new GatewayService(bus, config, shutdown.signal, resolver, captured.logger);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle invariants
  // ---------------------------------------------------------------------------

  it('router throws before init() completes', () => {
    const service = buildService(ANTHROPIC_ONLY_CONFIG);
    expect(() => service.router).toThrow('not available until init()');
  });

  it('router is accessible after successful init()', async () => {
    const service = buildService(ANTHROPIC_ONLY_CONFIG);
    await service.init();

    const router = service.router;
    expect(router).toBeDefined();
    expect(typeof router.fetch).toBe('function');

    await service.destroy();
  });

  it('router is unavailable after destroy()', async () => {
    const service = buildService(ANTHROPIC_ONLY_CONFIG);
    await service.init();
    expect(service.router).toBeDefined();

    await service.destroy();
    expect(() => service.router).toThrow('not available until init()');
  });

  // ---------------------------------------------------------------------------
  // init() reads no credential
  // ---------------------------------------------------------------------------

  it('init() resolves no credential, so an unresolvable one cannot fail activation', async () => {
    // Nothing in the store: under the previous eager contract this init() threw
    // and the extension was left permanently failed.
    const resolver = new MapCredentialResolver({});
    const service = buildService(LITELLM_CONFIG, resolver);

    await expect(service.init()).resolves.toBeUndefined();
    expect(resolver.callCount).toBe(0);
    expect(service.router).toBeDefined();
    expect(captured.lines).toEqual([]);

    await service.destroy();
  });

  it('init() succeeds without a resolver even when the config needs secrets', async () => {
    const service = buildService(LITELLM_CONFIG);

    await expect(service.init()).resolves.toBeUndefined();
    expect(service.router).toBeDefined();

    await service.destroy();
  });

  // ---------------------------------------------------------------------------
  // The coordinator-ready barrier resolves the credentials
  // ---------------------------------------------------------------------------

  it('resolves the litellm master key at the barrier and says nothing when it succeeds', async () => {
    const resolver = new MapCredentialResolver({ 'env:LITELLM_MASTER_KEY': 'resolved-master-key' });
    const service = buildService(LITELLM_CONFIG, resolver);
    await service.init();

    await coordinatorReady();

    expect(resolver.callCount).toBe(1);
    expect(captured.lines).toEqual([]);

    await service.destroy();
  });

  it('resolves secrets for anthropic-with-auth and litellm upstreams in one pass', async () => {
    const resolver = new MapCredentialResolver({
      'env:LITELLM_KEY': 'key1',
      'env:LITELLM_KEY_2': 'key2',
      'env:ANTHROPIC_KEY': 'ak1',
    });

    // All four upstreams are referenced: litellm1, litellm2, and anthropic-work
    // via rules; anthropic as the default. Three of them need credentials so the
    // resolver is called exactly three times.
    const config = parseGatewayConfig({
      upstreams: {
        litellm1: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:LITELLM_KEY' },
        litellm2: { kind: 'litellm', url: 'http://127.0.0.1:4001', masterKey: 'env:LITELLM_KEY_2' },
        'anthropic-work': { kind: 'anthropic', auth: { apiKey: 'env:ANTHROPIC_KEY' } },
        anthropic: { kind: 'anthropic' },
      },
      rules: [
        { match: 'deepseek-*', to: 'litellm1' },
        { match: 'gpt-*', to: 'litellm2' },
        { match: 'claude-work-*', to: 'anthropic-work' },
        { match: 'claude-*', to: 'anthropic' },
      ],
    });

    const service = buildService(config, resolver);
    await service.init();
    await coordinatorReady();

    // Three referenced upstreams needed secrets; resolver called three times.
    expect(resolver.callCount).toBe(3);
    expect(captured.lines).toEqual([]);

    await service.destroy();
  });

  it('does not resolve credentials for unreferenced upstreams', async () => {
    // 'unreferenced' is present in upstreams but named by neither default nor
    // any rule's to list. Its secret ('env:UNREACHABLE_KEY') is absent from the
    // resolver store — if it were resolved, the barrier would report a failure.
    // A silent barrier proves the unreferenced upstream was skipped.
    const resolver = new MapCredentialResolver({ 'env:LITELLM_MASTER_KEY': 'resolved-key' });
    const config = parseGatewayConfig({
      upstreams: {
        litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:LITELLM_MASTER_KEY' },
        unreferenced: { kind: 'litellm', url: 'http://127.0.0.1:4001', masterKey: 'env:UNREACHABLE_KEY' },
      },
      default: 'litellm',
      rules: [],
    });
    const service = buildService(config, resolver);
    await service.init();

    await coordinatorReady();

    expect(resolver.callCount).toBe(1);
    expect(captured.lines).toEqual([]);

    await service.destroy();
  });

  it('never calls the resolver when no upstream needs a secret', async () => {
    const resolver = new MapCredentialResolver();
    const config = parseGatewayConfig({
      upstreams: { anthropic: { kind: 'anthropic' } },
      rules: [{ match: 'claude-*', to: 'anthropic' }],
    });
    const service = buildService(config, resolver);
    await service.init();

    await coordinatorReady();

    expect(resolver.callCount).toBe(0);
    expect(captured.lines).toEqual([]);

    await service.destroy();
  });

  // ---------------------------------------------------------------------------
  // What the barrier reports when a credential is unavailable
  // ---------------------------------------------------------------------------

  it('reports exactly one error line naming the ref and the upstream', async () => {
    const resolver = new MapCredentialResolver({}); // 'env:LITELLM_MASTER_KEY' absent → null
    const service = buildService(LITELLM_CONFIG, resolver);
    await service.init();

    // The barrier must not fail: a rejecting handler would take the host's
    // startup down with it over a fault a later request may well resolve. The
    // gateway answers it like any other participant.
    await expect(coordinatorReady()).resolves.toHaveLength(1);

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe('error');
    expect(captured.lines[0]?.message).toContain('credentials unavailable');
    expect(captured.lines[0]?.message).toContain('env:LITELLM_MASTER_KEY');
    expect(captured.lines[0]?.message).toContain('upstream \\"litellm\\"');

    await service.destroy();
  });

  it('names only the failing ref, never a credential resolved earlier in the same pass', async () => {
    // Two referenced upstreams. The first ('litellm-ok') resolves to SENTINEL,
    // which is therefore live in the resolved-secret map when the second
    // ('litellm-failing') resolves to null and aborts the pass. The sentinel
    // must not reach the operator's console.
    const SENTINEL = 'SECRET-SENTINEL-123';
    const resolver = new MapCredentialResolver({
      'env:LITELLM_SENTINEL_KEY': SENTINEL,
      // 'env:MY_SECRET_KEY' absent → null
    });
    const config = parseGatewayConfig({
      upstreams: {
        'litellm-ok': { kind: 'litellm', url: 'http://127.0.0.1:4001', masterKey: 'env:LITELLM_SENTINEL_KEY' },
        'litellm-failing': { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:MY_SECRET_KEY' },
      },
      default: 'litellm-ok',
      rules: [{ match: 'failing-model', to: 'litellm-failing' }],
    });
    const service = buildService(config, resolver);
    await service.init();

    await coordinatorReady();

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe('error');
    expect(captured.text).toContain('env:MY_SECRET_KEY');
    expect(captured.text).toContain('litellm-failing');
    expect(captured.text).not.toContain(SENTINEL);
    // Both upstreams were resolved, so the sentinel really was in hand when the
    // line was written — the assertion above is not vacuous.
    expect(resolver.callCount).toBe(2);

    await service.destroy();
  });

  it('reports a host without credential resolution once, instead of failing activation', async () => {
    const service = buildService(LITELLM_CONFIG);
    await service.init();

    await coordinatorReady();

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe('error');
    expect(captured.lines[0]?.message).toMatch(/host does not provide credential resolution/i);

    await service.destroy();
  });

  // ---------------------------------------------------------------------------
  // Gateway access token
  // ---------------------------------------------------------------------------

  /**
   * Build a config whose only upstream needs no secret, so the access token is
   * the sole credential in play.
   * @param accessToken - Credential reference for the gateway access token.
   * @returns Parsed gateway config.
   */
  function accessTokenConfig(accessToken: string) {
    return parseGatewayConfig({ upstreams: { anthropic: { kind: 'anthropic' } }, accessToken });
  }

  it('resolves the access token even when no upstream requires a secret', async () => {
    const resolver = new MapCredentialResolver({ 'env:GATEWAY_TOKEN': 'resolved-token' });
    const service = buildService(accessTokenConfig('env:GATEWAY_TOKEN'), resolver);
    await service.init();

    await coordinatorReady();

    // The referenced-upstream pruning does not apply to the access token.
    expect(resolver.callCount).toBe(1);
    expect(captured.lines).toEqual([]);

    await service.destroy();
  });

  it('refuses every request rather than serving unauthenticated when the token is unresolvable', async () => {
    const service = buildService(accessTokenConfig('env:MISSING_TOKEN'), new MapCredentialResolver({}));
    await service.init();
    await coordinatorReady();

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe('error');
    expect(captured.lines[0]?.message).toContain('gateway \\"accessToken\\"');
    expect(captured.lines[0]?.message).toContain('env:MISSING_TOKEN');

    // Failing closed matters here: an unauthenticated proxy is worse than one
    // that refuses to answer.
    const response = await post(service);
    expect(response.status).toBe(503);

    await service.destroy();
  });

  it('access token failure names the ref without leaking a plaintext resolved earlier', async () => {
    // Upstream secrets resolve before the access token, so by the time the
    // token fails the resolver has already returned SENTINEL and the plaintext
    // is live in the resolved-secret map.
    const SENTINEL = 'SECRET-SENTINEL-456';
    const resolver = new MapCredentialResolver({
      'env:LITELLM_MASTER_KEY': SENTINEL,
      // 'env:MISSING_TOKEN' absent → null → the access token resolution throws.
    });
    const config = parseGatewayConfig({
      upstreams: {
        litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:LITELLM_MASTER_KEY' },
      },
      default: 'litellm',
      accessToken: 'env:MISSING_TOKEN',
    });
    const service = buildService(config, resolver);
    await service.init();

    await coordinatorReady();

    expect(captured.lines).toHaveLength(1);
    expect(captured.text).toContain('gateway \\"accessToken\\"');
    expect(captured.text).toContain('env:MISSING_TOKEN');
    expect(captured.text).not.toContain(SENTINEL);
    // Both credentials were requested, so the sentinel really was in hand.
    expect(resolver.callCount).toBe(2);

    await service.destroy();
  });
});

// ---------------------------------------------------------------------------
// Self-healing request path
// ---------------------------------------------------------------------------

describe('GatewayService — requests while the credentials are unavailable', () => {
  let bus: IMakaioBus;
  let shutdown: AbortController;
  let captured: CapturingLogger;
  let upstream: MockServer;

  beforeEach(async () => {
    bus = createBusInstance();
    shutdown = new AbortController();
    captured = createCapturingLogger();
    upstream = await startMockServer(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', id: 'ok' }),
    }));
  });

  afterEach(async () => {
    shutdown.abort();
    await upstream.close();
  });

  /**
   * Config whose only upstream is the mock, behind an API-key credential.
   * @returns Parsed gateway config pointing at the running mock upstream.
   */
  function mockUpstreamConfig() {
    return parseGatewayConfig({
      upstreams: {
        anthropic: {
          kind: 'anthropic',
          url: `http://127.0.0.1:${upstream.port}`,
          auth: { apiKey: 'env:ANTHROPIC_KEY' },
        },
      },
    });
  }

  it('answers 503 with an Anthropic-shaped body and heals on the next request', async () => {
    const resolver = new LateCredentialResolver('resolved-api-key');
    const service = new GatewayService(bus, mockUpstreamConfig(), shutdown.signal, resolver, captured.logger);
    await service.init();

    const refused = await post(service);

    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Gateway upstream credentials are not available yet.' },
    });
    // Exactly one line, and a rejection rather than a routed request: nothing
    // was routed, so there is nothing to report as routed.
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe('warn');
    expect(captured.lines[0]?.message).toBe('POST /v1/messages rejected status=503 reason="credentials unavailable"');

    // The failed attempt was discarded rather than memoised, so the next
    // request resolves again — and this time the credential is there.
    const routed = await post(service);

    expect(routed.status).toBe(200);
    expect(resolver.callCount).toBe(2);
    expect(upstream.lastRequest?.headers['x-api-key']).toBe('resolved-api-key');

    await service.destroy();
  });

  it('serves later requests from the memo once the credentials resolved', async () => {
    const resolver = new LateCredentialResolver('resolved-api-key');
    const service = new GatewayService(bus, mockUpstreamConfig(), shutdown.signal, resolver, captured.logger);
    await service.init();

    // First attempt fails and is discarded; the barrier retries and succeeds.
    await bus.broadcast(KernelSubjects.phase.coordinatorReady, { machineId: 'test-machine' });
    await bus.broadcast(KernelSubjects.phase.coordinatorReady, { machineId: 'test-machine' });

    const first = await post(service);
    const second = await post(service);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Two barrier passes plus two requests, but only the two barrier passes
    // reached the resolver: a success is memoised for every later caller.
    expect(resolver.callCount).toBe(2);
    expect(captured.lines.filter((line) => line.message.includes('status=503'))).toEqual([]);

    await service.destroy();
  });

  it('discards a credential resolution that completes after destroy()', async () => {
    const resolver = new GatedCredentialResolver('resolved-api-key');
    const config = mockUpstreamConfig();
    const service = new GatewayService(bus, config, shutdown.signal, resolver, captured.logger);
    await service.init();

    // Start a request; its resolution blocks inside the resolver.
    const pending = post(service);
    await resolver.entered;

    await service.destroy();
    resolver.release();

    // The request is answered rather than left hanging or thrown out of Hono.
    const refused = await pending;
    expect(refused.status).toBe(503);
    expect(() => service.router).toThrow('not available until init()');

    // The credentials resolved fine; the gateway simply stopped existing. An
    // operator must not be sent chasing a configuration fault that never was.
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.message).toBe('POST /v1/messages rejected status=503 reason="gateway shutting down"');
    expect(captured.text).not.toContain('credentials unavailable');

    // Nothing was memoised: a second lifecycle resolves from scratch.
    await service.init();
    const routed = await post(service);

    expect(routed.status).toBe(200);
    expect(resolver.callCount).toBe(2);

    await service.destroy();
  });
});

// ---------------------------------------------------------------------------
// destroy() aborts in-flight upstream requests
// ---------------------------------------------------------------------------

describe('GatewayService — destroy() aborts in-flight upstream requests', () => {
  let bus: IMakaioBus;
  let shutdown: AbortController;
  /** HTTP server started per-test; closed in afterEach to prevent port leaks. */
  let hangingServer: HttpServer | null = null;

  beforeEach(() => {
    bus = createBusInstance();
    shutdown = new AbortController();
  });

  afterEach(async () => {
    shutdown.abort();
    if (hangingServer) {
      const s = hangingServer;
      hangingServer = null;
      s.closeAllConnections();
      await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
    }
  });

  /**
   * Start a `node:http` server on a random loopback port that accepts incoming
   * connections but never sends any response, and resolves a promise when the
   * first request arrives so the caller can synchronise on the upstream fetch
   * being in-flight before calling destroy().
   * @returns Port and a promise that resolves on the first incoming request.
   */
  async function startHangingServer(): Promise<{ port: number; firstRequest: Promise<void> }> {
    let notifyFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      notifyFirstRequest = resolve;
    });

    const server = createServer((_req, _res) => {
      // Deliberately never call _res.end() — keeps the upstream socket open.
      notifyFirstRequest();
    });
    hangingServer = server;

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    return { port, firstRequest };
  }

  it('returns a 499 response for an in-flight request when destroy() is called', async () => {
    const { port, firstRequest } = await startHangingServer();

    const config = parseGatewayConfig({
      upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${port}` } },
    });
    const service = new GatewayService(bus, config, shutdown.signal);
    await service.init();

    // Start a request through the real router — do not await yet.
    const inFlight = service.router.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: REQUEST_BODY,
      }),
    );

    // Wait for the upstream to receive the request so the fetch is in-flight.
    await firstRequest;

    // Destroy the service while the upstream fetch is still pending.
    await service.destroy();

    // The router catches the abort and returns a 499 (client/proxy gave up).
    const response = await inFlight;
    expect(response.status).toBe(499);
  });

  it('does not abort the host signal when destroy() is called', async () => {
    const service = new GatewayService(bus, ANTHROPIC_ONLY_CONFIG, shutdown.signal);
    await service.init();
    await service.destroy();

    expect(shutdown.signal.aborted).toBe(false);
  });
});
