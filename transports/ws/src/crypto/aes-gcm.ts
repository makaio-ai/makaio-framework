/**
 * AES-256-GCM encryption and decryption using Web Crypto API.
 *
 * AES-GCM provides authenticated encryption: both confidentiality
 * and integrity protection in a single operation.
 */

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * Generates a random 12-byte nonce and encrypts data.
 * The nonce must be transmitted alongside the ciphertext for decryption.
 * @param key - AES-256 CryptoKey
 * @param plaintext - Data to encrypt (Uint8Array)
 * @returns Promise resolving to object with ciphertext and nonce
 * @example
 * ```typescript
 * const sessionKey = await deriveSessionKey(...);
 * const plaintext = encodeText(JSON.stringify(payload));
 * const { ciphertext, nonce } = await encrypt(sessionKey, plaintext);
 * // Send both ciphertext and nonce to peer
 * ```
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  // Generate random 12-byte nonce (96 bits - recommended for GCM)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt with AES-GCM
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
    },
    key,
    plaintext as BufferSource,
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
  };
}

/**
 * Decrypt ciphertext with AES-256-GCM.
 *
 * Decrypts data using the same nonce that was used for encryption.
 * Automatically verifies the authentication tag - throws if data was tampered with.
 * @param key - AES-256 CryptoKey
 * @param ciphertext - Encrypted data
 * @param nonce - 12-byte nonce used during encryption
 * @returns Promise resolving to decrypted Uint8Array
 * @throws Error if authentication fails (data tampered with)
 * @example
 * ```typescript
 * const plaintext = await decrypt(sessionKey, ciphertext, nonce);
 * const payload = JSON.parse(decodeText(plaintext));
 * ```
 */
export async function decrypt(key: CryptoKey, ciphertext: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
    },
    key,
    ciphertext as BufferSource,
  );

  return new Uint8Array(decrypted);
}

/**
 * Import raw AES-256-GCM key.
 *
 * Converts raw key material (from HKDF) into a CryptoKey for encryption/decryption.
 * @param rawKey - 32-byte raw key material (256 bits)
 * @returns Promise resolving to AES-256 CryptoKey
 * @example
 * ```typescript
 * const rawSessionKey = await deriveSessionKeyRaw(...);
 * const sessionKey = await importAESKey(rawSessionKey);
 * ```
 */
export async function importAESKey(rawKey: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
