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
   * Number of complete lines that were not valid JSON. Their content is not
   * retained, so it cannot leak into logs or error messages.
   */
  malformedLineCount: number;
}

/**
 * Decode a chunk of JSONL data, handling partial lines across chunks.
 *
 * Delegates to the shared `decodeJsonlChunk` primitive in `@makaio/subprocess`.
 * Malformed JSON lines are skipped rather than thrown and only counted in
 * `malformedLineCount`.
 * @param chunk - New data chunk to process.
 * @param buffer - Leftover data from previous chunk.
 * @returns Parsed messages, remaining buffer, and the number of unparseable lines.
 */
export function decodeBusChunk(chunk: string, buffer: string): DecodeBusChunkResult {
  return decodeJsonlChunk(chunk, buffer);
}
