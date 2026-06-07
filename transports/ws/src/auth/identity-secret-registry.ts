/**
 * Process-local HMAC identity secret registry.
 *
 * Hosts use this registry to publish short-lived identity-bound HMAC secrets
 * before a remote executor connects. The WebSocket auth layer resolves the
 * claimed identity through this registry during the challenge/response flow.
 */

import type { TransportPeerContext } from '@makaio/core';

const DEFAULT_HMAC_IDENTITY_PEER_KIND = 'workflow-execution';

interface RegisteredHmacIdentitySecret {
  /** HMAC secret expected for this identity. */
  readonly secret: string;
  /** Trusted peer kind exposed after the identity authenticates. */
  readonly peerKind: string;
}

/** Options for registering an HMAC identity secret. */
export interface HmacIdentitySecretRegistrationOptions {
  /**
   * Trusted peer kind exposed after this identity authenticates.
   *
   * Defaults to `workflow-execution` because the original identity-bound HMAC
   * clients are workflow runners.
   */
  readonly peerKind?: string;
}

const identitySecrets = new Map<string, RegisteredHmacIdentitySecret>();

/**
 * Register an HMAC secret for a transport identity.
 *
 * The returned cleanup removes the entry only when it still points at the
 * exact registration object, so replacing identity metadata cannot be
 * accidentally undone by an older cleanup handle.
 * @param identityId - Transport identity that may authenticate with the secret.
 * @param secret - HMAC secret expected for the identity.
 * @param options - Optional trusted peer metadata for this identity.
 * @returns Cleanup function that unregisters this exact secret.
 */
export function registerHmacIdentitySecret(
  identityId: string,
  secret: string,
  options: HmacIdentitySecretRegistrationOptions = {},
): () => void {
  if (identityId.trim().length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty identityId');
  }
  if (secret.length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty secret');
  }
  const peerKind = options.peerKind?.trim() || DEFAULT_HMAC_IDENTITY_PEER_KIND;
  const registration: RegisteredHmacIdentitySecret = { secret, peerKind };

  identitySecrets.set(identityId, registration);

  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (identitySecrets.get(identityId) === registration) {
      identitySecrets.delete(identityId);
    }
  };
}

/**
 * Resolve an HMAC secret for an identity claim.
 * @param identityId - Claimed transport identity.
 * @returns Registered secret, or null when the identity is unknown.
 */
export function resolveHmacIdentitySecret(identityId: string): string | null {
  return identitySecrets.get(identityId)?.secret ?? null;
}

/**
 * Resolve trusted peer context for an identity claim.
 * @param identityId - Claimed transport identity.
 * @returns Registered peer context, or null when the identity is unknown.
 */
export function resolveHmacIdentityPeer(identityId: string): TransportPeerContext | null {
  const entry = identitySecrets.get(identityId);
  if (!entry) {
    return null;
  }
  return { kind: entry.peerKind, id: identityId, authenticated: true };
}

/**
 * Clear all registered identity secrets.
 *
 * Intended for tests that exercise the process-global registry.
 */
export function clearHmacIdentitySecretsForTesting(): void {
  identitySecrets.clear();
}
