/**
 * Parse tool_use JSON input for Anthropic assistant history reconstruction.
 *
 * Anthropic assistant `tool_use` blocks require an object input shape. When
 * stream-normalized tool arguments are malformed or non-object JSON values,
 * preserve continuity by returning a marker object instead of throwing.
 * @param rawArgs - Serialized tool arguments
 * @returns Parsed tool args object or fallback marker object on invalid input
 */
export function parseToolUseInput(rawArgs: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to shared marker object below.
  }

  return { raw: rawArgs, parseError: true };
}
