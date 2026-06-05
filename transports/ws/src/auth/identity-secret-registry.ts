/**
 * Process-local HMAC identity secret registry.
 *
 * Hosts use this registry to publish short-lived identity-bound HMAC secrets
 * before a remote executor connects. The WebSocket auth layer resolves the
 * claimed identity through this registry during the challenge/response flow.
 */

const identitySecrets = new Map<string, string>();

/**
 * Register an HMAC secret for a transport identity.
 *
 * The returned cleanup removes the entry only when it still points at the same
 * secret, so replacing an identity secret cannot be accidentally undone by an
 * older cleanup handle.
 * @param identityId - Transport identity that may authenticate with the secret.
 * @param secret - HMAC secret expected for the identity.
 * @returns Cleanup function that unregisters this exact secret.
 */
export function registerHmacIdentitySecret(identityId: string, secret: string): () => void {
  if (identityId.trim().length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty identityId');
  }
  if (secret.length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty secret');
  }

  identitySecrets.set(identityId, secret);

  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (identitySecrets.get(identityId) === secret) {
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
  return identitySecrets.get(identityId) ?? null;
}

/**
 * Clear all registered identity secrets.
 *
 * Intended for tests that exercise the process-global registry.
 */
export function clearHmacIdentitySecretsForTesting(): void {
  identitySecrets.clear();
}
