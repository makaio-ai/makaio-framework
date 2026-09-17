/**
 * Header filtering utilities for the gateway proxy layer.
 *
 * Two pure functions cover the two directions of a proxied request:
 * {@link filterRequestHeaders} strips connection-level and computed headers
 * before an outgoing upstream `fetch`, and {@link filterResponseHeaders} does
 * the same for the upstream reply before it reaches the client. Both honour
 * RFC 7230 §6.1 `Connection`-nominated header removal.
 *
 * **Response `content-encoding` policy:**
 * `fetch` on Node 22+ and Bun automatically decompresses bodies encoded with
 * `gzip`, `x-gzip`, `deflate`, `br`, or `zstd` (Node ≥ 22.15 / 24). When
 * any of those encodings are present — either alone or as a comma-separated
 * list where every token is in that set — `filterResponseHeaders` strips both
 * `content-encoding` and `content-length`, because the forwarded body stream
 * is already decoded and neither header would be accurate for the client. For
 * any other encoding (e.g. `identity`) both headers are forwarded unchanged,
 * because the body bytes are still in their encoded form and the client must
 * decode them.
 * @packageDocumentation
 */

/**
 * Fixed set of hop-by-hop and connection-level header names that must never
 * be forwarded in either direction.
 *
 * All values are lowercase to match the canonical form used by the `Headers`
 * class (which normalises names to ASCII lowercase on insertion). RFC 7230
 * §6.1 requires proxies to also honour any additional names listed in the
 * `Connection` header value — see {@link parseNominatedHeaders}.
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]);

/**
 * Content encodings that `fetch` decodes transparently on the receiving end.
 *
 * When `content-encoding` contains only tokens from this set, the body stream
 * forwarded by `upstream.body` is already decoded; both `content-encoding` and
 * `content-length` must be stripped from response headers. For any other
 * encoding the headers are forwarded unchanged.
 *
 * `zstd` is included because Node ≥ 22.15 / 24 decompresses it automatically,
 * matching the same transparent-decompression behaviour as `gzip` and `br`.
 */
const FETCH_DECODED_ENCODINGS: ReadonlySet<string> = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);

/**
 * Header carrying the gateway's own access token, when one is configured.
 *
 * Declared here rather than in the routing layer because the stripping rule
 * below is what guarantees the token never leaves the gateway, and the two must
 * not be able to drift apart.
 */
export const GATEWAY_ACCESS_TOKEN_HEADER = 'x-gateway-token';

/**
 * Additional headers stripped from every outgoing request, beyond the fixed
 * hop-by-hop denylist and any `Connection`-nominated names.
 *
 * - `host` — recomputed by `fetch` from the upstream URL.
 * - `content-length` — recomputed by `fetch` from the request body size.
 * - `expect` — the Node.js HTTP server has already completed the
 *   `100-continue` handshake with the client by the time the gateway sees the
 *   request; forwarding the header to undici would cause `UND_ERR_NOT_SUPPORTED`
 *   because undici does not implement `Expect: 100-continue` forwarding.
 * - `x-gateway-token` — terminates at the gateway. It authenticates the client
 *   to this proxy and has no meaning upstream, so forwarding it would leak a
 *   gateway secret to a third party. Stripped unconditionally, including when
 *   no access token is configured, so a client cannot smuggle the header
 *   through.
 */
const REQUEST_EXTRA_EXCLUSIONS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'expect',
  GATEWAY_ACCESS_TOKEN_HEADER,
]);

/**
 * Parse the additional header names nominated for removal by the value of a
 * `Connection` header.
 *
 * Per RFC 7230 §6.1 a proxy must strip any header whose lowercase name
 * appears as a comma-separated token in the `Connection` field-value before
 * forwarding the message.
 * @param connectionValue - The raw `Connection` header value, or `null` when
 *   the header is absent.
 * @returns A `Set` of lowercase header names to remove in addition to the
 *   fixed hop-by-hop denylist.
 */
