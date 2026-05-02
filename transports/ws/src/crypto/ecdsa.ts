/**
 * ECDSA (Elliptic Curve Digital Signature Algorithm) using Web Crypto API.
 *
 * Implements ECDSA P-256 SHA-256 for signing ephemeral public keys
 * during E2E authentication handshake.
 */

import {
  exportPublicKeySPKI,
  exportPublicKeyRawBytes,
  importPublicKeySPKI,
  importPublicKeyRawBytes,
  exportPrivateKeyAsPEM,
  importPrivateKeyFromPEM,
} from './key-utils.js';

/** ECDSA P-256 algorithm parameters. */
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/**
 * Generate an ECDSA P-256 signing keypair.
 *
 * Creates a new elliptic curve keypair for digital signatures.
 * The P-256 curve with SHA-256 is universally supported by Web Crypto API.
 * @param extractable - Whether the private key can be exported. Set to false for browser device keys (security), true for Node.js server keys (persistence).
 * @returns Promise resolving to CryptoKeyPair
 */
export async function generateSigningKeyPair(extractable = true): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA_P256, extractable, ['sign', 'verify']);
}

/**
 * Sign data with ECDSA P-256 SHA-256.
 *
 * Creates a digital signature over the data using the private key.
 * @param privateKey - Signing private key
 * @param data - Data to sign (Uint8Array)
 * @returns Promise resolving to signature as Uint8Array
 */
export async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    privateKey,
    data as BufferSource,
  );

  return new Uint8Array(signature);
}

/**
 * Verify ECDSA P-256 SHA-256 signature.
 *
 * Verifies that the signature was created by the holder of the private key
 * corresponding to the public key.
 * @param publicKey - Verification public key
 * @param signature - Signature to verify
 * @param data - Original data that was signed
 * @returns Promise resolving to true if signature is valid, false otherwise
 */
export async function verify(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    publicKey,
    signature as BufferSource,
    data as BufferSource,
  );
}

/**
 * Export signing public key to base64url (SPKI format).
 * @param key - Public CryptoKey to export
 * @returns Promise resolving to base64url-encoded public key
 */
export async function exportSigningPublicKey(key: CryptoKey): Promise<string> {
  return exportPublicKeySPKI(key);
}

/**
 * Import signing public key from base64url for verification.
 * @param base64url - Base64url-encoded public key (SPKI format)
 * @returns Promise resolving to imported CryptoKey for verification
 */
export async function importSigningPublicKey(base64url: string): Promise<CryptoKey> {
  return importPublicKeySPKI(base64url, ECDSA_P256, ['verify']);
}

/**
 * Export signing public key to base64url (raw format).
 * @param key - Public CryptoKey to export
 * @returns Base64url-encoded raw public key
 */
export async function exportSigningPublicKeyRaw(key: CryptoKey): Promise<string> {
  return exportPublicKeyRawBytes(key);
}

/**
 * Import signing public key from base64url raw format.
 * @param base64url - Base64url-encoded raw public key
 * @returns Imported CryptoKey for verification
 */
export async function importSigningPublicKeyRaw(base64url: string): Promise<CryptoKey> {
  return importPublicKeyRawBytes(base64url, ECDSA_P256, ['verify']);
}

/**
 * Export signing private key to PKCS8 PEM format (for Node.js file storage).
 * @param key - Private CryptoKey to export
 * @returns Promise resolving to PEM string
 * @throws Error if key is non-extractable
 */
export async function exportSigningPrivateKeyPEM(key: CryptoKey): Promise<string> {
  return exportPrivateKeyAsPEM(key);
}

/**
 * Import signing private key from PKCS8 PEM format.
 * @param pem - PEM-encoded private key string
 * @returns Promise resolving to imported CryptoKey
 */
export async function importSigningPrivateKeyPEM(pem: string): Promise<CryptoKey> {
  return importPrivateKeyFromPEM(pem, ECDSA_P256, ['sign']);
}
