/**
 * Default bound for a diagnostic summary.
 *
 * Long enough to carry a schema rejection or a parser message in full, short
 * enough that the summary never buries the identifiers around it in a log line
 * or a persisted failure reason.
 */
export const DEFAULT_DIAGNOSTIC_SUMMARY_LENGTH = 200;

/** Control and format characters, which carry no meaning in a summary. */
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** Any run of whitespace, including the spaces left behind by the pass above. */
const WHITESPACE_RUNS = /\s+/gu;

/**
 * Reduce arbitrary text to one bounded, single-line fragment fit for a log line.
 *
 * Diagnostic text often arrives from somewhere that never considered where it
 * would be printed: a multi-line validation report, a parser message carrying
 * the offending input, or a message from another process. Embedded newlines
 * break log framing, control characters can rewrite a terminal, and unbounded
 * length pushes the surrounding identifiers out of view. This collapses all
 * three problems into one shape without editorializing about the content.
 *
 * Truncation is marked with a horizontal ellipsis, and the ellipsis is counted:
 * the result never exceeds `maxLength`. Callers that need the untruncated text
 * keep it themselves — typically as an error's `cause`.
 * @param text - Raw text from a producer, a parser, or a rejected validation.
 * @param maxLength - Longest result to return, ellipsis included. Defaults to
 *   {@link DEFAULT_DIAGNOSTIC_SUMMARY_LENGTH}.
 * @returns The text with invisible characters and whitespace runs collapsed to
 *   single spaces, trimmed, and truncated to `maxLength`.
 */
export function summarizeDiagnosticText(text: string, maxLength = DEFAULT_DIAGNOSTIC_SUMMARY_LENGTH): string {
  const flattened = text.replace(INVISIBLE_CHARACTERS, ' ').replace(WHITESPACE_RUNS, ' ').trim();
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, Math.max(0, maxLength - 1))}…`;
}
