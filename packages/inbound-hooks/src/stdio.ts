import { text as readStreamText } from 'node:stream/consumers';

/**
 * Read the current process stdin as UTF-8 text.
 *
 * Returns an empty string when stdin is an interactive TTY so the command
 * does not hang waiting for user input.
 * @param stdin - The stdin stream to consume (defaults to `process.stdin`).
 * @returns The full stdin text, or an empty string for a TTY.
 */
export async function readProcessStdinText(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY === true) {
    return '';
  }
  return readStreamText(stdin);
}

/**
 * Read stdin without surfacing failures to the caller.
 *
 * Wraps any provided `readStdinText` function and swallows errors, returning
 * an empty string on any failure. Preserves fail-open semantics: a hook
 * bridge should never crash because stdin is unavailable.
 * @param readStdinText - Function that reads stdin text; defaults to {@link readProcessStdinText}.
 * @returns The full stdin text, or an empty string on any failure.
 */
export async function safeReadStdinText(readStdinText: () => Promise<string> = readProcessStdinText): Promise<string> {
  try {
    return await readStdinText();
  } catch {
    return '';
  }
}

/**
 * Trim, parse, and type-guard a raw string as a JSON object.
 *
 * Returns `undefined` when the input is blank, not valid JSON, or not a
 * plain object. Callers decide their own fallback semantics.
 * @param text - Raw string to parse.
 * @returns A plain `Record<string, unknown>`, or `undefined` on failure.
 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Parse a JSON object from raw stdin text.
 *
 * Returns an empty object when the input is blank, non-JSON, or does not
 * parse to an object. This preserves fail-open semantics: an event is always
 * emitted even when the native caller sends nothing or malformed data.
 * @param text - Raw text to parse.
 * @returns A plain `Record<string, unknown>` or `{}` on failure.
 */
export function parseJsonPayload(text: string): Record<string, unknown> {
  return parseJsonObject(text) ?? {};
}

/**
 * Parse an optional JSON metadata string from a CLI flag.
 *
 * Returns `undefined` when absent or unparseable so the caller can omit the
 * `metadata` field from the emitted payload entirely (rather than emitting
 * `{}`).
 * @param raw - Raw JSON string from a `--metadata-json` flag, or `undefined`.
 * @returns A parsed metadata record, or `undefined` on absence or parse failure.
 */
export function parseJsonMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseJsonObject(raw);
}
