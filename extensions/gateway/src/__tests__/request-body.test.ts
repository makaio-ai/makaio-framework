/**
 * Unit tests for the bounded request-body buffering utilities.
 *
 * `parseContentLength` is tested indirectly through `readBodyWithLimit`:
 * a malformed value must not cause early rejection (the request falls through
 * to the stream counter), while a valid oversized value must reject before
 * buffering a single byte.
 *
 * The two assembly strategies are covered separately: a declared length fills a
 * preallocated buffer, an unknown length accumulates chunks. Both must return
 * exactly the delivered bytes.
 */

import { describe, expect, it } from 'vitest';
import { ContentLengthMismatchError, readBodyWithLimit, RequestBodyTooLargeError } from '../proxy/request-body.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `Request` whose body is the given text and whose `content-length`
 * header is set to the provided raw string (which may be malformed).
 * @param body - UTF-8 body text to send.
 * @param contentLength - Raw value for the `content-length` header.
 * @returns A POST `Request` suitable for `readBodyWithLimit`.
 */
function makeRequest(body: string, contentLength: string): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': contentLength },
    body,
    // Disable the default fetch guard that auto-sets content-length.
    // @ts-expect-error — duplex is an undici-specific extension.
    duplex: 'half',
  });
}

// ---------------------------------------------------------------------------
// parseContentLength via readBodyWithLimit — malformed values → no early reject
// ---------------------------------------------------------------------------

describe('parseContentLength: malformed content-length values are treated as absent', () => {
  // Each of the following cases has a content-length that Number() would
  // happily parse but that violates RFC 7230 §3.3.2 (1*DIGIT). A correctly
  // implemented parser returns null for them, so no length is declared: the
  // stream counter governs and the chunk-accumulating path assembles the body.
  // Since the actual body (< 100 B) fits within maxBodyBytes = 100, all calls
  // must succeed. A lenient parser would misbehave on each of them: "1e3"
  // becomes 1000 and rejects a request that is well within the limit, "+5"
  // becomes 5 and rejects the body for contradicting a length it never
  // declared, and "0x40" becomes 64 and sizes the buffer from a fabricated
  // number.

  const SMALL_BODY = JSON.stringify({ model: 'test' }); // well under 100 B
  const MAX = 100;

  // Surrounding whitespace is deliberately not covered: `Headers` normalises
  // header values on the way in, so a padded `content-length` is already
  // trimmed before `parseContentLength` sees it and cannot be constructed here.

  it('scientific notation ("1e3") does not trigger early rejection', async () => {
    const req = makeRequest(SMALL_BODY, '1e3');
    const bytes = await readBodyWithLimit(req, MAX);
    expect(bytes.byteLength).toBe(SMALL_BODY.length);
  });

  it('explicit plus sign ("+5") does not trigger early rejection', async () => {
    const req = makeRequest(SMALL_BODY, '+5');
    const bytes = await readBodyWithLimit(req, MAX);
    expect(bytes.byteLength).toBe(SMALL_BODY.length);
  });

  it('hexadecimal ("0x40") does not trigger early rejection', async () => {
    const req = makeRequest(SMALL_BODY, '0x40');
    const bytes = await readBodyWithLimit(req, MAX);
    expect(bytes.byteLength).toBe(SMALL_BODY.length);
  });
});

// ---------------------------------------------------------------------------
// parseContentLength: a well-formed value causes early rejection when oversized
// ---------------------------------------------------------------------------

describe('parseContentLength: well-formed content-length causes early rejection', () => {
  it('"12" is accepted and rejects when it exceeds maxBodyBytes', async () => {
    // maxBodyBytes = 5; declared length = 12 > 5 → reject before reading.
    const req = makeRequest('hello!', '12');
    await expect(readBodyWithLimit(req, 5)).rejects.toThrow(RequestBodyTooLargeError);
  });

  it('"0" is accepted as a valid zero-length declaration', async () => {
    const req = makeRequest('', '0');
    const bytes = await readBodyWithLimit(req, 100);
    expect(bytes.byteLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stream counter enforces the limit when no content-length is present
// ---------------------------------------------------------------------------

describe('readBodyWithLimit: stream counter', () => {
  it('rejects when the actual stream exceeds maxBodyBytes', async () => {
    const bigBody = 'x'.repeat(200);
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: bigBody,
      // @ts-expect-error — duplex is an undici-specific extension.
      duplex: 'half',
    });
    await expect(readBodyWithLimit(req, 100)).rejects.toThrow(RequestBodyTooLargeError);
  });

  it('returns all bytes when the stream fits within maxBodyBytes', async () => {
    const body = 'hello world';
    const req = new Request('http://localhost/', {
      method: 'POST',
      body,
      // @ts-expect-error — duplex is an undici-specific extension.
      duplex: 'half',
    });
    const bytes = await readBodyWithLimit(req, 100);
    expect(new TextDecoder().decode(bytes)).toBe(body);
  });

  it('returns empty bytes for a request with no body', async () => {
    const req = new Request('http://localhost/', { method: 'POST' });
    const bytes = await readBodyWithLimit(req, 100);
    expect(bytes.byteLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Preallocated assembly path (valid content-length within the limit)
// ---------------------------------------------------------------------------

describe('readBodyWithLimit: preallocated assembly', () => {
  it('fills a buffer of exactly the declared size when the stream matches it', async () => {
    const body = JSON.stringify({ model: 'claude-opus-4-5', messages: [] });
    const req = makeRequest(body, String(body.length));

    const bytes = await readBodyWithLimit(req, 4096);

    expect(new TextDecoder().decode(bytes)).toBe(body);
    // No slack: the returned view is the declared allocation, not a copy of a
    // chunk list, so the buffer is neither padded nor oversized.
    expect(bytes.byteLength).toBe(body.length);
  });

  it('narrows the view when the stream ends before the declared length', async () => {
    // A short delivery must not surface the unwritten zero padding of the
    // preallocated buffer.
    const body = 'hi';
    const req = makeRequest(body, '10');

    const bytes = await readBodyWithLimit(req, 4096);

    expect(bytes.byteLength).toBe(body.length);
    expect(new TextDecoder().decode(bytes)).toBe(body);
  });

  it('rejects when the stream delivers more bytes than content-length declared', async () => {
    // Declared 5, actual 11: the request contradicts its own framing, which is
    // malformed rather than oversized — the limit (4096) is never reached.
    const req = makeRequest('hello world', '5');

    await expect(readBodyWithLimit(req, 4096)).rejects.toThrow(ContentLengthMismatchError);
  });

  it('reports the declared length on the mismatch error', async () => {
    const req = makeRequest('hello world', '5');

    const rejection = await readBodyWithLimit(req, 4096).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(ContentLengthMismatchError);
    expect(rejection instanceof ContentLengthMismatchError ? rejection.declaredBytes : -1).toBe(5);
  });

  it('prefers the size limit over the mismatch when both would apply', async () => {
    // Declared length equals the limit, so an over-delivering stream trips the
    // limit check first: an oversized body must stay a 413 concern.
    const req = makeRequest('hello world', '5');

    await expect(readBodyWithLimit(req, 5)).rejects.toThrow(RequestBodyTooLargeError);
  });
});
