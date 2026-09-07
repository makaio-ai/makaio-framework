/**
 * Crypto helper functions for E2E authentication.
 *
 * Extracted from E2EAuth to keep the main file under line limit.
 */

import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret,
  deriveSessionKey,
  sign,
  verify,
  encodeText,
} from '../crypto/index.js';
import { WebSocketConnectionError } from '../connection-error.js';

/**
 * Convert hex string to Uint8Array.
 *
 * Parses a hexadecimal string into binary data. Used for converting
 * hex-encoded signatures and salts from wire format.
 * @param hex - Hexadecimal string (e.g., "a1b2c3")
 * @returns Binary data as Uint8Array
 * @example
 * ```typescript
 * const bytes = hexToBytes('48656c6c6f'); // Uint8Array([72, 101, 108, 108, 111])
 * ```
 */
function hexToBytes(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g);
  return new Uint8Array(matches?.map((byte) => parseInt(byte, 16)) ?? []);
}

/**
 * Convert Uint8Array to hex string.
 *
 * Encodes binary data as a hexadecimal string. Used for encoding
 * signatures and salts for wire transmission.
 * @param bytes - Binary data to encode
 * @returns Hexadecimal string (lowercase, e.g., "a1b2c3")
 * @example
 * ```typescript
 * const hex = bytesToHex(new Uint8Array([72, 101, 108, 108, 111])); // "48656c6c6f"
 * ```
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate ephemeral ECDH keypair and sign it.
 * @param signingPrivateKey - Static ECDSA private key for signing
 * @param identityId - Identity ID to include in signature
 * @returns Ephemeral keypair, public key string, and signature string
 */
export async function generateAndSignEphemeralKey(
  signingPrivateKey: CryptoKey,
  identityId: string,
): Promise<{
  ephemeralKeyPair: CryptoKeyPair;
  ephemeralPublicKey: string;
  signature: string;
}> {
  // Generate ephemeral ECDH keypair
  const ephemeralKeyPair = await generateECDHKeyPair(true);
  const ephemeralPublicKey = await exportPublicKey(ephemeralKeyPair.publicKey);

  // Sign ephemeral public key + identityId with static signing key
  const dataToSign = encodeText(ephemeralPublicKey + identityId);
  const signatureBytes = await sign(signingPrivateKey, dataToSign);
  const signature = bytesToHex(signatureBytes);

  return {
    ephemeralKeyPair,
    ephemeralPublicKey,
    signature,
  };
}

/**
 * Generate a random salt for HKDF as hex string.
 * @returns Salt as lowercase hex string
 */
export function generateSaltHex(): string {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(saltBytes);
}

/**
 * Verify peer's ephemeral public key signature.
 * @param peerPublicKey - Peer's static ECDSA public key
 * @param ephemeralPublicKey - Peer's ephemeral public key (base64url)
 * @param signature - Signature (hex string)
 * @param peerId - Peer's identity ID
 * @returns true if signature is valid
 */
export async function verifyEphemeralKeySignature(
  peerPublicKey: CryptoKey,
  ephemeralPublicKey: string,
  signature: string,
  peerId: string,
): Promise<boolean> {
  const dataToSign = encodeText(ephemeralPublicKey + peerId);
  const signatureBytes = hexToBytes(signature);
  return verify(peerPublicKey, signatureBytes, dataToSign);
}

/**
 * Derive session key from ECDH shared secret.
 * @param myEphemeralPrivateKey - Own ephemeral private key
 * @param peerEphemeralPublicKey - Peer's ephemeral public key (base64url)
 * @param salt - Salt (hex string)
 * @param info - HKDF info string
 * @returns AES-256-GCM session key
 */
export async function deriveE2ESessionKey(
  myEphemeralPrivateKey: CryptoKey,
  peerEphemeralPublicKey: string,
  salt: string,
  info: string,
): Promise<CryptoKey> {
  // Import peer's ephemeral public key
  let peerPublicKey: CryptoKey;
  try {
    peerPublicKey = await importPublicKey(peerEphemeralPublicKey);
  } catch (error) {
    // DataError at this exact import boundary means the supplied peer SPKI is
    // invalid. Do not recategorize key-store, deriveBits or HKDF failures.
    if (error instanceof DOMException && error.name === 'DataError') {
      throw new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Invalid E2E peer public key', { cause: error });
    }
    throw error;
  }

  // Derive shared secret via ECDH
  const sharedSecret = await deriveSharedSecret(myEphemeralPrivateKey, peerPublicKey);

  // Derive session key via HKDF
  const saltBytes = hexToBytes(salt);
  return deriveSessionKey(sharedSecret, saltBytes, info);
}

/**
 * Compute a deterministic salt for relay-mode E2E sessions.
 *
 * Both peers derive the same salt by ordering identities and ephemeral keys
 * in a stable way, then hashing the concatenated string.
 * @param identityId - Local identity ID
 * @param peerId - Remote identity ID
 * @param localEphemeralPublicKey - Local ephemeral public key (base64url)
 * @param peerEphemeralPublicKey - Peer ephemeral public key (base64url)
 * @returns Hex-encoded salt string
 */
export async function deriveRelaySaltHex(
  identityId: string,
  peerId: string,
  localEphemeralPublicKey: string,
  peerEphemeralPublicKey: string,
): Promise<string> {
  if (identityId === peerId) {
    throw new Error('deriveRelaySaltHex: identityId must differ from peerId');
  }
  const [firstId, secondId] = identityId < peerId ? [identityId, peerId] : [peerId, identityId];
  const [firstKey, secondKey] =
    identityId < peerId
      ? [localEphemeralPublicKey, peerEphemeralPublicKey]
      : [peerEphemeralPublicKey, localEphemeralPublicKey];

  const data = encodeText(`${firstId}${secondId}${firstKey}${secondKey}`);
  const hashInput = new Uint8Array(data).buffer;
  const digest = await crypto.subtle.digest('SHA-256', hashInput);
  return bytesToHex(new Uint8Array(digest));
}
