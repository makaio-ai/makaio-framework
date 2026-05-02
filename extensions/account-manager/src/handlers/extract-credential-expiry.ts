interface CredentialExpiryEnvelope {
  readonly expiresAt?: unknown;
  readonly claudeAiOauth?: {
    readonly expiresAt?: unknown;
  };
}

/**
 * Extracts the `expiresAt` epoch-ms value from a raw credential token string.
 *
 * Handles the `claudeAiOauth` envelope format where the token JSON contains a
 * nested `claudeAiOauth` object that holds the authoritative OAuth fields.
 * When the envelope is present, its `expiresAt` is preferred; otherwise the
 * top-level `expiresAt` is used.
 *
 * Returns `null` when:
 * - The token cannot be parsed as JSON
 * - No `expiresAt` field is present at any level
 * - The `expiresAt` value is not a finite number
 *
 * A `null` return means "no expiry information" — callers should treat such
 * tokens as valid (e.g. Codex API-key tokens that never expire).
 * @param token - The full credential token string (`RawCredential.token`)
 * @returns The `expiresAt` epoch-ms value, or `null`
 */
export function extractCredentialExpiry(token: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as CredentialExpiryEnvelope;
  const candidate = obj.claudeAiOauth?.expiresAt ?? obj.expiresAt;

  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}
