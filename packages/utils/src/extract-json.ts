/**
 * Extract a JSON object from text that may contain surrounding content.
 *
 * LLM responses often wrap JSON in markdown fences or prose. This function
 * finds the first `{` and last `}` in the text and returns the substring
 * between them (inclusive).
 *
 * Returns the original text unchanged when no valid brace pair is found.
 * @param text - Raw text potentially containing a JSON object
 * @returns Extracted JSON substring, or the original text if no braces found
 */
export function extractJson(text: string): string {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return text;
  }
  return text.slice(firstBrace, lastBrace + 1);
}
