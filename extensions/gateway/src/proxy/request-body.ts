/**
 * Bounded request-body buffering for the gateway proxy layer.
 *
 * The gateway must hold the whole request body in memory before it can route:
 * the `model` field decides the upstream, and the Anthropic branch forwards the
 * original bytes verbatim. Buffering an unbounded body is therefore a
 * memory-exhaustion vector, so every read goes through {@link readBodyWithLimit}
 * rather than `Request.arrayBuffer()`.
 *
 * Two independent checks are applied, because neither alone is sufficient: a
 * declared `content-length` lets an oversized request be rejected before a
 * single byte is buffered, and the running counter catches a body that is
 * chunked, unlabelled, or larger than its own declared length.
 *
 * **Peak memory:** a body of unknown length is accumulated chunk by chunk and
 * then copied into a single buffer, so assembly momentarily holds roughly twice
 * the body size. A body that declares a valid `content-length` is written
 * straight into a single preallocated buffer and therefore peaks at the body
 * size itself.
 * @packageDocumentation
 */

import { concatChunks } from './byte-chunks.js';

/**
 * Thrown when a request body exceeds the configured maximum size.
 *
 * Carries both the configured limit and the size that tripped it, so the caller
 * can render an operator-meaningful message without re-deriving either. The
 * gap between the two is what tells an operator whether the limit is marginally
 * or wildly too low.
 */
export class RequestBodyTooLargeError extends Error {
  /** The configured maximum body size, in bytes, that the request exceeded. */
  public readonly maxBodyBytes: number;

  /**
   * The body size, in bytes, that exceeded the limit.
   *
   * The declared `content-length` when the request was rejected before any
   * bytes were buffered, otherwise the running total at the moment the limit
   * was passed — which is a lower bound on the true size, because the rest of
   * the stream is cancelled rather than counted.
   */
  public readonly observedBytes: number;

  /**
   * @param maxBodyBytes - Configured maximum body size in bytes.
   * @param observedBytes - Declared or received body size that exceeded it.
   */
  public constructor(maxBodyBytes: number, observedBytes: number) {
    super(`Request body exceeds the configured maximum of ${maxBodyBytes} bytes.`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBodyBytes = maxBodyBytes;
    this.observedBytes = observedBytes;
  }
}

/**
 * Thrown when a request body delivers more bytes than its `content-length`
 * header declared.
 *
 * A request that contradicts its own framing is malformed rather than
 * oversized: the declared length is what the gateway allocated for, so the
 * surplus bytes have no buffer to go to and the request is rejected instead of
 * being silently truncated or re-buffered.
 */
export class ContentLengthMismatchError extends Error {
  /** The byte count the request declared in its `content-length` header. */
  public readonly declaredBytes: number;

  /**
   * @param declaredBytes - Byte count declared by the `content-length` header.
   */
  public constructor(declaredBytes: number) {
    super(`Request body is larger than its declared content-length of ${declaredBytes} bytes.`);
    this.name = 'ContentLengthMismatchError';
    this.declaredBytes = declaredBytes;
  }
}

/**
 * Parse a `content-length` header value into a non-negative byte count.
 *
 * A malformed or absent value yields `null`, which downgrades to the streaming
 * check rather than rejecting the request — a client that lies about its length
 * is caught by the running counter either way.
 * @param value - Raw `content-length` header value, or `null` when absent.
 * @returns The declared byte count, or `null` when absent or unparseable.
 */
function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  // RFC 7230 §3.3.2: content-length = 1*DIGIT — only an uninterrupted run of
  // ASCII digits is valid. Reject leading/trailing whitespace, scientific
  // notation (1e3), signs (+5/-5), and hex (0x40), all of which Number() would
  // accept but which violate the wire format.
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Read a request body into memory, refusing to buffer more than `maxBodyBytes`.
 *
 * Rejects before reading when the declared `content-length` already exceeds the
 * limit. Otherwise reads the body stream chunk by chunk, tracking the running
 * total, and cancels the stream as soon as a limit is passed so the remaining
 * bytes are never buffered.
 *
 * A body that declares a valid `content-length` within the limit is written
 * directly into a buffer of exactly that size, which keeps peak memory at one
 * copy of the body. Chunk accumulation — and with it the roughly 2x peak during
 * final assembly — is used only when the length is unknown.
 * @param request - Incoming client request whose body should be buffered.
 * @param maxBodyBytes - Maximum number of body bytes to accept.
 * @returns The fully buffered body bytes.
 * @throws When the declared or actual body size exceeds `maxBodyBytes`; throws
 *   {@link RequestBodyTooLargeError}. When the stream delivers more bytes than
 *   `content-length` declared; throws {@link ContentLengthMismatchError}.
 */
export async function readBodyWithLimit(request: Request, maxBodyBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = parseContentLength(request.headers.get('content-length'));
  if (declared !== null && declared > maxBodyBytes) {
    throw new RequestBodyTooLargeError(maxBodyBytes, declared);
  }

  const body = request.body;
  if (body === null) {
    return new Uint8Array(0);
  }

  // A trustworthy declared length is the destination buffer: each chunk is
  // written in place, so the body is never held twice. Without one the chunks
  // must be kept until the final size is known.
  const preallocated = declared === null ? null : new Uint8Array(declared);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        throw new RequestBodyTooLargeError(maxBodyBytes, total);
      }
      if (preallocated === null) {
        chunks.push(value);
        continue;
      }
      if (total > preallocated.byteLength) {
        throw new ContentLengthMismatchError(preallocated.byteLength);
      }
      preallocated.set(value, total - value.byteLength);
    }
  } catch (err) {
    // Stop the producer immediately — the bytes already read are dropped when
    // this frame unwinds. Suppress any rejection from cancel() (e.g. an
    // already-errored stream) so it cannot replace the error the caller
    // expects.
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (preallocated !== null) {
    // A stream that ends before its declared length leaves the tail unwritten;
    // narrowing the view keeps that zero padding out of the forwarded bytes.
    return total === preallocated.byteLength ? preallocated : preallocated.subarray(0, total);
  }

  return concatChunks(chunks, total);
}
