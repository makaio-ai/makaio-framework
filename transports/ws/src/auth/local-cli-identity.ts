/**
 * HMAC identity used by the local Makaio CLI process.
 *
 * A named identity lets hosts distinguish an authenticated CLI connection
 * from an unrestricted shared-secret peer without creating another secret.
 */
import { registerHmacIdentitySecret } from './identity-secret-registry.js';

/** Stable identity presented by CLI WebSocket clients on the same host. */
export const MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID = 'makaio-cli-local:v1';

/** Peer kind hosts accept for local CLI supervisor controls. */
export const MAKAIO_LOCAL_CLI_PEER_KIND = 'makaio-cli-local';

/**
 * Register the local CLI identity for the lifetime of a host transport.
 * The shared host bus secret is the trust boundary; this peer kind is not a
 * separate credential from other processes that already possess that secret.
 * @param secret - Existing authenticated-bus secret shared with the CLI.
 * @returns Cleanup function that unregisters this registration generation.
 */
export function registerMakaioLocalCliHmacIdentity(secret: string): () => void {
  return registerHmacIdentitySecret(MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID, secret, {
    peerKind: MAKAIO_LOCAL_CLI_PEER_KIND,
  });
}
