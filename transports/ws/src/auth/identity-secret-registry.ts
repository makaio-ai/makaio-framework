/**
 * Process-local HMAC identity secret registry.
 *
 * Hosts use this registry to publish short-lived identity-bound HMAC secrets
 * before a remote executor connects. The WebSocket auth layer resolves the
 * claimed identity through this registry during the challenge/response flow.
 */

import type { TransportPeerContext } from '@makaio/core';

interface RegisteredHmacIdentitySecret {
  /** HMAC secret expected for this identity. */
  readonly secret: string;
  /** Trusted peer kind exposed after the identity authenticates. */
  readonly peerKind: string;
  /** Optional opaque claims attached to the authenticated peer context. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /**
   * Optional subject restriction set.
   *
   * When present, the server message handler rejects any inbound request or
   * event whose full subject (`namespace.subject`) is not in this set. This
   * provides a transport-level deny-by-default for restricted identities such
   * as bootstrap peers.
   *
   * Stored as a `ReadonlySet` for O(1) membership checks on the hot path.
   */
  readonly allowedSubjects?: ReadonlySet<string>;
}

/** Options for registering an HMAC identity secret. */
export interface HmacIdentitySecretRegistrationOptions {
  /**
   * Trusted peer kind exposed after this identity authenticates.
   */
  readonly peerKind: string;
  /**
   * Opaque claims attached to the authenticated peer context.
   *
   * Bus handlers can read `ctx.transport.peer.claims` to access these values
   * without parsing the identity ID itself.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
  /**
   * Optional subject restriction list for this identity.
   *
   * When provided, the server message handler rejects any inbound request,
   * event, or broadcast whose full subject (`namespace.subject`) is not in
   * this list. Identities without this field are unrestricted.
   *
   * Exact string match only; no wildcard support.
   */
  readonly allowedSubjects?: readonly string[];
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
 * @param options - Trusted peer metadata for this identity.
 * @returns Cleanup function that unregisters this exact secret.
 */
export function registerHmacIdentitySecret(
  identityId: string,
  secret: string,
  options: HmacIdentitySecretRegistrationOptions,
): () => void {
  if (identityId.trim().length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty identityId');
  }
  if (secret.length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty secret');
  }
  const peerKind = options.peerKind.trim();
  if (peerKind.length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty peerKind');
  }
  const registration: RegisteredHmacIdentitySecret = {
    secret,
    peerKind,
    ...(options.claims !== undefined ? { claims: options.claims } : {}),
    ...(options.allowedSubjects !== undefined ? { allowedSubjects: new Set(options.allowedSubjects) } : {}),
  };

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

/** Options for rotating an existing HMAC identity secret. */
export interface HmacIdentitySecretRotationOptions {
  /**
   * Override opaque claims attached to the authenticated peer context.
   *
   * When omitted the existing claims from the current registration are
   * preserved. Provide explicitly to change claims during rotation.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Rotate the HMAC secret for an already-registered transport identity.
 *
 * This is an explicit, intentional operation — it requires an existing
 * registration for `identityId` and replaces the secret atomically. Per-message
 * revalidation in {@link HmacAuth.isSocketAuthenticated} detects the new
 * registration object and fences any socket that authenticated under the
 * previous secret.
 *
 * The returned cleanup removes the entry only when it still points at the
 * rotated registration object, so a stale cleanup from a prior registration
 * cannot accidentally revoke the rotated secret.
 * @param identityId - Transport identity whose secret should be rotated.
 * @param newSecret - Replacement HMAC secret.
 * @param options - Optional claim overrides for the rotated registration.
 * @returns Cleanup function that unregisters this exact rotated secret.
 * @throws Error when no registration exists for `identityId`.
 * @throws Error when `newSecret` is empty.
 */
export function rotateHmacIdentitySecret(
  identityId: string,
  newSecret: string,
  options: HmacIdentitySecretRotationOptions = {},
): () => void {
  if (newSecret.length === 0) {
    throw new Error('rotateHmacIdentitySecret requires a non-empty secret');
  }
  const existing = identitySecrets.get(identityId);
  if (!existing) {
    throw new Error(`Cannot rotate HMAC identity secret: no registration exists for '${identityId}'`);
  }

  const registration: RegisteredHmacIdentitySecret = {
    secret: newSecret,
    peerKind: existing.peerKind,
    ...(options.claims !== undefined
      ? { claims: options.claims }
      : existing.claims !== undefined
        ? { claims: existing.claims }
        : {}),
    ...(existing.allowedSubjects !== undefined ? { allowedSubjects: existing.allowedSubjects } : {}),
  };

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
  return {
    kind: entry.peerKind,
    id: identityId,
    authenticated: true,
    ...(entry.claims !== undefined ? { claims: entry.claims } : {}),
  };
}

/**
 * Resolve the subject restriction set for an identity claim.
 *
 * Returns the allowed subjects set when the identity has a subject
 * restriction, or `null` when the identity is unrestricted or unknown.
 * @param identityId - Claimed transport identity.
 * @returns Allowed subjects set, or null when unrestricted/unknown.
 */
export function resolveHmacIdentityAllowedSubjects(identityId: string): ReadonlySet<string> | null {
  return identitySecrets.get(identityId)?.allowedSubjects ?? null;
}

/**
 * Add exact subjects to an existing restricted HMAC identity without rotating
 * its secret or replacing its peer metadata.
 *
 * The stored set is resolved for every inbound message, so an already
 * authenticated WebSocket observes this update without reconnecting.
 * @param identityId - Registered transport identity to update.
 * @param subjects - Exact full subjects to add to the existing restriction.
 * @throws When the identity is unknown or unrestricted.
 */

/**
 * Clear all registered identity secrets.
 *
 * Intended for tests that exercise the process-global registry.
 */
export function clearHmacIdentitySecretsForTesting(): void {
  identitySecrets.clear();
}
