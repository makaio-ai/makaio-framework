/**
 * DirectChannel cryptographic utilities.
 *
 * Pure Web Crypto API functions for ECDH key exchange and AES-256-GCM
 * encryption. Zero external dependencies — uses `globalThis.crypto` only,
 * compatible with Node 22+ and all modern browsers.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode an ArrayBuffer or Uint8Array to a base64 string.
 *
 * Uses a character-by-character loop instead of spread to avoid stack
 * overflow on large payloads.
 * @param buffer - Raw bytes to encode
 * @returns base64-encoded string
 */
function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chars = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    chars[i] = String.fromCharCode(bytes[i]);
  }
  return btoa(chars.join(''));
}

/**
 * Decode a base64 string to an ArrayBuffer.
 * @param base64 - base64-encoded string
 * @returns Decoded bytes as ArrayBuffer
 */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an ephemeral ECDH P-256 keypair for channel key exchange.
 *
 * The private key is non-extractable and stays in memory only.
 * @returns Object with `publicKey` and `privateKey` CryptoKey handles
 */
export async function generateKeyPair(): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}> {
  return globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
}

/**
 * Export a CryptoKey public key to a base64 string for transport over the bus.
 * @param key - The public CryptoKey to export
 * @returns base64-encoded raw public key bytes
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await globalThis.crypto.subtle.exportKey('raw', key);
  return bufferToBase64(raw);
}

/**
 * Import a base64-encoded public key received from a peer.
 * @param base64Key - base64-encoded raw public key bytes
 * @returns Imported CryptoKey suitable for use in {@link deriveSharedKey}
 */
export async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(base64Key);
  return globalThis.crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/**
 * Derive a shared AES-256-GCM key from a local private key and a peer public key.
 *
 * Derives the AES key directly from the ECDH shared secret via the Web Crypto
 * `deriveKey` algorithm. If HKDF-based multi-key derivation is needed in the
 * future, this function is the seam to extend.
 * @param privateKey - Local ECDH private key
 * @param peerPublicKey - Peer's ECDH public key
 * @returns AES-256-GCM CryptoKey ready for encrypt/decrypt operations
 */
export async function deriveSharedKey(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<CryptoKey> {
  return globalThis.crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * A fresh random 12-byte IV is generated per call. The returned `data` field
 * includes the GCM authentication tag appended by the Web Crypto API.
 *
 * When `additionalData` is supplied it is bound into the GCM authentication
 * tag, preventing ciphertext from being replayed under a different
 * channel/subject/direction context. Decryption must supply the same value.
 * @param key - AES-256-GCM CryptoKey (from {@link deriveSharedKey})
 * @param plaintext - UTF-8 string to encrypt (typically a JSON-serialised payload)
 * @param additionalData - Optional authenticated-but-not-encrypted context string
 *   (e.g., `"<channelId>:<subject>:<direction>"`)
 * @returns Object with base64-encoded `iv` and `data` (ciphertext + auth tag)
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: string,
  additionalData?: string,
): Promise<{ iv: string; data: string }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const algParams: AesGcmParams = { name: 'AES-GCM', iv };
  if (additionalData !== undefined) {
    algParams.additionalData = new TextEncoder().encode(additionalData);
  }
  const ciphertext = await globalThis.crypto.subtle.encrypt(algParams, key, encoded);
  return {
    iv: bufferToBase64(iv),
    data: bufferToBase64(ciphertext),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload.
 *
 * Throws a `DOMException` (OperationError) if the ciphertext is tampered with,
 * the wrong key is supplied, or the `additionalData` does not match the value
 * used during encryption — GCM authentication tag verification is performed
 * automatically by the Web Crypto API.
 * @param key - AES-256-GCM CryptoKey (must be the same key used for encryption)
 * @param encrypted - Object with base64-encoded `iv` and `data` fields
 * @param additionalData - Optional authenticated context string; must match the
 *   value passed to {@link encrypt} exactly, or decryption will fail
 * @returns Decrypted UTF-8 string (typically JSON-parsed to recover the payload)
 */
export async function decrypt(
  key: CryptoKey,
  encrypted: { iv: string; data: string },
  additionalData?: string,
): Promise<string> {
  const iv = base64ToBuffer(encrypted.iv);
  const ciphertext = base64ToBuffer(encrypted.data);
  const algParams: AesGcmParams = { name: 'AES-GCM', iv };
  if (additionalData !== undefined) {
    algParams.additionalData = new TextEncoder().encode(additionalData);
  }
  const plaintext = await globalThis.crypto.subtle.decrypt(algParams, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
