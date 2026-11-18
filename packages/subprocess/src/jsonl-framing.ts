import { StringDecoder } from 'node:string_decoder';
import type { FinalLinePolicy } from './process-end.js';

/**
 * Longest line a decoder accepts, in UTF-16 code units, unless configured
 * otherwise. Large enough for any protocol message; its purpose is to bound the
 * memory a stream without newlines can claim, not to police message sizes.
 */
const DEFAULT_MAX_LINE_LENGTH = 64 * 1024 * 1024;

/** Options of one JSONL decoder. */
export interface JsonlDecoderOptions {
  /** What {@link JsonlDecoder.end} does with a final line that has no newline. */
  readonly finalLine: FinalLinePolicy;
  /**
   * Longest accepted line in UTF-16 code units, newline excluded. A longer line
   * is dropped and counted without being buffered whole. Defaults to 64 Mi.
   */
  readonly maxLineLength?: number;
}

/**
 * Lines a decoder dropped. Only counts leave the decoder: a JSONL stream carries
 * protocol payloads that may hold credentials, so no line content is retained.
 */
export interface JsonlLineDrops {
  /** Complete lines that were not valid JSON. */
  readonly malformedLineCount: number;
  /** Lines longer than the decoder's maximum line length. */
  readonly oversizedLineCount: number;
}

/** Result of decoding one chunk. */
export interface JsonlDecodeBatch extends JsonlLineDrops {
  /** Messages completed by the chunk, in stream order. */
  readonly messages: readonly unknown[];
}

/** Result of ending a decoder's input. */
export interface JsonlDecodeEnd extends JsonlDecodeBatch {
  /** Characters of an unterminated final line dropped under the `discard` policy. */
  readonly discardedChars: number;
}

/**
 * Incremental decoder for one newline-delimited JSON stream.
 *
 * Bytes are decoded as UTF-8 across chunk boundaries, so a character split
 * between two chunks arrives intact. A stream delivers either `Buffer` chunks or
 * already-decoded strings, never a mix of both. Blank lines are skipped.
 */
export interface JsonlDecoder {
  /**
   * Decode the next chunk of the stream.
   * @param chunk - Raw bytes, or text a stream already decoded.
   * @returns Messages the chunk completed and the lines it dropped.
   * @throws Error when the decoder has already ended or been abandoned.
   */
  push(chunk: Buffer | string): JsonlDecodeBatch;
  /**
   * Mark the genuine end of the input: flush the UTF-8 decoder and treat an
   * unterminated final line according to the decoder's {@link FinalLinePolicy}.
   * Only the first call (or the first of `end()` and `abandon()`) has an effect;
   * later calls return an empty result.
   * @returns Messages the end completed, dropped lines and discarded characters.
   */
  end(): JsonlDecodeEnd;
  /**
   * Stop decoding before the input ended, dropping whatever is buffered. Only
   * the first of `end()` and `abandon()` has an effect; later calls return `0`.
   * @returns Number of buffered characters that were dropped.
   */
  abandon(): number;
}

/** Mutable counters of one decode step. */
interface DecodeStep {
  readonly messages: unknown[];
  malformedLineCount: number;
  oversizedLineCount: number;
}

/**
 * Length of the content left in a line buffer; whitespace alone is no line.
 * @param rest - Buffered text.
 * @returns `rest.length`, or `0` when it holds only whitespace.
 */
function contentLength(rest: string): number {
  return rest.trim() === '' ? 0 : rest.length;
}

/**
 * Create a decoder for one newline-delimited JSON stream.
 * @param options - Final-line policy and maximum line length.
 * @returns A fresh decoder.
 * @throws RangeError when `maxLineLength` is not a positive integer.
 */
export function createJsonlDecoder(options: JsonlDecoderOptions): JsonlDecoder {
  const { finalLine, maxLineLength = DEFAULT_MAX_LINE_LENGTH } = options;
  if (!Number.isInteger(maxLineLength) || maxLineLength < 1) {
    throw new RangeError('maxLineLength must be a positive integer');
  }

  const utf8 = new StringDecoder('utf8');
  // Unterminated text of the current line; never longer than `maxLineLength`.
  let pending = '';
  // Set once the current line exceeded the maximum: it was counted, and the
  // rest of it up to the next newline is dropped without being buffered.
  let skippingOversizedLine = false;
  let finished = false;

  const newStep = (): DecodeStep => ({ messages: [], malformedLineCount: 0, oversizedLineCount: 0 });

  /**
   * Decode one complete line into the step.
   * @param line - Line without its newline.
   * @param step - Step receiving the message or the drop.
   */
  function acceptLine(line: string, step: DecodeStep): void {
    if (line.length > maxLineLength) {
      step.oversizedLineCount += 1;
      return;
    }
    if (line.trim() === '') return;
    try {
      step.messages.push(JSON.parse(line));
    } catch {
      // The parser's message quotes the input, so only the count is kept.
      step.malformedLineCount += 1;
    }
  }

  /**
   * Split decoded text into lines, carrying an unterminated rest to the next call.
   * @param text - Decoded text.
   * @param step - Step receiving messages and drops.
   */
  function takeText(text: string, step: DecodeStep): void {
    let start = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      const segment = text.slice(start, newline);
      start = newline + 1;
      if (skippingOversizedLine) {
        skippingOversizedLine = false;
      } else {
        acceptLine(pending + segment, step);
      }
      pending = '';
    }
    if (skippingOversizedLine) return;
    const rest = text.slice(start);
    if (pending.length + rest.length > maxLineLength) {
      step.oversizedLineCount += 1;
      pending = '';
      skippingOversizedLine = true;
      return;
    }
    pending += rest;
  }

  /**
   * Mark the decoder finished and take its buffered text.
   * @returns Buffered text including a flushed partial character, or `''` while
   *   an oversized line was being skipped.
   */
  function finish(): string {
    finished = true;
    const tail = utf8.end();
    const rest = skippingOversizedLine ? '' : pending + tail;
    pending = '';
    skippingOversizedLine = false;
    return rest;
  }

  return {
    push(chunk: Buffer | string): JsonlDecodeBatch {
      if (finished) throw new Error('JSONL decoder has already ended');
      const step = newStep();
      takeText(typeof chunk === 'string' ? chunk : utf8.write(chunk), step);
      return step;
    },

    end(): JsonlDecodeEnd {
      if (finished) return { ...newStep(), discardedChars: 0 };
      const step = newStep();
      const rest = finish();
      if (finalLine === 'parse') {
        acceptLine(rest, step);
        return { ...step, discardedChars: 0 };
      }
      return { ...step, discardedChars: contentLength(rest) };
    },

    abandon(): number {
      return finished ? 0 : contentLength(finish());
    },
  };
}

/**
 * Describe what a decoder dropped, by count only.
 * @param drops - Result of a chunk, or of the end with its discarded final-line characters.
 * @returns A phrase such as `1 malformed JSONL line(s)`, or `undefined` when nothing was dropped.
 */
export function describeJsonlDrops(drops: JsonlDecodeBatch | JsonlDecodeEnd): string | undefined {
  const parts: string[] = [];
  if (drops.malformedLineCount > 0) parts.push(`${drops.malformedLineCount} malformed JSONL line(s)`);
  if (drops.oversizedLineCount > 0) parts.push(`${drops.oversizedLineCount} over-length JSONL line(s)`);
  if ('discardedChars' in drops && drops.discardedChars > 0) {
    parts.push(`an unterminated final line (${drops.discardedChars} chars)`);
  }
  return parts.length === 0 ? undefined : parts.join(' and ');
}
