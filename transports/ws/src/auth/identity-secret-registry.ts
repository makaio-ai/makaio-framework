/**
 * Process-local HMAC identity secret registry.
 *
 * Hosts use this registry to publish short-lived identity-bound HMAC secrets
 * before a remote executor connects. The WebSocket auth layer resolves the
 * claimed identity through this registry during the challenge/response flow.
 */

import type { PayloadFilter, TransportPeerContext } from '@makaio/core';

interface RegisteredHmacIdentitySecret {
  /** HMAC secret expected for this identity. */
  readonly secret: string;
  /** Trusted peer kind exposed after the identity authenticates. */
  readonly peerKind: string;
  /** Optional opaque claims attached to the authenticated peer context. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /**
   * Optional subjects this identity may use for inbound requests and events.
   *
   * Stored as a `ReadonlySet` for O(1) membership checks on the hot path.
   */
  readonly allowedMessageSubjects?: ReadonlySet<string>;
  /**
   * Optional subjects this identity may advertise as subscriptions.
   *
   * Stored as a `ReadonlySet` for O(1) membership checks on the hot path.
   */
  readonly allowedSubscriptionSubjects?: ReadonlySet<string>;
  /** Trusted payload filters enforced on every matching outbound delivery. */
  readonly requiredSubscriptionFilters?: Readonly<Record<string, PayloadFilter>>;
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
   * Optional subjects this identity may use for requests and events.
   *
   * If either directional subject option is provided, an omitted direction is
   * denied by default. Identities without both fields are unrestricted.
   */
  readonly allowedMessageSubjects?: readonly string[];
  /**
   * Optional subjects this identity may advertise as subscriptions.
   *
   * If either directional subject option is provided, an omitted direction is
   * denied by default. Identities without both fields are unrestricted.
   */
  readonly allowedSubscriptionSubjects?: readonly string[];
  /**
   * Trusted payload filters imposed on every matching outbound delivery.
   *
   * Keys must be exact full subjects, never wildcard patterns. These filters
   * are live server metadata, never cached in peer subscription state. Both
   * the current policy and any peer-advertised filter must match.
   */
  readonly requiredSubscriptionFilters?: Readonly<Record<string, PayloadFilter>>;
}

const identitySecrets = new Map<string, RegisteredHmacIdentitySecret>();

/**
 * Freeze a structured-clone policy value before it becomes registry metadata.
 * @param value - Clone-owned policy value to freeze recursively.
 * @returns The immutable policy value.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Snapshot immutable server-owned subscription filters for one registration.
 * @param filters - Trusted filter policy supplied by the registering host.
 * @returns A detached, deeply frozen policy map.
 */
function snapshotRequiredSubscriptionFilters(
  filters: Readonly<Record<string, PayloadFilter>>,
): Readonly<Record<string, PayloadFilter>> {
  const snapshot = Object.fromEntries(
    Object.entries(filters).map(([subject, filter]) => [subject, deepFreeze(structuredClone(filter))]),
  ) as Record<string, PayloadFilter>;
  return Object.freeze(snapshot);
}

/**
 * Create an idempotent cleanup handle for one exact registry generation.
 *
 * A newer registration for the same identity remains intact when an older
 * handle is released after a rotation or service recomposition.
 * @param identityId - Transport identity that owns this registration generation.
 * @param registration - Exact registry entry this cleanup is fenced to.
 * @returns Idempotent cleanup for this registration generation.
 */
