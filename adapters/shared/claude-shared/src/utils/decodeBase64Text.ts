/**
 * Decode a base64-encoded string to UTF-8 text.
 *
 * Uses the Web-standard `TextDecoder`/`atob` APIs so this function works
 * in both browser and Node.js environments (Node 16+).
 *
 * **Defensive handling**: Wraps decoding in try/catch to return an empty string
 * on malformed input, preventing crashes from invalid base64 data.
 * @param data - Base64-encoded string.
 * @returns Decoded UTF-8 string, or empty string if decoding fails.
 */
export function decodeBase64Text(data: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  } catch {
    // Return empty string on malformed base64 input
    return '';
  }
}
