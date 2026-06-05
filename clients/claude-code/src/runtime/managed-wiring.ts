/**
 * Shared markers and parsers for Makaio-managed Claude Code wiring.
 *
 * These helpers are intentionally independent from the settings manager so
 * wiring removal and raw session-config scrubbing use one detection contract.
 * @packageDocumentation
 */

/**
 * Sentinel string embedded in every fire-and-forget hook command written by Makaio.
 */
export const HOOK_COMMAND_SENTINEL = 'hook received claude-code';

/**
 * Sentinel string embedded in every request/response hook command written by Makaio.
 *
 * Events declared with `mode: 'request'` in the client definition install
 * `makaio hook handle claude-code <eventName> --timeout <ms>` instead of the
 * fire-and-forget `hook received` variant.  The sentinel is used for detection,
 * removal, and stale-entry replacement by the wiring layer.
 */
export const HOOK_HANDLE_COMMAND_SENTINEL = 'hook handle claude-code';

/**
 * Sentinel string embedded in the statusline command written by Makaio.
 */
export const STATUSLINE_COMMAND_SENTINEL = 'claude statusline';

/**
 * Extract the original upstream shell command from a Makaio-managed statusline.
 *
 * The statusline bridge embeds the previous command as:
 * `... --upstream-args-json '["-c","<original>"]'`
 *
 * The JSON array may be followed by additional flags, so the extraction locates
 * the opening `[` and scans forward to find the matching `]`, respecting nested
 * brackets and JSON string escapes.
 * @param command - Full Makaio-managed statusline command string.
 * @returns The original shell command, or `null`.
 */
export function extractUpstreamCommand(command: string): string | null {
  const marker = '--upstream-args-json';
  const idx = command.indexOf(marker);
  if (idx === -1) return null;

  let tail = command.slice(idx + marker.length).trim();

  // Strip optional single-quote wrapping added by renderShellArg. The closing
  // quote is NOT necessarily at end-of-string when extra flags follow.
  if (tail.startsWith("'")) {
    tail = tail.slice(1);
    const closeQuote = findClosingSingleQuote(tail);
    if (closeQuote !== -1) {
      tail = tail.slice(0, closeQuote).replaceAll("'\\''", "'");
    }
  }

  const jsonPart = extractJsonArray(tail);
  if (jsonPart === null) return null;

  try {
    const parsed: unknown = JSON.parse(jsonPart);
    if (
      Array.isArray(parsed) &&
      parsed.length >= 2 &&
      (parsed[0] === '-c' || parsed[0] === '/c') &&
      typeof parsed[1] === 'string'
    ) {
      return parsed[1];
    }
  } catch {
    // Malformed JSON — cannot extract upstream.
  }
  return null;
}

/**
 * Find the index of the closing single quote, skipping shell-escaped
 * sequences (`'\''`).
 * @param s - String starting immediately after the opening single quote.
 * @returns Index of the closing `'`, or -1.
 */
function findClosingSingleQuote(s: string): number {
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'" && s.slice(i, i + 4) === "'\\''") {
      i += 4;
      continue;
    }
    if (s[i] === "'") return i;
    i++;
  }
  return -1;
}

/**
 * Extract the first balanced JSON array substring from `s`.
 *
 * Scans from the first `[` and counts bracket depth, respecting JSON string
 * literals.
 * @param s - Input string potentially containing a JSON array.
 * @returns The balanced `[...]` substring, or `null`.
 */
function extractJsonArray(s: string): string | null {
  const start = s.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