function createRegistrationCleanup(identityId: string, registration: RegisteredHmacIdentitySecret): () => void {
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
  if ('allowedSubjects' in (options as object)) {
    throw new Error(
      'registerHmacIdentitySecret no longer accepts allowedSubjects; use allowedMessageSubjects and/or allowedSubscriptionSubjects',
    );
  }
  const peerKind = options.peerKind.trim();
  if (peerKind.length === 0) {
    throw new Error('registerHmacIdentitySecret requires a non-empty peerKind');
  }
  const hasDirectionalSubjectRestrictions =
    options.allowedMessageSubjects !== undefined || options.allowedSubscriptionSubjects !== undefined;
  if (options.requiredSubscriptionFilters !== undefined) {
    for (const subject of Object.keys(options.requiredSubscriptionFilters)) {
      if (subject.includes('*')) {
        throw new Error('registerHmacIdentitySecret requires exact full subjects for requiredSubscriptionFilters');
      }
    }
  }
  const registration: RegisteredHmacIdentitySecret = {
    secret,
    peerKind,
    ...(options.claims !== undefined ? { claims: options.claims } : {}),
    ...(hasDirectionalSubjectRestrictions
      ? {
          allowedMessageSubjects: new Set(options.allowedMessageSubjects ?? []),
          allowedSubscriptionSubjects: new Set(options.allowedSubscriptionSubjects ?? []),
        }
      : {}),
    ...(options.requiredSubscriptionFilters !== undefined
      ? {
          requiredSubscriptionFilters: snapshotRequiredSubscriptionFilters(options.requiredSubscriptionFilters),
        }
      : {}),
  };

  identitySecrets.set(identityId, registration);
  return createRegistrationCleanup(identityId, registration);
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
    ...(existing.allowedMessageSubjects !== undefined
      ? { allowedMessageSubjects: existing.allowedMessageSubjects }
      : {}),
    ...(existing.allowedSubscriptionSubjects !== undefined
      ? { allowedSubscriptionSubjects: existing.allowedSubscriptionSubjects }
      : {}),
    ...(existing.requiredSubscriptionFilters !== undefined
      ? { requiredSubscriptionFilters: existing.requiredSubscriptionFilters }
      : {}),
  };

  identitySecrets.set(identityId, registration);
  return createRegistrationCleanup(identityId, registration);
}

/**
 * Capture a cleanup handle for the current registration of an identity.
 *
 * The returned handle is bound to the registration object that exists at
 * capture time. Invoking it removes that registration only if it is still
 * current, so it cannot revoke a secret installed by a later rotation or
 * service recomposition. The secret itself is never exposed.
 * @param identityId - Transport identity whose current registration to capture.
 * @returns A generation-fenced cleanup handle, or undefined when unknown.
 */
export function captureHmacIdentitySecretCleanup(identityId: string): (() => void) | undefined {
  const registration = identitySecrets.get(identityId);
  return registration === undefined ? undefined : createRegistrationCleanup(identityId, registration);
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
 * Resolve the message subject restriction set for an identity claim.
 *
 * Returns the allowed message subjects set when the identity has a subject
 * restriction, or `null` when the identity is unrestricted or unknown.
 * @param identityId - Claimed transport identity.
 * @returns Allowed message subjects set, or null when unrestricted/unknown.
 */
export function resolveHmacIdentityAllowedMessageSubjects(identityId: string): ReadonlySet<string> | null {
  return identitySecrets.get(identityId)?.allowedMessageSubjects ?? null;
}

/**
 * Resolve the subscription subject restriction set for an identity claim.
 *
 * Returns the allowed subscription subjects set when the identity has a
 * subject restriction, or `null` when the identity is unrestricted or unknown.
 * @param identityId - Claimed transport identity.
 * @returns Allowed subscription subjects set, or null when unrestricted/unknown.
 */
export function resolveHmacIdentityAllowedSubscriptionSubjects(identityId: string): ReadonlySet<string> | null {
  return identitySecrets.get(identityId)?.allowedSubscriptionSubjects ?? null;
}

/**
 * Resolve server-owned filters enforced for one identity's subscriptions.
 *
 * Returns `null` when the identity is unknown or has no enforced filters.
 * @param identityId - Claimed transport identity.
 * @returns Immutable filter map, or null when no policy is registered.
 */
export function resolveHmacIdentityRequiredSubscriptionFilters(
  identityId: string,
): Readonly<Record<string, PayloadFilter>> | null {
  return identitySecrets.get(identityId)?.requiredSubscriptionFilters ?? null;
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
