/**
 * Hono sub-application that implements the gateway routing logic.
 *
 * Exposes two POST endpoints matching the Anthropic Messages API:
 * `/v1/messages` and `/v1/messages/count_tokens`. All other paths return 404.
 *
 * One gate middleware runs ahead of both endpoints and the catch-all. It
 * resolves the credential-dependent runtime and, when an access token is
 * configured, authenticates the caller. An unauthenticated caller therefore
 * learns nothing about which paths exist, and while the credentials cannot be
 * resolved every path under the mount answers `503` alike — the only thing any
 * caller learns is that the gateway is not ready.
 *
 * **Readiness:** the routing table and the access token are both derived from
 * credentials the host resolves, and the host binds its HTTP listener before
 * every service that can resolve them has started. The router therefore never
 * holds a pre-resolved table; it holds `ensureRuntime`, a memo that resolves on
 * first use and retries after a failure. A request that arrives before the
 * credentials exist is turned away with `503` rather than failing activation,
 * so the gateway heals itself as soon as they do.
 *
 * Per-request flow:
 * 0. Resolve the credential-dependent runtime, then authenticate against the
 *    configured access token when one is set.
 * 1. Read body bytes once, bounded by `maxBodyBytes` (so the same buffer is
 *    either forwarded verbatim or handed to the LiteLLM body-preparation
 *    layer).
 * 2. Parse the body to extract `model`; reject with 400 on invalid JSON or a
 *    missing model string.
 * 3. Walk the compiled rule table; the first match wins. No match defaults to
 *    the configured default upstream.
 * 4. Forward: Anthropic branch sends the original bytes and client headers
 *    (or replaces auth headers when `auth.apiKey` is configured); LiteLLM
 *    branch mutates auth headers and the body per the rule.
 * 5. Stream the upstream response back to the client unchanged.
 * 6. Emit exactly one `requestRouted` bus event per *routed* request, and write
 *    exactly one operator log line derived from that same event. A 503
 *    (credentials unavailable), 401 (bad access token), 413 (oversized body),
 *    400 (invalid body), or 404 (unknown route) is returned before a routing
 *    decision exists, so it emits no event
 *    — but it still writes one log line, because "nothing arrived" and
 *    "everything was rejected" must not look identical in the server output.
 *    When the upstream reports an error, the routed line is held back until a
 *    bounded read of the upstream error body finishes; the bus event is still
 *    emitted at response-header time, and the client response is never delayed
 *    by that read. A request that fails in no anticipated way — a client that
 *    vanishes mid-upload, a bug in routing — is logged by `routeRequest` before
 *    the error is rethrown, so no request can leave the gateway unaccounted for.
 *
 * `durationMs` is measured from when the request body is fully read into memory
 * to when the upstream response headers arrive (i.e. when `forwardRequest`
 * resolves), on the monotonic clock. This captures routing-decision time and
 * upstream time-to-first-byte but excludes request-body upload latency and
 * response-body streaming time.
 *
 * **Abort semantics:** The `aborted` outcome covers only pre-header aborts —
 * cases where the client signal fires before `forwardRequest` returns. If the
 * client disconnects mid-stream (after the upstream response headers have
 * arrived), `forwardRequest` has already resolved with a `completed` outcome
 * and the body stream error is handled at the transport layer. The abort link
 * (composed client + shutdown signal) is kept alive until the response body
 * settles so that a runtime shutdown fired after headers arrive still cancels
 * the in-flight upstream body stream and closes the upstream TCP connection.
 * @packageDocumentation
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { CompiledRules } from './routing/match.js';
import { decideRoute } from './routing/match.js';
import {
  InvalidMessagesBodyError,
  parseMessagesBody,
  prepareLitellmBody,
  prepareLitellmHeaders,
} from './routing/litellm-body.js';
import { prepareAnthropicApiKeyHeaders } from './routing/anthropic-headers.js';
import { filterRequestHeaders, GATEWAY_ACCESS_TOKEN_HEADER } from './proxy/headers.js';
import { linkAbortSignals } from './proxy/abort-link.js';
import { ContentLengthMismatchError, readBodyWithLimit, RequestBodyTooLargeError } from './proxy/request-body.js';
import {
  forwardRequest,
  toClientResponse,
  UpstreamAbortedError,
  UpstreamUnreachableError,
  type ForwardRequestOptions,
} from './proxy/forward.js';
import {
  CREDENTIALS_UNAVAILABLE_REASON,
  logRejection,
  logRoutedRequest,
  resolveGatewayLogger,
  type GatewayLogger,
} from './logging.js';
import { readUpstreamErrorSummary, type UpstreamErrorSummary } from './proxy/upstream-error.js';
import type { AnthropicRouteDecision, LitellmRouteDecision, RouteDecision } from './routing/types.js';
import type { RequestRoutedEvent, RequestOutcome } from './contracts/schemas.js';

/** The two paths that the gateway routes — both Anthropic Messages endpoints. */
type RoutedPath = '/v1/messages' | '/v1/messages/count_tokens';