function parseNominatedHeaders(connectionValue: string | null): Set<string> {
  if (!connectionValue) return new Set();
  return new Set(
    connectionValue
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
}

/**
 * Determine whether `fetch` has already transparently decoded the response
 * body for the given `content-encoding` value.
 *
 * Returns `true` only when every comma-separated token in `encodingValue` is
 * in {@link FETCH_DECODED_ENCODINGS}. An empty or absent header returns
 * `false` (no stripping needed when there is no encoding).
 * @param encodingValue - The raw `content-encoding` header value, or `null`
 *   when the header is absent.
 * @returns `true` when `fetch` has decoded the body and the encoding metadata
 *   must be stripped; `false` when the body is still in its encoded form.
 */
function isFetchDecoded(encodingValue: string | null): boolean {
  if (!encodingValue) return false;
  const tokens = encodingValue
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  return tokens.length > 0 && tokens.every((t) => FETCH_DECODED_ENCODINGS.has(t));
}

/**
 * Copy headers from `source` into a new `Headers`, omitting hop-by-hop
 * headers, `Connection`-nominated headers, and any caller-supplied extras.
 *
 * This is the single shared loop used by both direction-specific public
 * functions.
 * @param source - Source header map to filter.
 * @param extras - Additional lowercase header names to exclude beyond the
 *   fixed denylist and connection-nominated names.
 * @returns A new `Headers` instance containing only the headers safe to
 *   forward.
 */
function filterHeaders(source: Headers, extras: ReadonlySet<string>): Headers {
  const nominated = parseNominatedHeaders(source.get('connection'));
  const out = new Headers();
  for (const [name, value] of source) {
    // `name` is always lowercase — `Headers` normalises on insertion.
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (nominated.has(name)) continue;
    if (extras.has(name)) continue;
    out.append(name, value);
  }
  return out;
}

/**
 * Filter request headers before forwarding to an upstream `fetch` call.
 *
 * Strips all hop-by-hop and connection-level headers (including any names
 * nominated by the `Connection` header value per RFC 7230 §6.1), `host`
 * (recomputed by `fetch` from the URL), `content-length` (recomputed from the
 * request body), `expect` (already handled by the Node HTTP server before the
 * gateway sees the request; undici rejects forwarded `Expect` headers), and
 * `x-gateway-token` (terminates at the gateway). Everything else — including
 * `authorization`,
 * `x-api-key`, `anthropic-beta`, `anthropic-version`, and `content-type` —
 * passes through verbatim to preserve subscription OAuth tokens and Anthropic
 * protocol metadata end-to-end.
 * @param incoming - Headers from the original client request.
 * @returns A new `Headers` instance containing only the headers safe to
 *   forward to the upstream.
 */
export function filterRequestHeaders(incoming: Headers): Headers {
  return filterHeaders(incoming, REQUEST_EXTRA_EXCLUSIONS);
}

/**
 * Filter response headers before forwarding to the client.
 *
 * Strips all hop-by-hop and connection-level headers (including names
 * nominated by the `Connection` header value). Additionally, when `fetch` has
 * transparently decoded the response body (encodings `gzip`, `x-gzip`,
 * `deflate`, `br`, `zstd`), strips `content-encoding` and `content-length`
 * because the forwarded body stream is already decoded. For other encodings
 * (e.g. `identity`) both headers are forwarded unchanged. All other upstream
 * headers, including custom `x-request-id`-style headers, are forwarded
 * verbatim.
 * @param upstream - Headers from the upstream response.
 * @returns A new `Headers` instance containing only the headers safe to
 *   forward to the downstream client.
 */
export function filterResponseHeaders(upstream: Headers): Headers {
  const extras = isFetchDecoded(upstream.get('content-encoding'))
    ? new Set(['content-encoding', 'content-length'])
    : new Set<string>();
  return filterHeaders(upstream, extras);
}
