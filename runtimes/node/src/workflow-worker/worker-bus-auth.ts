import { HmacAuth } from '@makaio/bus-transport-websocket';

/**
 * Build transport authentication without interpreting credentials as grants.
 * @param secret - HMAC secret; undefined means no HMAC authentication.
 * @param identityId - Optional identity for the server's trusted-peer resolver.
 * @returns HMAC authenticator when a secret is supplied.
 */
export function createWorkerBusAuth(secret: string | undefined, identityId?: string): HmacAuth | undefined {
  return secret === undefined ? undefined : new HmacAuth({ secret, ...(identityId !== undefined && { identityId }) });
}
