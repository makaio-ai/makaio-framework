/**
 * Cryptographic primitives for E2E encryption.
 *
 * Provides ECDH key exchange, ECDSA signatures, AES-GCM encryption,
 * HKDF key derivation, and encoding utilities.
 *
 * All implementations use Web Crypto API for browser and Node.js compatibility.
 */

// ECDH key exchange
export {
  generateECDHKeyPair,
  exportPublicKey,
  exportPublicKeyRaw,
  importPublicKey,
  importPublicKeyRaw,
  exportPrivateKeyPEM,
  importPrivateKeyPEM,
  deriveSharedSecret,
} from './ecdh.js';

// AES-GCM encryption
export { encrypt, decrypt, importAESKey } from './aes-gcm.js';

// HKDF key derivation
export { deriveSessionKey } from './hkdf.js';

// ECDSA signatures
export {
  generateSigningKeyPair,
  sign,
  verify,
  exportSigningPublicKey,
  importSigningPublicKey,
  exportSigningPublicKeyRaw,
  importSigningPublicKeyRaw,
  exportSigningPrivateKeyPEM,
  importSigningPrivateKeyPEM,
} from './ecdsa.js';

// Encoding utilities
export { toBase64Url, fromBase64Url, encodeText, decodeText } from './encoding.js';
