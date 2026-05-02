/**
 * Shared encryption/decryption helpers for E2E transport messages.
 *
 * These utilities handle the encryption and decryption of payload and error
 * fields in bus messages, used by both client and server E2E transports.
 */

import type { BusMessage, BusRequestMessage, BusEventMessage, BusBroadcastMessage } from '@makaio/bus-core';
import { encrypt, decrypt, encodeText, decodeText, toBase64Url, fromBase64Url } from './crypto/index.js';

/**
 * E2E metadata attached to encrypted messages.
 */
export interface E2EMetadata {
  /** Nonce used for AES-GCM encryption (base64url) */
  nonce: string;
  /** Protocol version */
  v: number;
}

/**
 * Bus message with optional E2E metadata.
 */
export type MaybeEncryptedMessage = BusMessage & { e2e?: E2EMetadata };

/**
 * Type guard to check if message has payload field.
 * @param message - Message to check
 * @returns True if message has payload field
 */
export function hasPayload(message: BusMessage): message is BusRequestMessage | BusEventMessage | BusBroadcastMessage {
  return 'payload' in message;
}

/**
 * Encrypt result field if present.
 * @param message - Message to encrypt
 * @param result - Result object to update
 * @param sessionKey - Session key for encryption
 */
export async function encryptResultField(
  message: BusMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
): Promise<void> {
  if (message.type !== 'response' || message.result === undefined || message.error !== undefined) {
    return;
  }

  const plaintextJson = JSON.stringify(message.result);
  const plaintext = encodeText(plaintextJson);
  const { ciphertext, nonce } = await encrypt(sessionKey, plaintext);

  result.result = toBase64Url(ciphertext);
  result.e2e = {
    nonce: toBase64Url(nonce),
    v: 1,
  };
}

/**
 * Encrypt broadcast results field if present.
 * @param message - Message to encrypt
 * @param result - Result object to update
 * @param sessionKey - Session key for encryption
 */
export async function encryptResultsField(
  message: BusMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
): Promise<void> {
  if (message.type !== 'broadcast-response' || message.results === undefined || message.error !== undefined) {
    return;
  }

  const plaintextJson = JSON.stringify(message.results);
  const plaintext = encodeText(plaintextJson);
  const { ciphertext, nonce } = await encrypt(sessionKey, plaintext);

  result.results = toBase64Url(ciphertext);
  result.e2e = {
    nonce: toBase64Url(nonce),
    v: 1,
  };
}

/**
 * Encrypt payload field if present.
 * @param message - Message to encrypt
 * @param result - Result object to update
 * @param sessionKey - Session key for encryption
 */
export async function encryptPayloadField(
  message: BusMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
): Promise<void> {
  if (!hasPayload(message) || message.payload === undefined) {
    return;
  }

  const plaintextJson = JSON.stringify(message.payload);
  const plaintext = encodeText(plaintextJson);
  const { ciphertext, nonce } = await encrypt(sessionKey, plaintext);

  result.payload = toBase64Url(ciphertext);
  result.e2e = {
    nonce: toBase64Url(nonce),
    v: 1,
  };
}

/**
 * Encrypt error field if present.
 * @param message - Message to encrypt
 * @param result - Result object to update
 * @param sessionKey - Session key for encryption
 */
export async function encryptErrorField(
  message: BusMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
): Promise<void> {
  if ((message.type !== 'response' && message.type !== 'broadcast-response') || message.error === undefined) {
    return;
  }

  const plaintextJson = JSON.stringify(message.error);
  const plaintext = encodeText(plaintextJson);
  const { ciphertext, nonce } = await encrypt(sessionKey, plaintext);

  result.error = toBase64Url(ciphertext);
  result.e2e = {
    nonce: toBase64Url(nonce),
    v: 1,
  };
}

/**
 * Decrypt payload field if present.
 * @param message - Source message
 * @param result - Result object to update
 * @param sessionKey - Session key for decryption
 * @param nonce - Nonce for decryption
 */
export async function decryptPayloadField(
  message: MaybeEncryptedMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
  nonce: Uint8Array,
): Promise<void> {
  if (!hasPayload(message) || typeof message.payload !== 'string') {
    return;
  }

  const ciphertext = fromBase64Url(message.payload);
  const plaintext = await decrypt(sessionKey, ciphertext, nonce);
  const plaintextJson = decodeText(plaintext);
  result.payload = JSON.parse(plaintextJson);
}

/**
 * Decrypt result field if present.
 * @param message - Source message
 * @param result - Result object to update
 * @param sessionKey - Session key for decryption
 * @param nonce - Nonce for decryption
 */