/**
 * Narrow a {@link RouteDecision} to {@link AnthropicRouteDecision}.
 *
 * Required because TypeScript does not automatically narrow discriminated
 * unions on nested properties (`decision.target.kind`). The type guard
 * makes the branch explicit and preserves the full decision type in each arm.
 * @param decision - Routing decision to test.
 * @returns `true` when the decision targets the Anthropic upstream.
 */
function isAnthropicDecision(decision: RouteDecision): decision is AnthropicRouteDecision {
  return decision.target.kind === 'anthropic';
}

/**
 * Everything a request needs that can only be known once credentials resolve.
 *
 * Produced as one unit because the routing table and the access token are
 * resolved through the same host seam and fail for the same reasons: a gateway
 * that could compile its table but not resolve its own token must not serve
 * traffic unauthenticated, and one that resolved its token but not an upstream
 * key has nowhere to forward to.
 *
 * **Security:** every plaintext credential the gateway holds lives here, inside
 * the compiled route targets and in {@link GatewayRuntime.accessToken}. Nothing
 * on this object is ever logged, emitted on the bus, or written to disk.
 */
export interface GatewayRuntime {
  /** Routing table with every referenced upstream credential already resolved. */
  readonly compiled: CompiledRules;
  /**
   * Resolved gateway access token, or `null` when the gateway performs no
   * authentication of its own.
   *
   * When non-null, every request under the mounted prefix must present it in
   * the `x-gateway-token` header. The value is resolved plaintext and must
   * never be logged.
   */
  readonly accessToken: string | null;
}

/**
 * Options for {@link createGatewayRouter}.
 */
export interface GatewayRouterOptions {
  /**
   * Resolve the credential-dependent runtime for this gateway.
   *
   * Called on every request rather than once at construction, because the host
   * accepts connections before the services that resolve `stored:` references
   * have started. Implementations are expected to memoise a success and to
   * discard a failure, so a gateway that could not resolve its credentials the
   * first time recovers without a restart.
   *
   * A rejection is turned into a `503` for the request that observed it; the
   * reason is reported once, at the coordinator-ready barrier, not per request.
   * @returns The resolved runtime, rejecting while it is unavailable.
   */
  readonly ensureRuntime: () => Promise<GatewayRuntime>;
  /**
   * Event emitter called exactly once per routed request after the upstream
   * responds or the connection fails. 503 (credentials unavailable), 401
   * (access token), 413 (body limit), and 400 (invalid body) rejections happen
   * before routing and emit nothing.
   * Treated as fire-and-forget — errors are not propagated to the request
   * handler.
   * @param event - Routing telemetry for the completed request.
   */
  readonly emit: (event: RequestRoutedEvent) => void;
  /**
   * Maximum number of request body bytes to buffer before rejecting with 413.
   */
  readonly maxBodyBytes: number;
  /**
   * Signal marking the end of this router's life.
   *
   * Aborted when the gateway stops serving — the host shutting down, or this
   * extension alone being disabled — and linked per request with the client's
   * own signal, so either cancels upstream requests that have not yet returned
   * response headers.
   *
   * Because it covers the router's own teardown rather than only the host's, it
   * is also the discriminator that tells a torn-down gateway apart from a
   * missing credential when `ensureRuntime` rejects — see
   * {@link requireRuntime}.
   */
  readonly shutdownSignal: AbortSignal;
  /**
   * Sink for the per-request operator log lines.
   *
   * Defaults to `consoleGatewayLogger`, which is what an operator running the
   * server in a terminal needs. Supply an implementation to route the lines
   * elsewhere, or to assert on them in a test.
   */
  readonly logger?: GatewayLogger;
}

/**
 * {@link GatewayRouterOptions} with the optional logger resolved.
 *
 * Resolved once in {@link createGatewayRouter} and threaded through the request
 * path, so no handler has to repeat the default.
 */
interface ResolvedRouterOptions extends GatewayRouterOptions {
  /** Resolved log sink — the caller's, or the console default. */
  readonly logger: GatewayLogger;
}

/**
 * The terminal state of a routed request, as observed by a forwarding branch.
 */
interface RoutedOutcome {
  /** How the request finished. */
  readonly outcome: RequestOutcome;
  /** Upstream HTTP status, or `null` when none was received. */
  readonly status: number | null;
  /**
   * In-flight summary of the upstream error body, when the upstream reported
   * an error.
   *
   * A promise rather than a value because the read must not sit on the response
   * path: the caller starts it and returns the client response immediately, and
   * the emitter holds the log line until it settles. The bus event is published
   * without waiting, so `durationMs` still measures time-to-response-headers.
   */
  readonly upstreamError?: Promise<UpstreamErrorSummary | undefined>;
}

/**
 * Reports the terminal state of a routed request.
 *
 * Produced by {@link buildEmitter} and called exactly once per routed request:
 * it publishes the `requestRouted` event and writes exactly one matching log
 * line — immediately, or once `upstreamError` settles.
 * @param outcome - Everything observed about how the request finished.
 */
type OutcomeEmitter = (outcome: RoutedOutcome) => void;

