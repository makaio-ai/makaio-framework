import { decodeJsonlChunk } from '@makaio/subprocess';

/**
 * Encode a bus message as a JSONL line.
 * @param message - Bus message to encode.
 * @returns Newline-terminated JSON string.
 */
export function encodeBusMessage(message: object): string {
  return JSON.stringify(message) + '\n';
}

/**
 * Result of decoding a JSONL chunk.
 */
export interface DecodeBusChunkResult {
  /** Fully parsed messages extracted from the chunk. */
  messages: unknown[];
  /** Leftover bytes not yet terminated by a newline. */
  remaining: string;
  /**
   * Raw lines that could not be parsed as JSON.
   * Callers may log or report these; they are never included in `messages`.
   */
  errors: string[];
}

/**
 * Decode a chunk of JSONL data, handling partial lines across chunks.
 *
 * Delegates to the shared `decodeJsonlChunk` primitive in `@makaio/subprocess`.
 * Malformed JSON lines are skipped rather than thrown — the raw offending line
 * is collected in `errors` so callers can log or handle them without crashing.
 * @param chunk - New data chunk to process.
 * @param buffer - Leftover data from previous chunk.
 * @returns Parsed messages, remaining buffer, and any unparseable lines.
 */
export function decodeBusChunk(chunk: string, buffer: string): DecodeBusChunkResult {
  return decodeJsonlChunk(chunk, buffer);
}