export async function decryptResultField(
  message: MaybeEncryptedMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
  nonce: Uint8Array,
): Promise<void> {
  if (message.type !== 'response' || typeof message.result !== 'string') {
    return;
  }

  const ciphertext = fromBase64Url(message.result);
  const plaintext = await decrypt(sessionKey, ciphertext, nonce);
  const plaintextJson = decodeText(plaintext);
  result.result = JSON.parse(plaintextJson);
}

/**
 * Decrypt broadcast results field if present.
 * @param message - Source message
 * @param result - Result object to update
 * @param sessionKey - Session key for decryption
 * @param nonce - Nonce for decryption
 */
export async function decryptResultsField(
  message: MaybeEncryptedMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
  nonce: Uint8Array,
): Promise<void> {
  if (message.type !== 'broadcast-response' || typeof message.results !== 'string') {
    return;
  }

  const ciphertext = fromBase64Url(message.results);
  const plaintext = await decrypt(sessionKey, ciphertext, nonce);
  const plaintextJson = decodeText(plaintext);
  result.results = JSON.parse(plaintextJson);
}

/**
 * Decrypt error field if present.
 * @param message - Source message
 * @param result - Result object to update
 * @param sessionKey - Session key for decryption
 * @param nonce - Nonce for decryption
 */
export async function decryptErrorField(
  message: MaybeEncryptedMessage,
  result: Record<string, unknown>,
  sessionKey: CryptoKey,
  nonce: Uint8Array,
): Promise<void> {
  if ((message.type !== 'response' && message.type !== 'broadcast-response') || typeof message.error !== 'string') {
    return;
  }

  const ciphertext = fromBase64Url(message.error);
  const plaintext = await decrypt(sessionKey, ciphertext, nonce);
  const plaintextJson = decodeText(plaintext);
  result.error = JSON.parse(plaintextJson);
}

/**
 * Encrypt a bus message (both payload and error fields if present).
 *
 * Creates a copy of the message and modifies fields in place,
 * then casts back to the message type with e2e metadata.
 * @param message - Message to encrypt
 * @param sessionKey - Session key for encryption
 * @returns Encrypted message with e2e metadata
 */
export async function encryptMessage<T extends BusMessage>(
  message: T,
  sessionKey: CryptoKey,
): Promise<MaybeEncryptedMessage> {
  // Create mutable copy for field encryption
  const result: Record<string, unknown> = { ...message };

  // Encrypt payload if present (requests, events, broadcasts have payload)
  await encryptPayloadField(message, result, sessionKey);

  // Encrypt result if present (response messages)
  await encryptResultField(message, result, sessionKey);

  // Encrypt broadcast results if present (broadcast-response messages)
  await encryptResultsField(message, result, sessionKey);

  // Encrypt error if present (for response messages)
  await encryptErrorField(message, result, sessionKey);

  // The intermediate Record<string, unknown> accumulator can't be statically narrowed to
  // MaybeEncryptedMessage because TypeScript requires overlap for a single-hop cast on a
  // discriminated union. The invariant is maintained by construction: result was spread from
  // a BusMessage (preserving the type discriminant and all required fields), and only the
  // payload/result/results/error values were replaced with their encrypted string equivalents.
  // @ts-expect-error -- intentional: runtime invariant established above, no safe cast path exists
  return result as MaybeEncryptedMessage;
}

/**
 * Decrypt a bus message (both payload and error fields if present).
 *
 * Creates a copy of the message and decrypts fields in place,
 * then casts back to the base message type.
 * @param message - Message to decrypt
 * @param sessionKey - Session key for decryption
 * @returns Decrypted message
 */
export async function decryptMessage(message: MaybeEncryptedMessage, sessionKey: CryptoKey): Promise<BusMessage> {
  // Pass through non-encrypted messages (local mode compatibility)
  if (!message.e2e) {
    return message;
  }

  // Create mutable copy for field decryption
  const result: Record<string, unknown> = { ...message };
  delete result.e2e;

  const nonce = fromBase64Url(message.e2e.nonce);

  // Decrypt payload if present (requests, events, broadcasts have payload)
  await decryptPayloadField(message, result, sessionKey, nonce);

  // Decrypt result if present (response messages)
  await decryptResultField(message, result, sessionKey, nonce);

  // Decrypt broadcast results if present (broadcast-response messages)
  await decryptResultsField(message, result, sessionKey, nonce);

  // Decrypt error if present (for response messages)
  await decryptErrorField(message, result, sessionKey, nonce);

  // The intermediate Record<string, unknown> accumulator can't be statically narrowed to
  // BusMessage because TypeScript requires overlap for a single-hop cast on a discriminated
  // union. The invariant is maintained by construction: result was spread from a
  // MaybeEncryptedMessage (which extends BusMessage), e2e was deleted, and only the
  // payload/result/results/error values were decrypted back to their original types.
  // @ts-expect-error -- intentional: runtime invariant established above, no safe cast path exists
  return result as BusMessage;
}
