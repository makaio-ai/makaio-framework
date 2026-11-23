/**
 * HMAC identity used by the local Makaio CLI process.
 *
 * A named identity lets hosts distinguish an authenticated CLI connection
 * from an unrestricted shared-secret peer without creating another secret.
 */
import { MAKAIO_CLI_LOCAL_PARTY_KIND } from '@makaio/core';
import { registerHmacIdentitySecret } from './identity-secret-registry.js';

/** Stable identity presented by CLI WebSocket clients on the same host. */
export const MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID = 'makaio-cli-local:v1';

/**
 * Register the local CLI identity for the lifetime of a host transport.
 * The shared host bus secret is the trust boundary; this party kind is not a
 * separate credential from other processes that already possess that secret.
 * @param secret - Existing authenticated-bus secret shared with the CLI.
 * @returns Cleanup function that unregisters this registration generation.
 */
export function registerMakaioLocalCliHmacIdentity(secret: string): () => void {
  return registerHmacIdentitySecret(MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID, secret, {
    partyKind: MAKAIO_CLI_LOCAL_PARTY_KIND,
    attestingRole: 'local-cli',
  });
}
