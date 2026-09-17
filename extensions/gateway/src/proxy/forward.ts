/**
 * Low-level HTTP forwarding primitives for the gateway proxy layer.
 *
 * This module is responsible for the transport leg only: it calls the global
 * `fetch`, passes the body bytes and filtered headers to the upstream, and
 * wraps network-level failures in typed error classes that map onto the
 * `outcome` values defined in the gateway contracts.
 *
 * No body transformation ever occurs here. Response bodies are forwarded as
 * a raw stream — the upstream decides content shape, and SSE pings/comments
 * must pass through without buffering.
 * @packageDocumentation
 */

import { filterRequestHeaders, filterResponseHeaders } from './headers.js';

/**
 * Thrown when the upstream `fetch` was aborted because the client disconnected
 * or the caller's `AbortSignal` was triggered.
 *
 * Maps onto the `"aborted"` outcome value in `RequestRoutedEventSchema`.
 */
export class UpstreamAbortedError extends Error {
  /**
   * @param cause - The original error or signal reason that triggered the abort.
   */
  public constructor(cause: unknown) {
    super('Upstream request was aborted.', { cause });
    this.name = 'UpstreamAbortedError';
  }
}

/**
 * Thrown when the upstream `fetch` failed due to a network or DNS error before
 * an HTTP response was received (e.g. connection refused, unreachable host).
 *
 * Maps onto the `"upstream-unreachable"` outcome value in
 * `RequestRoutedEventSchema`.
 */
export class UpstreamUnreachableError extends Error {
  /**
   * @param cause - The original network error thrown by `fetch`.
   */
  public constructor(cause: unknown) {
    super('Upstream could not be reached.', { cause });
    this.name = 'UpstreamUnreachableError';
  }
}

/** Options for {@link forwardRequest}. */
export interface ForwardRequestOptions {
  /**
   * Fully-qualified upstream URL, e.g.
   * `https://api.anthropic.com/v1/messages`.
   */
  readonly upstreamUrl: string;
  /** HTTP method — always `POST` for Anthropic Messages endpoints. */
  readonly method: 'POST';
  /**
   * Headers to send upstream.
   *
   * {@link forwardRequest} runs {@link filterRequestHeaders} over this value
   * before the upstream call, stripping hop-by-hop, `Connection`-nominated,
   * `host`, `content-length`, and gateway-terminated headers; everything else
   * is forwarded verbatim.
   *
   * **Ordering constraint for callers that inject authentication:** run
   * {@link filterRequestHeaders} over the raw client headers *before* injecting
   * the header, never after. Because `forwardRequest` filters again, a client
   * that sends `Connection: authorization` (or nominates any other injected
   * name) would otherwise have the gateway's own credential stripped on the way
   * out, silently forwarding an unauthenticated request.
   */
  readonly headers: Headers;
  /**
   * Raw request body bytes. Passed directly as the fetch body; no
   * transformation is applied.
   *
   * The concrete `Uint8Array<ArrayBuffer>` type (rather than the abstract
   * `Uint8Array<ArrayBufferLike>`) is required so that TypeScript 6's
   * generified typed-array types satisfy both DOM `BlobPart` and Node.js
   * undici `BodyInit`, which demand `ArrayBufferView<ArrayBuffer>` (not the
   * more permissive `ArrayBufferLike` variant).
   */
  readonly body: Uint8Array<ArrayBuffer>;
  /**
   * Composed abort signal covering both the client connection and the runtime
   * shutdown. Created by `linkAbortSignals` in `abort-link.ts` and passed to
   * `fetch` so that either a client disconnect or a graceful shutdown cancels
   * the upstream request before response headers arrive.
   */
  readonly signal: AbortSignal;
}

/**
 * Forward a request to an upstream URL and return the raw `Response`.
 *
 * Calls global `fetch` with `redirect: 'manual'` so that upstream redirects
 * are returned to the caller as-is rather than followed. The caller is
 * responsible for passing the result to {@link toClientResponse} before writing
 * to the downstream client.
 *
 * Errors are mapped to typed subclasses:
 * - An abort (`signal.aborted` or `AbortError`) → {@link UpstreamAbortedError}
 * - Any other network failure → {@link UpstreamUnreachableError}
 * @param options - Forwarding options including URL, headers, body, and signal.
 * @returns The raw upstream `Response`, with its body stream unconsumed.
 * @throws When the client disconnects or the signal is triggered before the
 *   upstream responds; throws {@link UpstreamAbortedError}.
 * @throws When a network or DNS error prevents the upstream connection;
 *   throws {@link UpstreamUnreachableError}.
 */
export async function forwardRequest(options: ForwardRequestOptions): Promise<Response> {
  const { upstreamUrl, method, headers, body, signal } = options;
  try {
    return await fetch(upstreamUrl, {
      method,
      headers: filterRequestHeaders(headers),
      // Wrapping the Uint8Array in a Blob ensures the value is assignable to
      // BodyInit across both the DOM and Node.js (undici) type declarations,
      // which differ in how they enumerate accepted array-buffer views. The
      // Blob constructor accepts any ArrayBufferView and the resulting Blob is
      // in every BodyInit union; the overhead is negligible for bodies already
      // buffered in memory.
      body: new Blob([body]),
      signal,
      // Do not follow redirects — return them as opaque redirects so the
      // downstream client sees the upstream's actual response disposition.
      redirect: 'manual',
    });
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new UpstreamAbortedError(err);
    }
    throw new UpstreamUnreachableError(err);
  }
}

/**
 * Wrap an upstream `Response` in a new `Response` suitable for streaming to
 * the client.
 *
 * Copies `status`, `statusText`, and filtered headers from the upstream
 * response, piping `upstream.body` directly as the new body. No body
 * transformation is applied — error bodies are forwarded verbatim so that
 * Claude Code's retry logic can pattern-match on upstream error text.
 * @param upstream - The raw `Response` returned by {@link forwardRequest}.
 * @returns A new `Response` whose body streams the upstream body unchanged.
 */
export function toClientResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterResponseHeaders(upstream.headers),
  });
}
