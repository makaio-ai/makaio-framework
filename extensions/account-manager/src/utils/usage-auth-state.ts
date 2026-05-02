/**
 * Metadata state used when usage fetches prove the current credential needs re-authentication.
 */
const USAGE_AUTH_STATE_REAUTH_REQUIRED = 'reauth-required';

/**
 * Human-readable account metadata note for invalid usage auth.
 */
const USAGE_AUTH_DISPLAY_TEXT = 'reauth required';

/**
 * Human-readable account metadata note while usage auth is still being established.
 */
const USAGE_AUTH_PENDING_DISPLAY_TEXT = 'reauth pending';

/**
 * Build metadata patches that mark the current credential as invalid for usage fetches.
 * @param fingerprint - Credential fingerprint that produced the auth failure
 * @param message - Human-readable upstream failure reason
 * @param detectedAt - Epoch ms when the failure was observed
 * @returns Metadata patch payload
 */
export function buildUsageAuthInvalidMetadata(
  fingerprint: string,
  message: string,
  detectedAt: number,
): Record<string, unknown> {
  return {
    usageAuthState: USAGE_AUTH_STATE_REAUTH_REQUIRED,
    usageAuthFingerprint: fingerprint,
    usageAuthMessage: message,
    usageAuthDetectedAt: detectedAt,
  };
}

/**
 * Returns whether metadata still marks this exact credential fingerprint as invalid.
 * @param metadata - Account metadata record
 * @param fingerprint - Credential fingerprint to check
 * @returns Whether usage fetches should stay suppressed for this credential
 */
export function isUsageAuthInvalidForFingerprint(metadata: Record<string, unknown>, fingerprint: string): boolean {
  return metadata.usageAuthState === USAGE_AUTH_STATE_REAUTH_REQUIRED && metadata.usageAuthFingerprint === fingerprint;
}

/**
 * Build metadata patches that clear any persisted usage-auth invalid marker.
 * @param metadata - Account metadata record
 * @returns Patch payload, or null when nothing is marked
 */
export function buildUsageAuthClearMetadata(metadata: Record<string, unknown>): Record<string, unknown> | null {
  if (metadata.usageAuthState !== USAGE_AUTH_STATE_REAUTH_REQUIRED) {
    return null;
  }
  return {
    usageAuthState: null,
    usageAuthFingerprint: null,
    usageAuthMessage: null,
    usageAuthDetectedAt: null,
  };
}

/**
 * Returns the compact display text for a usage-auth invalid marker.
 * @param metadata - Account metadata record
 * @returns Display string, or null when no marker is present
 */
export function getUsageAuthDisplayText(metadata: Record<string, unknown>): string | null {
  return metadata.usageAuthState === USAGE_AUTH_STATE_REAUTH_REQUIRED ? USAGE_AUTH_DISPLAY_TEXT : null;
}

/**
 * Returns the compact display text while usage auth is still being established.
 * @param metadata - Account metadata record
 * @param pending - Whether the UI currently has a usage refresh attempt in flight for the account
 * @returns Display string, or null when the account is already resolved
 */
export function getUsageAuthPendingDisplayText(metadata: Record<string, unknown>, pending: boolean): string | null {
  if (!pending) return null;
  return metadata.usageAuthState === USAGE_AUTH_STATE_REAUTH_REQUIRED ? null : USAGE_AUTH_PENDING_DISPLAY_TEXT;
}
