/**
 * Base64url encoding utilities for cryptographic data.
 *
 * Uses URL-safe base64 encoding (RFC 4648) without padding.
 * Standard for encoding binary crypto material in JSON/URLs.
 */

/**
 * Encode Uint8Array to base64url string.
 *
 * Converts binary data to URL-safe base64 string without padding.
 * Uses chunked approach to avoid call stack overflow on large payloads.
 * @param data - Binary data to encode
 * @returns Base64url-encoded string
 * @example
 * ```typescript
 * const nonce = crypto.getRandomValues(new Uint8Array(12));
 * const encoded = toBase64Url(nonce); // "Zj4Qr..." (no padding)
 * ```
 */
export function toBase64Url(data: Uint8Array): string {
  // Convert Uint8Array to base64 using Array.from to avoid stack overflow
  // String.fromCharCode(...data) can overflow for large arrays (>~100KB)
  const binary = Array.from(data, (byte) => String.fromCharCode(byte)).join('');
  const base64 = btoa(binary);

  // Convert to base64url: replace + with -, / with _, remove padding =
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Decode base64url string to Uint8Array.
 *
 * Converts URL-safe base64 string back to binary data.
 * @param base64url - Base64url-encoded string
 * @returns Binary data as Uint8Array
 * @throws Error if input is not valid base64url
 * @example
 * ```typescript
 * const data = fromBase64Url("Zj4Qr...");
 * ```
 */
export function fromBase64Url(base64url: string): Uint8Array {
  // Convert base64url to standard base64
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  const padding = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(padding);

  // Decode base64 to binary
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Encode string to Uint8Array (UTF-8).
 *
 * Converts text to binary using UTF-8 encoding.
 * @param text - String to encode
 * @returns UTF-8 encoded bytes
 * @example
 * ```typescript
 * const data = encodeText("Hello, world!");
 * ```
 */
export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Decode Uint8Array to string (UTF-8).
 *
 * Converts binary data to text using UTF-8 decoding.
 * @param data - Binary data to decode
 * @returns Decoded string
 * @example
 * ```typescript
 * const text = decodeText(data);
 * ```
 */
export function decodeText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}
