/**
 * Shared P-256 key import/export utilities used by both ECDH and ECDSA modules.
 *
 * Eliminates duplication of SPKI, raw, and PEM serialization logic.
 */

import { toBase64Url, fromBase64Url } from './encoding.js';

/**
 * Algorithm parameters for P-256 key operations.
 */
interface P256Algorithm {
  /** Web Crypto algorithm name ('ECDH' or 'ECDSA') */
  name: string;
  /** Named curve (always 'P-256') */
  namedCurve: 'P-256';
}

/**
 * Export a P-256 public key to base64url (SPKI format).
 * @param key - Public CryptoKey to export
 * @returns Base64url-encoded public key
 */
export async function exportPublicKeySPKI(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', key);
  return toBase64Url(new Uint8Array(exported));
}

/**
 * Export a P-256 public key to base64url (raw format).
 * @param key - Public CryptoKey to export
 * @returns Base64url-encoded raw public key
 */
export async function exportPublicKeyRawBytes(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key);
  return toBase64Url(new Uint8Array(exported));
}

/**
 * Import a P-256 public key from base64url SPKI format.
 * @param base64url - Base64url-encoded SPKI public key
 * @param algorithm - Algorithm parameters
 * @param usages - Key usages
 * @returns Imported CryptoKey
 */
export async function importPublicKeySPKI(
  base64url: string,
  algorithm: P256Algorithm,
  usages: KeyUsage[] = [],
): Promise<CryptoKey> {
  const bytes = fromBase64Url(base64url);
  return crypto.subtle.importKey('spki', bytes as BufferSource, algorithm, true, usages);
}

/**
 * Import a P-256 public key from base64url raw format.
 * @param base64url - Base64url-encoded raw public key
 * @param algorithm - Algorithm parameters
 * @param usages - Key usages
 * @returns Imported CryptoKey
 */
export async function importPublicKeyRawBytes(
  base64url: string,
  algorithm: P256Algorithm,
  usages: KeyUsage[] = [],
): Promise<CryptoKey> {
  const bytes = fromBase64Url(base64url);
  return crypto.subtle.importKey('raw', bytes as BufferSource, algorithm, true, usages);
}

/**
 * Export a P-256 private key to PKCS8 PEM format.
 * @param key - Private CryptoKey to export (must be extractable)
 * @returns PEM-encoded private key string
 */
export async function exportPrivateKeyAsPEM(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('pkcs8', key);
  const base64 = toBase64Url(new Uint8Array(exported));

  // Reconstruct standard base64 with padding for PEM format
  let standardBase64 = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (standardBase64.length % 4)) % 4;
  standardBase64 += '='.repeat(padding);

  return `-----BEGIN PRIVATE KEY-----\n${standardBase64.match(/.{1,64}/g)?.join('\n') ?? standardBase64}\n-----END PRIVATE KEY-----`;
}

/**
 * Import a P-256 private key from PKCS8 PEM format.
 * @param pem - PEM-encoded private key string
 * @param algorithm - Algorithm parameters
 * @param usages - Key usages
 * @returns Imported CryptoKey
 */
export async function importPrivateKeyFromPEM(
  pem: string,
  algorithm: P256Algorithm,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const bytes = fromBase64Url(base64url);

  return crypto.subtle.importKey('pkcs8', bytes as BufferSource, algorithm, true, usages);
}
