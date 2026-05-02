/**
 * E2E encrypted machine transport wrapper.
 *
 * In relay architecture, machines connect TO the relay server as clients,
 * not as servers. This makes the machine transport essentially identical
 * to the client transport - both are WebSocket clients with E2E encryption.
 *
 * This wrapper provides a machine-specific interface while delegating to
 * the same client-side encryption logic used by browser connections.
 *
 * Decryption is handled via the `messageTransform` hook, which runs before
 * correlation tracking. This ensures request/response flows see decrypted
 * results rather than raw ciphertext.
 */

import type { BusTransport } from '@makaio/bus-core';
import { createE2ETransport, type E2ETransportOptions } from './create-e2e-transport.js';

/**
 * E2E machine transport configuration.
 *
 * The `e2eAuth` instance serves as both the TransportAuth (for the handshake)
 * and the session key provider (for message encryption/decryption).
 */
export type E2EMachineTransportOptions = E2ETransportOptions;

/**
 * Create an E2E encrypted machine transport.
 *
 * In relay architecture, machines connect TO the relay server as clients.
 * This factory creates a client transport with E2E encryption, identical
 * to browser connections but with machine-specific identity.
 *
 * Decryption runs in the `messageTransform` pipeline, so response
 * correlation sees decrypted results and errors.
 * @param options - E2E machine transport configuration
 * @returns BusTransport with E2E encryption
 * @example
 * ```typescript
 * const e2eAuth = new E2EAuth({
 *   signingKeyPair,
 *   identityId: machineId,
 *   peerId: relayId,
 *   getPeerSigningKey: async () => relayPublicKey,
 * });
 *
 * // Provide a pre-created WebSocket instance
 * const ws = new WebSocket('wss://relay.example.com');
 * const transport = createE2EMachineTransport({
 *   websocket: ws,
 *   e2eAuth,
 * });
 *
 * await transport.connect(); // Runs E2E handshake with relay
 * // Subsequent application payload/result/error fields are encrypted automatically.
 * ```
 */
export function createE2EMachineTransport(options: E2EMachineTransportOptions): BusTransport {
  return createE2ETransport(options);
}
