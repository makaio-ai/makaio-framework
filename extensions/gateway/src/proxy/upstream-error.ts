/**
 * Bounded, allowlisted summarisation of an upstream error response body.
 *
 * When an upstream rejects a request, the reason is in its response body — and
 * that is the one thing the gateway must not simply copy into an operator log:
 * an upstream is free to echo the offending request back, headers included. So
 * the body is never quoted. It is read under a byte bound, and only the `type`
 * and `message` fields of a recognised error envelope are extracted; anything
 * else is described (byte count, content type) rather than repeated.
 *
 * **Off the response path.** The read happens on a `clone()` of the response —
 * a tee of the same upstream stream. The caller starts it and hands the client
 * its own branch immediately, so an upstream that trickles its error body
 * delays only the log line. Nothing here ever buffers on the client's behalf
 * beyond {@link UPSTREAM_ERROR_READ_BYTES}.
 * @packageDocumentation
 */

import { concatChunks } from './byte-chunks.js';

/**
 * Maximum bytes retained from an upstream error body before the reader stops.
 *
 * The retained window is clamped exactly — a chunk that crosses the bound is
 * sliced rather than kept whole — so this is a hard ceiling on what the reader
 * holds, not an approximation.
 */
const UPSTREAM_ERROR_READ_BYTES = 4096;

/**
 * What the gateway learned about an upstream error response body.
 *
 * Deliberately not "the body". A `message` summary carries only the fields of a
 * recognised error envelope; anything unrecognised degrades to a shape that
 * describes the body without quoting it.
 */
export type UpstreamErrorSummary =
  | {
      /** A recognised error envelope was parsed out of the body. */
      readonly kind: 'message';
      /** `type: message`, or whichever of the two was present. */
      readonly text: string;
    }
  | {
      /** The body was not a recognised error envelope and is not quoted. */
      readonly kind: 'opaque';
      /** Bytes retained from the body. */
      readonly bytes: number;
      /**
       * Whether the retained bytes may be only part of the body — the read hit
       * the retention bound, was aborted, or errored, rather than seeing the
       * body end.
       */
      readonly truncated: boolean;
      /** The upstream's declared content type, when it declared one. */
      readonly contentType: string | null;
    };

/**
 * Narrow an unknown value to a plain object.
 * @param value - Value to test.
 * @returns `true` when the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a non-empty string property.
 * @param record - Object to read from.
 * @param key - Property name.
 * @returns The string value, or `undefined` when absent or not a non-empty string.
 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extract the loggable fields of a recognised error envelope.
 *
 * Covers the Anthropic shape (`{error:{type,message}}`) and the OpenAI/LiteLLM
 * shape (`{error:{message,type?,code?}}`), which share the same two fields.
 * Only those two are read: an upstream is free to echo the offending request —
 * headers included — elsewhere in its error body, so everything outside the
 * allowlist is discarded rather than logged.
 *
 * Call only with bytes known to be the whole body; a partial read can contain a
 * prefix that parses but misrepresents what the upstream said.
 * @param bytes - Complete body bytes.
 * @returns `type: message`, whichever of the two was present, or `undefined`
 *   when the body is not a recognised error envelope.
 */
function extractErrorEnvelope(bytes: Uint8Array): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const error = raw['error'];
  if (!isRecord(error)) return undefined;

  const type = readString(error, 'type');
  const message = readString(error, 'message');
  if (type !== undefined && message !== undefined) return `${type}: ${message}`;
  return type ?? message;
}

/** Outcome of a bounded drain: the bytes kept, and whether they are the lot. */
interface DrainResult {
  /** Retained bytes, never more than {@link UPSTREAM_ERROR_READ_BYTES}. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /**
   * Whether the retained bytes may be only part of the body.
   *
   * True unless the stream itself reported end-of-body *and* the read was not
   * cut short. Cancelling a reader resolves its in-flight `read()` with `done`,
   * so end-of-body alone cannot distinguish "the body ended" from "we stopped
   * it"; the abort path records itself separately for exactly that reason.
   */
  readonly truncated: boolean;
}

/**
 * Drain up to {@link UPSTREAM_ERROR_READ_BYTES} from a body stream.
 *
 * Stops on end of body, on reaching the bound, or when `signal` aborts. The
 * chunk that crosses the bound is sliced, so the retained window is exactly the
 * bound rather than the bound plus one chunk. A body that is exactly the bound
 * is reported as truncated, because nothing distinguishes it from a longer one
 * without reading further.
 * @param body - Stream to drain — a tee branch of the upstream error body.
 * @param signal - Lifetime of this read, owned by the request handler.
 * @returns The retained bytes and whether they may be only part of the body.
 */
async function drainBounded(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<DrainResult> {
  const reader = body.getReader();
  let cancelledByAbort = false;
  // Cancelling resolves any in-flight read() with `done`, so an aborted request
  // ends the loop without this function racing or polling the signal.
  const cancel = (): void => {
    cancelledByAbort = true;
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  const chunks: Uint8Array[] = [];
  let total = 0;
  let sawEndOfBody = false;
  try {
    while (total < UPSTREAM_ERROR_READ_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        sawEndOfBody = true;
        break;
      }
      const remaining = UPSTREAM_ERROR_READ_BYTES - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body errored by the upstream or by an abort yields what was already
    // read; sawEndOfBody stays false, so the result is reported as partial.
  } finally {
    signal.removeEventListener('abort', cancel);
    // Stop the tee pulling further bytes on this branch. Never awaited: the
    // client's branch owns when the shared source finishes, and a cancel that
    // never settles must not hold this read open.
    void reader.cancel().catch(() => undefined);
  }

  return { bytes: concatChunks(chunks, total), truncated: !sawEndOfBody || cancelledByAbort };
}

/**
 * Summarise an upstream error response body for the operator log.
 *
 * Clones the response *synchronously* so the clone is taken while the body is
 * still unconsumed; the caller then forwards the other tee branch to the client
 * untouched. The returned promise is deliberately not on the response path.
 *
 * Call this only for error responses, and give it a `signal` whose lifetime is
 * the request's: the read is bounded by {@link UPSTREAM_ERROR_READ_BYTES} and
 * by that signal, so it can neither buffer without limit nor outlive the
 * request that started it. An upstream stream errored by a client disconnect or
 * a runtime shutdown also ends the read on its own, because both tee branches
 * share the source.
 *
 * Never rejects: the summary is diagnostics and must not affect what the client
 * gets.
 * @param response - Upstream error response, with its body not yet consumed.
 * @param signal - Lifetime of this read, owned by the request handler.
 * @returns What was learned about the body, or `undefined` when there is none.
 */
export function readUpstreamErrorSummary(
  response: Response,
  signal: AbortSignal,
): Promise<UpstreamErrorSummary | undefined> {
  const contentType = response.headers.get('content-type');
  // Synchronous, before the caller hands `response.body` to the client.
  const body = response.clone().body;
  if (body === null) return Promise.resolve(undefined);

  return drainBounded(body, signal).then(({ bytes, truncated }) => {
    const envelope = truncated ? undefined : extractErrorEnvelope(bytes);
    if (envelope !== undefined) {
      return { kind: 'message', text: envelope };
    }
    return { kind: 'opaque', bytes: bytes.byteLength, truncated, contentType };
  });
}
