/**
 * Authentication module for WebSocket transport.
 *
 * Exports the TransportAuth interface for implementing custom
 * authentication strategies, and built-in implementations.
 */

export type { TransportAuth } from './interface.js';
export { HmacAuth } from './hmac-auth.js';
export type { HmacAuthOptions } from './hmac-auth.js';
export {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityPeer,
  resolveHmacIdentitySecret,
} from './identity-secret-registry.js';
export type { HmacIdentitySecretRegistrationOptions } from './identity-secret-registry.js';
export { E2EAuth } from './e2e-auth.js';
export type { E2EAuthOptions } from './e2e-auth.js';
export { E2ERelayAuth } from './e2e-relay-auth.js';
export type { E2ERelayAuthOptions } from './e2e-relay-auth.js';
export { DispatchingAuth } from './dispatching-auth.js';
export type { DispatchingAuthOptions } from './dispatching-auth.js';
