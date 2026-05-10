/**
 * Result of decoding a JSONL chunk.
 */
export interface JsonlDecodeResult {
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
 * Malformed JSON lines are skipped rather than thrown — the raw offending line
 * is collected in `errors` so callers can log or handle them without crashing.
 * @param chunk - New data chunk to process.
 * @param buffer - Leftover data from previous chunk.
 * @returns Parsed messages, remaining buffer, and any unparseable lines.
 */
export function decodeJsonlChunk(chunk: string, buffer: string): JsonlDecodeResult {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  const remaining = lines.pop() ?? '';
  const messages: unknown[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Skip malformed JSONL lines rather than crashing.
        errors.push(line);
      }
    }
  }

  return { messages, remaining, errors };
}
