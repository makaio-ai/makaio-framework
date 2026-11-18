/**
 * Result of decoding a JSONL chunk.
 */
export interface JsonlDecodeResult {
  /** Fully parsed messages extracted from the chunk. */
  messages: unknown[];
  /** Leftover bytes not yet terminated by a newline. */
  remaining: string;
  /**
   * Number of complete lines in the chunk that were not valid JSON. The lines
   * themselves are not retained: a JSONL stream carries protocol payloads that
   * may hold credentials, so callers can only report how many lines were dropped.
   */
  malformedLineCount: number;
}

/**
 * Decode a chunk of JSONL data, handling partial lines across chunks.
 *
 * Malformed JSON lines are skipped rather than thrown and only counted in
 * `malformedLineCount`; their content never leaves the decoder.
 * @param chunk - New data chunk to process.
 * @param buffer - Leftover data from previous chunk.
 * @returns Parsed messages, remaining buffer, and the number of unparseable lines.
 */
export function decodeJsonlChunk(chunk: string, buffer: string): JsonlDecodeResult {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  const remaining = lines.pop() ?? '';
  const messages: unknown[] = [];
  let malformedLineCount = 0;

  for (const line of lines) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Skip malformed JSONL lines rather than crashing.
        malformedLineCount += 1;
      }
    }
  }

  return { messages, remaining, malformedLineCount };
}
