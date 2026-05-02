/**
 * Raw credential data read from a client's native storage.
 *
 * Contains the full token payload — never leaves the package boundary.
 */
export interface RawCredential {
  /** Full credential payload (the entire JSON or token string) */
  token: string;
  /** Deduplication key derived from the credential payload (e.g., SHA-256 of refresh token or `accountUuid:orgUuid`). Not the stable account identity — that is `StoredAccount.id`. */
  fingerprint: string;
  /** Client-specific metadata (subscription type, rate limit tier, etc.) */
  metadata: Record<string, unknown>;
}

/**
 * Result of asking a source to refresh a credential before activation.
 *
 * Four-way semantics:
 * - `unchanged`: the access token is still valid; no refresh was needed.
 * - `refreshed`: the access token was successfully renewed; use the returned
 *   credential going forward.
 * - `failed`: the credential is **definitively invalid** (e.g. 401/403 from
 *   the OAuth endpoint, revoked refresh token, or missing structural fields
 *   required for the exchange). The caller should treat the stored account as
 *   a zombie and remove it.
 * - `transient`: the refresh attempt failed due to a **temporary** condition
 *   (HTTP 5xx, network timeout, DNS failure). The credential may still be
 *   valid — the caller must not delete it, but should proceed with the
 *   existing credential and retry on the next activation cycle.
 */
export type CredentialRefreshResult =
  | { status: 'unchanged' }
  | { status: 'refreshed'; credential: RawCredential }
  | { status: 'failed'; reason: string }
  | { status: 'transient'; reason: string };

/**
 * Options for {@link ICredentialSource.refreshIfNeeded}.
 */
export interface CredentialRefreshOptions {
  /**
   * When `true`, bypass the local `expiresAt` guard and attempt a token
   * refresh unconditionally. Used when the upstream API has already rejected
   * the access token (401/403) even though `expiresAt` is still in the future
   * — e.g. a server-side session revocation or org-level reauth requirement.
   */
  force?: boolean;
}

/**
 * Reads and writes a specific client's native credential storage.
 *
 * Each source knows where the client stores credentials and how to parse them.
 * Implementations are platform-aware (macOS keychain vs filesystem).
 */
export interface ICredentialSource {
  /** Stable client identifier, e.g. 'claude-code', 'codex' */
  readonly clientId: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Whether this source's credential location exists on the current machine */
  isAvailable(): Promise<boolean>;
  /** Read the current credential from the client's native location */
  read(): Promise<RawCredential | null>;
  /** Write a credential back to the client's native location */
  write(credential: RawCredential): Promise<void>;
  /**
   * Optional configuration issue probe for the source's native installation.
   *
   * Sources that need user-visible setup guidance surface it here so the
   * service can expose the issue without duplicating tool-specific path logic.
   * @returns A user-facing issue/action pair, or null when configuration is valid
   */
  getConfigIssue?(): Promise<{ reason: string; action: string } | null>;
  /**
   * Optional source-owned configuration action.
   *
   * This keeps tool-specific config ownership inside the source instead of
   * splitting path logic between the source and service layer.
   */
  configureFileMode?(): Promise<void>;
  /**
   * Extracts a stable credential key from the raw token string for deduplication.
   *
   * Sources whose fingerprint is inherently stable across process restarts do not
   * need this method — their {@link read} fingerprint is already the canonical
   * deduplication key. Sources whose fingerprint can change format across process
   * restarts (e.g. due to external dependencies like profile endpoints) implement
   * this to provide a secondary key derived from the credential payload so the
   * tracker can match a "new" fingerprint against existing stored accounts before
   * creating a duplicate.
   *
   * Return `null` when the token cannot be parsed or has no extractable key.
   * @param rawToken - The full credential token string (same as `RawCredential.token`)
   * @returns A stable key string, or null
   */
  extractCredentialKey?(rawToken: string): string | null;
  /**
   * Returns whether a stored account may legitimately have a persisted
   * fingerprint that differs from the key extracted from its stored credential.
   *
   * The default is strict (`false`): for sources whose fingerprint is already
   * the credential key, a mismatch means the stored credential bytes no longer
   * describe the stored account identity. Sources with a real format transition
   * seam (for example profile-derived UUID fingerprints with refresh-token hash
   * recovery) can opt in for the specific transition they own.
   * @param params - Candidate reconciliation values from the tracker
   * @returns `true` when the source can prove this mismatch is an expected
   *   fingerprint-format transition rather than stored-token corruption
   */
  allowsCredentialKeyFingerprintMismatch?(params: {
    accountFingerprint: string;
    storedCredentialKey: string;
    incomingFingerprint: string;
    incomingCredentialKey: string;
  }): boolean;
  /**
   * Refreshes the credential's access token if it has expired or is about
   * to expire.
   *
   * The source owns the OAuth refresh flow (endpoint, client ID, scopes,
   * expiry buffer). The caller owns coordination (re-reading the native
   * store before calling this to avoid racing the native CLI's own refresh).
   * @param credential - The credential to check and potentially refresh
   * @param options - Optional refresh behavior overrides
   * @returns A discriminated result so callers can distinguish "no refresh
   *   needed" from "refresh attempt failed". Activation must not write a
   *   known-stale credential after a timeout or 5xx from the source-owned
   *   refresh endpoint.
   */
  refreshIfNeeded?(credential: RawCredential, options?: CredentialRefreshOptions): Promise<CredentialRefreshResult>;
}
