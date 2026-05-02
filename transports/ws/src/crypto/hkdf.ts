/**
 * HKDF (HMAC-based Key Derivation Function) using Web Crypto API.
 *
 * Derives a session encryption key from ECDH shared secret.
 * HKDF provides key stretching and domain separation.
 */

import { encodeText } from './encoding.js';

/**
 * Derive AES-256 key from shared secret using HKDF-SHA256.
 *
 * Performs HKDF key derivation to convert raw ECDH shared secret
 * into a proper AES-256 session key. Uses salt for randomness
 * and info for domain separation.
 * @param sharedSecret - Raw shared secret from ECDH (ArrayBuffer)
 * @param salt - Salt bytes (can be random or fixed context). Recommended: 16+ bytes of randomness.
 * @param info - Context string for domain separation (e.g., "makaio-e2e-session-v1")
 * @returns Promise resolving to AES-256 CryptoKey
 * @example
 * ```typescript
 * const sharedSecret = await deriveSharedSecret(myPrivateKey, peerPublicKey);
 * const salt = crypto.getRandomValues(new Uint8Array(16));
 * const sessionKey = await deriveSessionKey(sharedSecret, salt, "makaio-e2e-session-v1");
 * ```
 */
export async function deriveSessionKey(sharedSecret: ArrayBuffer, salt: Uint8Array, info: string): Promise<CryptoKey> {
  // Import shared secret as base key for HKDF
  const baseKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey']);

  // Derive AES-256-GCM key using HKDF
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: encodeText(info) as BufferSource,
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false, // Not extractable - session key stays in memory only
    ['encrypt', 'decrypt'],
  );
}
