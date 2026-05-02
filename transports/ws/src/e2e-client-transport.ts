/**
 * E2E encrypted client transport wrapper.
 *
 * Wraps a `WebSocketClientTransport` to transparently encrypt outgoing
 * payload/result/error fields and decrypt incoming payload/result/error fields
 * using the session key from E2EAuth.
 *
 * Decryption is handled via the `messageTransform` hook, which runs before
 * correlation tracking. This ensures request/response flows see decrypted
 * results rather than raw ciphertext.
 *
 * Wire format (encrypted messages have 'e2e' field):
 * ```
 * \{
 *   type: 'request',
 *   subject: 'foo',
 *   payload: '<base64url-ciphertext>',
 *   e2e: \{ nonce: '<base64url>', v: 1 \},
 *   ...
 * \}
 * ```
 */

import type { BusTransport } from '@makaio/bus-core';
import { createE2ETransport, type E2ETransportOptions } from './create-e2e-transport.js';

/**
 * E2E client transport configuration.
 *
 * The `e2eAuth` instance serves as both the TransportAuth (for the handshake)
 * and the session key provider (for message encryption/decryption).
 */
export type E2EClientTransportOptions = E2ETransportOptions;

/**
 * Create an E2E encrypted client transport.
 *
 * Wraps a `WebSocketClientTransport` to transparently encrypt/decrypt
 * application payload/result/error fields using the session key established
 * during E2E auth.
 *
 * Decryption runs in the `messageTransform` pipeline, so response
 * correlation sees decrypted results and errors.
 * @param options - E2E client transport configuration
 * @returns BusTransport with E2E encryption
 * @example
 * ```typescript
 * const e2eAuth = new E2EAuth({
 *   signingKeyPair,
 *   identityId: deviceId,
 *   peerId: machineId,
 *   getPeerSigningKey: async () => machinePublicKey,
 * });
 *
 * const transport = createE2EClientTransport({
 *   websocket: ws,
 *   e2eAuth,
 * });
 *
 * await transport.connect(); // Runs E2E handshake
 * // Subsequent application payload/result/error fields are encrypted automatically.
 * ```
 */
export function createE2EClientTransport(options: E2EClientTransportOptions): BusTransport {
  return createE2ETransport(options);
}
