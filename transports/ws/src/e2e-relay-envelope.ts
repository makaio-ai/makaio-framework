/**
 * Relay E2E envelope helpers.
 *
 * Encrypts entire bus messages for relay transport so that subscription
 * frames and other payload-less messages are protected.
 */

import type { BusMessage } from '@makaio/bus-core';
import { decrypt, encodeText, encrypt, decodeText, fromBase64Url, toBase64Url } from './crypto/index.js';
import type { E2EMetadata } from './e2e-message-crypto.js';

/**
 * Relay envelope message shape used on the wire.
 */
export interface RelayEnvelopeMessage {
  type: 'e2e-relay-envelope';
  payload: string;
  e2e: E2EMetadata;
}

/**
 * Check whether a parsed message is a relay envelope.
 * @param message - Parsed message candidate
 * @returns True if message is a relay envelope
 */
export function isRelayEnvelopeMessage(message: unknown): message is RelayEnvelopeMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const payload = message as { type?: unknown; payload?: unknown; e2e?: unknown };
  if (payload.type !== 'e2e-relay-envelope' || typeof payload.payload !== 'string') {
    return false;
  }

  const e2e = payload.e2e as { nonce?: unknown; v?: unknown } | undefined;
  return !!e2e && typeof e2e.nonce === 'string' && typeof e2e.v === 'number';
}

/**
 * Encrypt a full bus message into a relay envelope.
 * @param message - Bus message to encrypt
 * @param sessionKey - E2E session key
 * @returns Relay envelope message
 */
export async function encryptRelayEnvelope(message: BusMessage, sessionKey: CryptoKey): Promise<RelayEnvelopeMessage> {
  const plaintextJson = JSON.stringify(message);
  const plaintext = encodeText(plaintextJson);
  const { ciphertext, nonce } = await encrypt(sessionKey, plaintext);

  return {
    type: 'e2e-relay-envelope',
    payload: toBase64Url(ciphertext),
    e2e: {
      nonce: toBase64Url(nonce),
      v: 1,
    },
  };
}

/**
 * Decrypt a relay envelope into a bus message.
 * @param envelope - Relay envelope message
 * @param sessionKey - E2E session key
 * @returns Decrypted bus message
 */
export async function decryptRelayEnvelope(envelope: RelayEnvelopeMessage, sessionKey: CryptoKey): Promise<BusMessage> {
  const nonce = fromBase64Url(envelope.e2e.nonce);
  const ciphertext = fromBase64Url(envelope.payload);
  const plaintext = await decrypt(sessionKey, ciphertext, nonce);
  const plaintextJson = decodeText(plaintext);
  return JSON.parse(plaintextJson) as BusMessage;
}