/**
 * Per-request context shared by both forwarding branches.
 *
 * Bundled rather than threaded as positional parameters because every field is
 * derived once per request and consumed unchanged by whichever branch runs.
 */
interface ForwardContext {
  /** Raw headers of the incoming client request, before any filtering. */
  readonly clientHeaders: Headers;
  /** Routed endpoint path used for upstream URL construction. */
  readonly path: RoutedPath;
  /** Query string from the original request URL, e.g. `?beta=true`. */
  readonly search: string;
  /** Composed abort signal covering client disconnect and runtime shutdown. */
  readonly signal: AbortSignal;
  /**
   * Lifetime of the upstream error-body read, owned by
   * {@link forwardRoutedRequest}.
   *
   * Separate from {@link ForwardContext.signal} because that one stops being
   * able to fire once the request's abort link is released, which happens as
   * soon as the *client's* copy of the body settles — potentially while the
   * error-body read is still waiting on a source that is very much alive.
   */
  readonly excerptSignal: AbortSignal;
  /** Bound outcome emitter produced by {@link buildEmitter}. */
  readonly emitWith: OutcomeEmitter;
}

/**
 * Serialise an Anthropic-shaped JSON error body.
 * @param errorType - The Anthropic error type string.
 * @param message - Human-readable error description.
 * @returns JSON string matching the Anthropic error envelope format.
 */
function anthropicErrorBody(errorType: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type: errorType, message } });
}

/**
 * Build an error response carrying an Anthropic-shaped JSON body.
 * @param status - HTTP status code to return.
 * @param errorType - The Anthropic error type string.
 * @param message - Human-readable error description.
 * @returns Response with the Anthropic error envelope as its body.
 */
