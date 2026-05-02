const ACCOUNT_MANAGER_METADATA_KEYS = [
  'usageAuthState',
  'usageAuthFingerprint',
  'usageAuthMessage',
  'usageAuthDetectedAt',
] as const;

/** Identity-bearing fields whose change indicates the account owner switched. */
const IDENTITY_KEYS = ['email', 'name', 'organization'] as const;

/**
 * Result of a metadata merge that also tracks whether identity-bearing fields changed.
 */
export interface MergeResult {
  /** The merged metadata, equivalent to {@link mergeSourceAccountMetadata} output. */
  metadata: Record<string, unknown>;
  /**
   * `true` only when at least one identity field (email, name, or organization)
   * existed in both the prior metadata and the incoming source metadata but holds
   * a different value. New accounts or first-time population always yield `false`.
   */
  identityChanged: boolean;
}

/**
 * Strip account-manager-owned overlay keys from source-owned metadata.
 * @param sourceMetadata - Raw metadata emitted by the credential source.
 * @returns Source metadata without reserved overlay keys.
 */
export function sanitizeSourceAccountMetadata(sourceMetadata: Record<string, unknown>): Record<string, unknown> {
  const sanitizedSourceMetadata = { ...sourceMetadata };
  for (const key of ACCOUNT_MANAGER_METADATA_KEYS) {
    delete sanitizedSourceMetadata[key];
  }
  return sanitizedSourceMetadata;
}

/**
 * Merges source-owned account metadata with account-manager-owned overlay keys.
 *
 * Public account metadata intentionally carries both upstream source details
 * (plan type, auth mode, rate-limit tier) and local account-manager overlays
 * such as persisted usage-auth suppression state. Poll-driven credential
 * refreshes must update the source-owned portion without wiping the local
 * overlay.
 * @param existingMetadata - Currently stored public metadata for the account
 * @param sourceMetadata - Fresh metadata emitted by the credential source
 * @returns Fresh source metadata plus preserved account-manager overlay keys
 */
export function mergeSourceAccountMetadata(
  existingMetadata: Record<string, unknown>,
  sourceMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const sanitizedSourceMetadata = sanitizeSourceAccountMetadata(sourceMetadata);
  return mergeSanitizedSourceAccountMetadata(existingMetadata, sanitizedSourceMetadata);
}

/**
 * Merges already-sanitized source metadata with preserved account-manager overlay keys.
 * @param existingMetadata - Currently stored public metadata for the account.
 * @param sanitizedSourceMetadata - Source metadata with account-manager overlay keys removed.
 * @returns Fresh source metadata plus preserved account-manager overlay keys.
 */
function mergeSanitizedSourceAccountMetadata(
  existingMetadata: Record<string, unknown>,
  sanitizedSourceMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const preservedOverlay = ACCOUNT_MANAGER_METADATA_KEYS.reduce<Record<string, unknown>>((overlay, key) => {
    if (key in existingMetadata) {
      overlay[key] = existingMetadata[key];
    }
    return overlay;
  }, {});
  return {
    ...sanitizedSourceMetadata,
    ...preservedOverlay,
  };
}

/**
 * Merges source-owned account metadata with account-manager overlay keys and
 * reports whether identity-bearing fields changed.
 *
 * Identity change is only reported when a field existed in both the prior
 * metadata and the incoming sanitized source metadata but holds a different
 * value. New accounts (empty existing metadata) and first-time field
 * population do **not** trigger `identityChanged`.
 * @param existingMetadata - Currently stored public metadata for the account.
 * @param sourceMetadata - Fresh metadata emitted by the credential source.
 * @returns Merged metadata and a flag indicating whether identity fields changed.
 */
export function mergeSourceAccountMetadataWithIdentityCheck(
  existingMetadata: Record<string, unknown>,
  sourceMetadata: Record<string, unknown>,
): MergeResult {
  const sanitized = sanitizeSourceAccountMetadata(sourceMetadata);
  const metadata = mergeSanitizedSourceAccountMetadata(existingMetadata, sanitized);
  const identityChanged = IDENTITY_KEYS.some((key) => {
    const oldVal = existingMetadata[key];
    const newVal = sanitized[key];
    return newVal !== undefined && oldVal !== undefined && oldVal !== newVal;
  });
  return { metadata, identityChanged };
}
