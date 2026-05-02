/**
 * ECDH (Elliptic Curve Diffie-Hellman) key management using Web Crypto API.
 *
 * Implements ECDH P-256 for secure key exchange in E2E encryption.
 * Uses Web Crypto API for browser and Node.js compatibility.
 */

import {
  exportPublicKeySPKI,
  exportPublicKeyRawBytes,
  importPublicKeySPKI,
  importPublicKeyRawBytes,
  exportPrivateKeyAsPEM,
  importPrivateKeyFromPEM,
} from './key-utils.js';

/** ECDH P-256 algorithm parameters. */
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/**
 * Generate an ECDH P-256 keypair.
 *
 * Creates a new elliptic curve keypair for ECDH key exchange.
 * The P-256 curve is universally supported by Web Crypto API.
 * @param extractable - Whether the private key can be exported. Set to false for browser device keys (security), true for Node.js server keys (persistence).
 * @returns Promise resolving to CryptoKeyPair
 */
export async function generateECDHKeyPair(extractable = true): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_P256, extractable, ['deriveKey', 'deriveBits']);
}

/**
 * Export public key to base64url (SPKI format).
 * @param key - Public CryptoKey to export
 * @returns Promise resolving to base64url-encoded public key
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return exportPublicKeySPKI(key);
}

/**
 * Export ECDH public key to base64url (raw format).
 * @param key - Public CryptoKey to export
 * @returns Base64url-encoded raw public key
 */
export async function exportPublicKeyRaw(key: CryptoKey): Promise<string> {
  return exportPublicKeyRawBytes(key);
}

/**
 * Import ECDH public key from base64url raw format.
 * @param base64url - Base64url-encoded raw public key
 * @returns Imported CryptoKey for ECDH operations
 */
export async function importPublicKeyRaw(base64url: string): Promise<CryptoKey> {
  return importPublicKeyRawBytes(base64url, ECDH_P256);
}

/**
 * Import public key from base64url (SPKI format).
 * @param base64url - Base64url-encoded public key (SPKI format)
 * @param usages - Key usages (default: empty for public keys used only in deriveBits)
 * @returns Promise resolving to imported CryptoKey
 */
export async function importPublicKey(base64url: string, usages: KeyUsage[] = []): Promise<CryptoKey> {
  return importPublicKeySPKI(base64url, ECDH_P256, usages);
}

/**
 * Export private key to PKCS8 PEM format (for Node.js file storage).
 * @param key - Private CryptoKey to export
 * @returns Promise resolving to PEM string
 * @throws Error if key is non-extractable
 */
export async function exportPrivateKeyPEM(key: CryptoKey): Promise<string> {
  return exportPrivateKeyAsPEM(key);
}

/**
 * Import private key from PKCS8 PEM format.
 * @param pem - PEM-encoded private key string
 * @returns Promise resolving to imported CryptoKey
 */
export async function importPrivateKeyPEM(pem: string): Promise<CryptoKey> {
  return importPrivateKeyFromPEM(pem, ECDH_P256, ['deriveKey', 'deriveBits']);
}

/**
 * Derive shared secret via ECDH.
 *
 * Performs ECDH key agreement: combines own private key with peer's public key
 * to derive a shared secret. Both parties derive the same secret.
 * @param privateKey - Own private key
 * @param publicKey - Peer's public key
 * @returns Promise resolving to raw shared secret as ArrayBuffer
 */
export async function deriveSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    256, // P-256 yields 256 bits
  );
}