function anthropicErrorResponse(status: number, errorType: string, message: string): Response {
  return new Response(anthropicErrorBody(errorType, message), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a 502 response for an upstream-unreachable failure.
 * @returns Response with Anthropic-shaped error body.
 */
function upstreamUnreachableResponse(): Response {
  return anthropicErrorResponse(502, 'api_error', 'Upstream could not be reached.');
}

/**
 * Build a 503 response for a gateway whose credentials are not resolved yet.
 *
 * `503` rather than `500`: nothing about the request is wrong and nothing about
 * the gateway is broken — the credentials it forwards with are not available
 * *yet*, and the next request may well succeed. The message says so, because a
 * client author reading it needs to know that retrying is the right response.
 * @returns Response with Anthropic-shaped error body.
 */
function credentialsUnavailableResponse(): Response {
  return anthropicErrorResponse(503, 'api_error', 'Gateway upstream credentials are not available yet.');
}

/**
 * Either the resolved runtime, or the rejection to return in its place.
 *
 * Discriminated on the presence of `rejection`, so a caller cannot reach for
 * the runtime without having handled the case where there is none.
 */
type RuntimeResult = { readonly rejection: Response } | { readonly runtime: GatewayRuntime };

/**
 * Resolve the credential-dependent runtime, or turn the request away with 503.
 *
 * The single place a failed credential resolution becomes a client response, so
 * the status, the body, and the log line cannot drift apart. The failure's own
 * message is deliberately not reported here: it names a configuration site and
 * is written once, at the coordinator-ready barrier, rather than repeated on
 * every request that trips over the same fault.
 *
 * A resolution can also fail because the gateway was torn down, which is not a
 * configuration fault at all. The router can tell the two apart without reading
 * the error: `shutdownSignal` *is* the service-owned controller's signal, so an
 * aborted one means teardown. Reporting "credentials unavailable" then would
 * send an operator chasing a problem that does not exist. The client-facing
 * body stays the same either way — both cases mean "not ready, retry" — so no
 * client behaviour depends on the distinction.
 * @param options - Resolved router options supplying the memo, the shutdown
 *   signal, and the log sink.
 * @param method - HTTP method of the client request.
 * @param path - Path the rejection applies to. Called only when a rejection
 *   line is written, so a request that passes never pays to compute it.
 * @returns The resolved runtime, or the 503 to return instead.
 */
async function requireRuntime(
  options: ResolvedRouterOptions,
  method: string,
  path: () => string,
): Promise<RuntimeResult> {
  try {
    return { runtime: await options.ensureRuntime() };
  } catch {
    const reason = options.shutdownSignal.aborted ? 'gateway shutting down' : CREDENTIALS_UNAVAILABLE_REASON;
    logRejection(options.logger, { method, path: path(), status: 503, reason });
    return { rejection: credentialsUnavailableResponse() };
  }
}

/**
 * Compute the SHA-256 digest of a UTF-8 string.
 *
 * Used to produce a fixed-length representation for constant-time comparison
 * so that the lengths of the original values are not revealed through timing.
 * @param value - String to hash.
 * @returns 32-byte SHA-256 digest buffer.
 */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Compare two secrets without leaking their contents or lengths through timing.
 *
 * Both values are hashed with SHA-256 before comparison so that
 * `timingSafeEqual` always receives fixed-length (32-byte) buffers. A
 * length-based early return on the raw bytes would reveal the expected token's
 * length to an attacker who can time many requests. Hashing eliminates that
 * side-channel: inputs of any length produce equal-length digests, and the
 * SHA-256 preimage resistance ensures the digest comparison does not leak the
 * plaintext.
 * @param provided - Value supplied by the caller.
 * @param expected - Resolved gateway access token.
 * @returns `true` when the two values are byte-identical.
 */
function constantTimeEquals(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/**
 * Build the gate middleware every request under the mount passes through.
 *
 * Two jobs, in one place because the second depends on the first: resolve the
 * credential-dependent runtime, then authenticate the caller against the access
 * token that runtime carries. The gateway cannot check a token it has not
 * resolved, so a request that arrives before the credentials exist is answered
 * with `503` — it is never let through unauthenticated, and never told whether
 * its token would have been accepted.
 *
 * Applied to the whole sub-app, including the 404 catch-all, so an
 * unauthenticated caller cannot probe which paths exist. A rejected request
 * never reaches a routing decision and therefore emits no `requestRouted`
 * event; it is logged instead, distinguishing an absent token header from a
 * wrong one so an operator can tell "Claude Code was never configured with a
 * token" apart from "it is configured with the wrong one". Neither the supplied
 * value nor the expected one is ever logged. The token header itself is
 * stripped from every upstream request by `filterRequestHeaders`, so it never
 * leaves the gateway.
 *
 * The logged path is the full request pathname rather than a routed endpoint,
 * because the gate runs ahead of route matching and fires on unknown paths too.
 * @param options - Resolved router options supplying the runtime memo and the
 *   log sink.
 * @returns Hono middleware that short-circuits with 503 or 401.
 */
function createGate(options: ResolvedRouterOptions): MiddlewareHandler {
  return async (c, next) => {
    // Parsing the URL costs more than the checks below and is needed only to
    // name a path in a rejection line, so it is deferred into the two branches
    // that write one. The request that passes the gate never pays for it.
    const rejectedPath = (): string => new URL(c.req.url).pathname;

    const loaded = await requireRuntime(options, c.req.method, rejectedPath);
    if ('rejection' in loaded) return loaded.rejection;

    const { accessToken } = loaded.runtime;
    if (accessToken !== null) {
      const provided = c.req.header(GATEWAY_ACCESS_TOKEN_HEADER);
      const reason =
        provided === undefined
          ? 'access token missing'
          : constantTimeEquals(provided, accessToken)
            ? null
            : 'access token invalid';
      if (reason !== null) {
        logRejection(options.logger, { method: c.req.method, path: rejectedPath(), status: 401, reason });
        return anthropicErrorResponse(
          401,
          'authentication_error',
          `Missing or invalid ${GATEWAY_ACCESS_TOKEN_HEADER} header.`,
        );
      }
    }

    await next();
    return undefined;
  };
}

/**
 * Execute a forward request and translate typed errors to gateway responses.
 *
 * Shared by both the Anthropic and LiteLLM forwarding branches. Body and
 * header preparation stay in the callers; this function owns only the
 * transport leg and the error→outcome→response mapping.
 *
 * When the upstream reports an error, a bounded read of its body is *started*
 * on a clone and handed to the emitter as a promise — an operator otherwise sees
 * a bare `status=400` and has no way to learn that the upstream said "model not
 * found". The read is never awaited here: the clone tees the stream, so the
 * client gets the original unbuffered body immediately, and an upstream that
 * trickles its error body delays only the log line.
 * @param options - Fully-populated forward request options.
 * @param emitWith - Bound outcome emitter from the calling branch.
 * @param excerptSignal - Lifetime of the upstream error-body read.
 * @returns The upstream response (or a synthesised error response).
 */
async function executeForwardRequest(
  options: ForwardRequestOptions,
  emitWith: OutcomeEmitter,
  excerptSignal: AbortSignal,
): Promise<Response> {
  try {
    const upstream = await forwardRequest(options);
    // Started before toClientResponse: the clone must be taken while the
    // upstream body is still unconsumed, and the client's branch is read from
    // `upstream` afterwards. Bounded by the excerpt lifetime, which outlives the
    // abort link but not the request.
    const upstreamError = upstream.status >= 400 ? readUpstreamErrorSummary(upstream, excerptSignal) : undefined;
    emitWith({ outcome: 'completed', status: upstream.status, upstreamError });
    return toClientResponse(upstream);
  } catch (err) {
    if (err instanceof UpstreamAbortedError) {
      emitWith({ outcome: 'aborted', status: null });
      // 499 is a non-standard status (Nginx convention) for "the request was
      // abandoned before the server could respond". It covers both sources of
      // the composed abort signal: the client disconnecting, and the runtime
      // shutting down while the upstream had not yet returned headers.
      return new Response(null, { status: 499 });
    }
    if (err instanceof UpstreamUnreachableError) {
      emitWith({ outcome: 'upstream-unreachable', status: null });
      return upstreamUnreachableResponse();
    }
    throw err;
  }
}

/**
 * Construct the fully-qualified upstream URL for the forwarded request.
 *
 * Appends `path` to the upstream base URL and preserves the original query
 * string (e.g. `?beta=true` from Claude Code).
 * @param url - Upstream base URL without trailing slash.
 * @param path - Routed endpoint path, e.g. `/v1/messages`.
 * @param search - Query string from the original request URL, e.g. `?beta=true`.
 * @returns Fully-qualified upstream URL including path and query string.
 */
function buildUpstreamUrl(url: string, path: RoutedPath, search: string): string {
  // Strip trailing slashes from the configured upstream URL so that
  // `http://host/` and `http://host` both produce `http://host/v1/messages`.
  return `${url.replace(/\/+$/, '')}${path}${search}`;
}

/**
 * Emit a routing event, suppressing any uncaught error from the emitter.
 *
 * The event is observability telemetry; an emitter failure must not prevent the
 * response from reaching the client.
 * @param emit - Event emitter from {@link GatewayRouterOptions}.
 * @param event - Routing telemetry for the completed request.
 */
function safeEmit(emit: (event: RequestRoutedEvent) => void, event: RequestRoutedEvent): void {
  try {
    emit(event);
  } catch {
    // Observability telemetry must not surface to the client.
  }
}

/**
 * Per-request facts the emitter needs that the routing decision does not carry.
 */
interface EmitterContext {
  /** HTTP method of the client request, reported in the log line. */
  readonly method: string;
  /** Routed endpoint path used in the event payload. */
  readonly path: RoutedPath;
  /** Requested model extracted from the body. */
  readonly model: string;
  /** Whether the client requested `stream: true`. */
  readonly streamed: boolean;
  /**
   * Monotonic `performance.now()` reading taken after the body was fully
   * buffered; baseline for `durationMs`.
   */
  readonly startMs: number;
}

/**
 * Build a bound outcome emitter for a single routed request.
 *
 * Captures the routing decision and per-request context once, then returns a
 * small closure that accepts a {@link RoutedOutcome} and fires the full
 * {@link RequestRoutedEvent}. The event shape is selected by discriminating on
 * `decision.target.kind`, so each variant carries the correct `target` literal.
 *
 * The operator log line is written from that same constructed event rather than
 * from the captured inputs, so the bus event and the server output cannot
 * describe one request differently.
 * @param decision - Resolved routing decision for the current request.
 * @param ctx - Per-request facts not carried by the decision.
 * @param options - Resolved router options supplying the emitter and the log
 *   sink.
 * @returns Closure that constructs, emits, and logs the outcome.
 */
function buildEmitter(decision: RouteDecision, ctx: EmitterContext, options: ResolvedRouterOptions): OutcomeEmitter {
  return ({ outcome, status, upstreamError }) => {
    const base = {
      upstream: decision.target.name,
      path: ctx.path,
      requestedModel: ctx.model,
      upstreamModel: decision.upstreamModel,
      ruleIndex: decision.ruleIndex,
      outcome,
      status,
      durationMs: performance.now() - ctx.startMs,
      streamed: ctx.streamed,
    };
    const event: RequestRoutedEvent =
      decision.target.kind === 'anthropic' ? { target: 'anthropic', ...base } : { target: 'litellm', ...base };
    safeEmit(options.emit, event);

    if (upstreamError === undefined) {
      logRoutedRequest(options.logger, ctx.method, event);
      return;
    }
    // The catch terminates the chain, so neither a rejected summary read nor a
    // throw while formatting the line can surface as an unhandled rejection.
    // Losing the line in that case is the accepted cost; the alternative is
    // crashing the process over diagnostics.
    void upstreamError
      .then((summary) => {
        logRoutedRequest(options.logger, ctx.method, event, summary);
      })
      .catch(() => undefined);
  };
}

/**
 * Handle the Anthropic forwarding branch.
 *
 * When the target has `auth.apiKey`, replaces the client's auth headers with
 * the gateway-owned key (`x-api-key` set, `authorization` removed). When
 * `auth` is `null`, forwards the original body bytes and client headers
 * verbatim to preserve subscription OAuth tokens end-to-end.
 * @param ctx - Per-request forwarding context.
 * @param decision - Resolved routing decision for the Anthropic upstream.
 * @param bytes - Already-read request body bytes.
 * @returns Forwarded upstream response to stream to the client.
 */
async function forwardToAnthropic(
  ctx: ForwardContext,
  decision: AnthropicRouteDecision,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  const { target } = decision;
  const upstreamUrl = buildUpstreamUrl(target.url, ctx.path, ctx.search);

  // RFC 7230 §6.1: filter hop-by-hop and Connection-nominated headers from
  // the client before forwarding. When auth is configured, additionally replace
  // the client's auth headers with the gateway-owned API key. When auth is null
  // (pass-through), the filtered client headers are forwarded verbatim so that
  // subscription OAuth tokens reach Anthropic intact.
  const filteredHeaders = filterRequestHeaders(ctx.clientHeaders);
  const headers =
    target.auth !== null ? prepareAnthropicApiKeyHeaders(filteredHeaders, target.auth.apiKey) : filteredHeaders;

  return executeForwardRequest(
    { upstreamUrl, method: 'POST', headers, body: bytes, signal: ctx.signal },
    ctx.emitWith,
    ctx.excerptSignal,
  );
}

/**
 * Handle the LiteLLM forwarding branch.
 *
 * Replaces authentication headers, mutates the body per the rule's model and
 * reasoning settings, then forwards to the LiteLLM upstream.
 * @param ctx - Per-request forwarding context.
 * @param decision - Resolved routing decision for the LiteLLM upstream.
 * @param parsed - Parsed request body object from {@link parseMessagesBody}.
 * @returns Forwarded upstream response to stream to the client.
 */
async function forwardToLitellm(
  ctx: ForwardContext,
  decision: LitellmRouteDecision,
  parsed: Record<string, unknown>,
): Promise<Response> {
  const { target } = decision;
  const upstreamUrl = buildUpstreamUrl(target.url, ctx.path, ctx.search);
  const litellmBody = prepareLitellmBody(parsed, decision);
  // Filter hop-by-hop and Connection-nominated headers BEFORE injecting the
  // master key. A client-supplied `Connection: authorization` would otherwise
  // cause forwardRequest's inner filter to strip the injected Authorization
  // header, silently discarding the master key.
  const litellmHeaders = prepareLitellmHeaders(filterRequestHeaders(ctx.clientHeaders), target.masterKey);

  return executeForwardRequest(
    { upstreamUrl, method: 'POST', headers: litellmHeaders, body: litellmBody, signal: ctx.signal },
    ctx.emitWith,
    ctx.excerptSignal,
  );
}

/**
 * A `Transformer` including the `cancel` hook.
 *
 * The Streams Standard defines `transformer.cancel` and the runtime honours it,
 * but the two available declarations disagree: `@types/node`'s `stream/web`
 * `Transformer` declares `cancel`, while the global DOM-lib `Transformer` — the
 * one a global `TransformStream` resolves against — does not. Declaring the
 * shape keeps the hook typed instead of asserted; a runtime that ignores it
 * loses only promptness, because the `pipeTo` rejection path settles too.
 */
interface CancellableTransformer<I, O> extends Transformer<I, O> {
  /**
   * Called when the readable side is cancelled by its consumer.
   * @param reason - Cancellation reason supplied by the consumer.
   */
  cancel?: (reason?: unknown) => void | PromiseLike<void>;
}

/**
 * Wrap a response body through a byte-transparent `TransformStream` that calls
 * `onSettle` exactly once when the body is fully consumed or cancelled.
 *
 * Keeping the abort link alive through body streaming ensures that a runtime
 * shutdown signal fires even after response headers have arrived. Without this
 * wrapper, `link.release()` runs as soon as `forwardRequest` resolves (i.e. at
 * first-byte), removing the listener from the long-lived shutdown signal before
 * the body has been relayed — a subsequent `shutdownSignal.abort()` would then
 * silently fail to abort the in-flight upstream body stream.
 *
 * Three settle paths cover every outcome:
 * 1. **Normal completion (`flush`)** — the upstream closed the response body
 *    (`res.end()`); all bytes were relayed successfully and `pipeTo` resolves.
 * 2. **Consumer cancellation (`cancel`)** — the client stopped reading. This
 *    hook fires the moment the readable is cancelled, which matters: the same
 *    cancellation eventually rejects the in-flight `pipeTo` too, but only after
 *    the cancellation has propagated to the source and the upstream socket has
 *    been torn down. Settling on the hook releases the request's resources when
 *    the client leaves, not when the network finally notices.
 * 3. **`pipeTo` rejection** — the source was errored (e.g. the abort signal
 *    fired mid-stream and undici cancelled the response body), or a
 *    cancellation reached the pipe without going through the hook. `pipeTo`
 *    propagates cancellation to its source by default, so this path also
 *    cancels the upstream body.
 *
 * `onSettle` is told which of the two happened, because they mean different
 * things for anything else still reading the upstream stream: normal completion
 * means the shared source closed and every other tee branch will end on its
 * own, whereas a cancelled or errored client branch says nothing about the
 * source, which may still be trickling or may never end.
 *
 * For body-less responses, `onSettle` is called immediately — as a completion,
 * since there is no body that could be cut short — and the original response is
 * returned unchanged.
 * @param response - Upstream response whose body may be a long-running stream.
 * @param onSettle - Called exactly once when the body is fully consumed,
 *   cancelled, or errored, with `true` only when it was fully consumed. Must
 *   not throw.
 * @returns A new response with identical status, headers, and a body stream
 *   that pipes bytes through unchanged.
 */
function withSettleCallback(response: Response, onSettle: (completed: boolean) => void): Response {
  if (!response.body) {
    onSettle(true);
    return response;
  }

  let settled = false;
  const settle = (completed: boolean): void => {
    if (!settled) {
      settled = true;
      onSettle(completed);
    }
  };

  const transformer: CancellableTransformer<Uint8Array, Uint8Array> = {
    flush() {
      settle(true);
    },
    cancel() {
      settle(false);
    },
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>(transformer);

  // Pipe the upstream body bytes through unchanged. Any failure — the source
  // erroring (e.g. the abort signal fired and undici cancelled the body) or the
  // consumer cancelling the readable — rejects here, so the abort link is
  // released on every path the transformer's own hooks do not see.
  void response.body.pipeTo(transform.writable).catch(() => {
    settle(false);
  });

  return new Response(transform.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Everything the routing decision needs from a successfully buffered body.
 */
interface RoutingInputs {
  /** Raw body bytes, forwarded verbatim by the Anthropic branch. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Parsed body object, mutated in place by the LiteLLM branch. */
  readonly parsed: Record<string, unknown>;
  /** Model identifier the routing table is evaluated against. */
  readonly model: string;
}

/**
 * Either the buffered routing inputs, or the pre-routing rejection to return.
 *
 * Discriminated on the presence of `rejection`, so the caller cannot forget to
 * handle the rejection before reading the inputs.
 */
type RoutingInputsResult = { readonly rejection: Response } | RoutingInputs;

/**
 * Buffer the request body and extract the routing inputs.
 *
 * Separated from {@link routeRequest} so the pre-routing rejections (413
 * oversized body, 400 unparseable or self-contradicting body) are expressed as
 * a returned `Response` rather than as control flow interleaved with the
 * forwarding path.
 *
 * Each rejection is logged here, where the typed error still carries the byte
 * counts an operator needs. The model is never part of a rejection line: both
 * rejections happen at or before body parsing, so no model has been extracted
 * yet — a 413 cancels the stream before the body is complete, and a 400 means
 * parsing is what failed.
 * @param request - Raw client request from the Hono context.
 * @param path - Routed endpoint path, reported in the rejection line.
 * @param options - Resolved router options supplying the body cap and log sink.
 * @returns Either the buffered routing inputs, or the error response to return.
 */
async function readRoutingInputs(
  request: Request,
  path: RoutedPath,
  options: ResolvedRouterOptions,
): Promise<RoutingInputsResult> {
  // The client response and the log line are built from the same status and
  // reason, so a rejection cannot be reported one way to the caller and a
  // different way to the operator.
  const reject = (
    status: number,
    reason: string,
    detail?: Readonly<Record<string, number>>,
  ): { rejection: Response } => {
    logRejection(options.logger, { method: request.method, path, status, reason, detail });
    return { rejection: anthropicErrorResponse(status, 'invalid_request_error', reason) };
  };

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBodyWithLimit(request, options.maxBodyBytes);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return reject(413, err.message, { bytes: err.observedBytes, limit: err.maxBodyBytes });
    }
    if (err instanceof ContentLengthMismatchError) {
      // A body that contradicts its own framing is malformed, not oversized.
      // The declared length is already named in the message, so it needs no
      // separate detail field.
      return reject(400, err.message);
    }
    throw err;
  }

  try {
    const { parsed, model } = parseMessagesBody(bytes);
    return { bytes, parsed, model };
  } catch (err) {
    if (err instanceof InvalidMessagesBodyError) {
      return reject(400, err.message);
    }
    throw err;
  }
}

/**
 * Route a single Anthropic Messages request.
 *
 * Shared implementation for both `POST /v1/messages` and
 * `POST /v1/messages/count_tokens`.
 * @param request - Raw client request from the Hono context.
 * @param path - Routed endpoint path used for upstream URL construction and
 *   event telemetry.
 * @param compiled - Routing table resolved for this request.
 * @param options - Resolved router configuration for this sub-app.
 * @returns Response to forward to the client.
 */
async function forwardRoutedRequest(
  request: Request,
  path: RoutedPath,
  compiled: CompiledRules,
  options: ResolvedRouterOptions,
): Promise<Response> {
  const inputs = await readRoutingInputs(request, path, options);
  if ('rejection' in inputs) return inputs.rejection;

  // startMs is captured immediately after the body is fully buffered so that
  // durationMs covers routing-decision time and upstream TTFB, but not
  // request-body upload latency. performance.now() is monotonic, so a system
  // clock adjustment mid-request cannot produce a negative duration.
  const startMs = performance.now();
  const { bytes, parsed, model } = inputs;
  const streamed = parsed['stream'] === true;
  const { search } = new URL(request.url);
  const decision = decideRoute(model, compiled);
  const emitWith = buildEmitter(decision, { method: request.method, path, model, streamed, startMs }, options);

  // The composed signal is released when the response body settles (fully
  // consumed, cancelled by the client, or errored). Releasing at first-byte
  // (when forwardRequest resolves) would remove the shutdown listener before
  // the body has been relayed, so a shutdown abort mid-stream would silently
  // fail to cancel the upstream body.
  const link = linkAbortSignals(request.signal, options.shutdownSignal);
  // The upstream error-body read gets its own lifetime rather than borrowing
  // the abort link's. The link stops being able to fire once released, and
  // release happens when the *client's* branch of the response settles — after
  // which nothing could stop a read still waiting on the shared source.
  const excerpt = new AbortController();
  const ctx: ForwardContext = {
    clientHeaders: request.headers,
    path,
    search,
    signal: link.signal,
    excerptSignal: excerpt.signal,
    emitWith,
  };
  try {
    const response = isAnthropicDecision(decision)
      ? await forwardToAnthropic(ctx, decision, bytes)
      : await forwardToLitellm(ctx, decision, parsed);
    // Keep the abort link alive until the body settles. For a body-less
    // response there is nothing to relay, so withSettleCallback settles — and
    // therefore releases — immediately.
    return withSettleCallback(response, (completed) => {
      link.release();
      // A body that completed normally means the shared upstream stream closed,
      // so the error-body read ends on its own — cutting it here would race a
      // read that is one chunk from finishing. A cancelled or errored client
      // branch says nothing about the source, so the read is stopped instead.
      if (!completed) excerpt.abort();
    });
  } catch (err) {
    // Unexpected errors (bugs in routing or header preparation): release before
    // rethrowing so no listener outlives this request on the shutdown signal.
    link.release();
    excerpt.abort();
    throw err;
  }
}

/**
 * Route a single Anthropic Messages request, guaranteeing it is accounted for.
 *
 * {@link forwardRoutedRequest} reports every outcome it anticipates. This
 * wrapper covers the ones it does not: a client that vanishes mid-upload makes
 * the body read reject with a transport error, and a bug in routing or header
 * preparation throws outright. Either would otherwise leave the request with no
 * bus event and no log line — silently absent from the server output, which is
 * precisely the failure this logging exists to rule out.
 *
 * The reason is a fixed string, never the error's message: an error raised
 * while reading a request body can carry fragments of that body.
 *
 * A failure this late is practically unreachable — it needs a throw after the
 * upstream response headers already arrived — but if one happened, the routed
 * line and this line would both be written. Two honest lines beat a missing one.
 *
 * The runtime is resolved again here rather than carried over from the gate.
 * The memo has already settled by now, so this is a second read of the same
 * result — except when the service was torn down in between, which is exactly
 * the case that must answer `503` instead of routing into a destroyed gateway.
 * @param request - Raw client request from the Hono context.
 * @param path - Routed endpoint path.
 * @param options - Resolved router configuration for this sub-app.
 * @returns Response to forward to the client.
 * @throws Rethrows whatever {@link forwardRoutedRequest} threw, after logging.
 */
async function routeRequest(request: Request, path: RoutedPath, options: ResolvedRouterOptions): Promise<Response> {
  try {
    const loaded = await requireRuntime(options, request.method, () => path);
    if ('rejection' in loaded) return loaded.rejection;
    return await forwardRoutedRequest(request, path, loaded.runtime.compiled, options);
  } catch (err) {
    const disconnected = request.signal.aborted;
    logRejection(options.logger, {
      method: request.method,
      path,
      // 499 is the same non-standard "client gave up" status the abort path
      // returns; nothing is sent here, because there is no longer a client to
      // send it to.
      status: disconnected ? 499 : 500,
      reason: disconnected ? 'client disconnected' : 'internal error',
    });
    throw err;
  }
}

/**
 * Create the gateway Hono sub-application.
 *
 * Registers `POST /v1/messages` and `POST /v1/messages/count_tokens` handlers
 * with shared routing logic, and a catch-all that returns 404 for all other
 * paths. A gate middleware runs ahead of all three: it resolves the
 * credential-dependent runtime and enforces the access token when one is
 * configured. Mount the returned app under `/gateway` on the host Hono instance:
 *
 * ```ts
 * hostApp.route('/gateway', createGatewayRouter({ ensureRuntime, emit, maxBodyBytes, shutdownSignal }));
 * ```
 *
 * The router is buildable before any credential exists, which is what lets the
 * service expose it from `init()` unconditionally instead of failing activation
 * on a credential the host cannot resolve yet.
 * @param options - Router configuration including the runtime memo, the event
 *   emitter, the body-size cap, the shutdown signal, and an optional log sink.
 * @returns A Hono sub-app scoped to the two Anthropic Messages endpoints.
 */
export function createGatewayRouter(options: GatewayRouterOptions): Hono {
  const app = new Hono();
  const resolved: ResolvedRouterOptions = { ...options, logger: resolveGatewayLogger(options.logger) };

  app.use('*', createGate(resolved));

  app.post('/v1/messages', (c) => routeRequest(c.req.raw, '/v1/messages', resolved));

  app.post('/v1/messages/count_tokens', (c) => routeRequest(c.req.raw, '/v1/messages/count_tokens', resolved));

  // The catch-all is a rejection like any other: an operator chasing "my
  // requests vanish" must be able to see a wrong path or an unsupported method
  // in the same output as every other turned-away request.
  app.all('*', (c) => {
    logRejection(resolved.logger, {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: 404,
      reason: 'unknown route',
    });
    return c.json({ type: 'error', error: { type: 'not_found', message: 'Not found.' } }, 404);
  });

  return app;
}
