import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executeClaudeCodeNativeCredentialSourceLock } from '@makaio/client-claude-code/runtime';
import { AccountUsageSchema } from '../bus/schemas.js';
import type { AccountUsage } from '../bus/schemas.js';
import type { ICredentialBackend } from '../backends/credential-backend.js';
import type {
  CredentialRefreshOptions,
  CredentialRefreshResult,
  ICredentialSource,
  PreparedNativeCredentialMutation,
  RawCredential,
} from '../interfaces/credential-source.js';
import type { ILabelProvider } from '../interfaces/label-provider.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import type { IUsageProvider, UsageResult } from '../interfaces/usage-provider.js';
import { logAccountManagerDiagnostic } from '../utils/diagnostics.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { formatIdentityLabel } from '../utils/format-account-display.js';
import { mapOAuthErrorToRefreshResult, performOAuthTokenRequest } from '../utils/oauth-token-request.js';
import { parseRetryAfterMs } from '../utils/retry-after.js';
import { logEmptyClaudeUsageWindows, parseClaudeUsageCredits, parseUsageWindow } from './claude-code-usage-parser.js';
import type { ClaudeCodeSourceOptions, OAuthProfile } from './claude-code-source-types.js';
import {
  clearBackendNativeCredential,
  prepareBackendNativeCredentialMutation,
  writeBackendNativeCredential,
} from './native-credential-mutation.js';

export type { ClaudeCodeSourceOptions } from './claude-code-source-types.js';

/** OAuth token endpoint for Claude Code credential refresh. */
const CLAUDE_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

/** OAuth client ID registered for Claude Code. */
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** OAuth scopes requested during token refresh. */
const CLAUDE_OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** Proactive refresh buffer matching Claude CLI's isOAuthTokenExpired (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Timeout for the OAuth refresh request (shorter than CLI's 15s for blocking switch flow). */
const REFRESH_TIMEOUT_MS = 5000;

/**
 * Builds a human-readable description of the token expiry state for refresh logs.
 * @param force - Whether the refresh was forced (e.g. by a reauth-required marker).
 * @param msUntilExpiry - Milliseconds until the token expires (negative = already expired).
 * @returns A short description string suitable for log messages.
 */
function describeTokenExpiry(force: boolean, msUntilExpiry: number): string {
  if (force && msUntilExpiry > 0) return `forced refresh, token expires in ${Math.round(msUntilExpiry / 1000)}s`;
  if (msUntilExpiry > 0) return `token expires in ${Math.round(msUntilExpiry / 1000)}s (within buffer)`;
  return `token expired ${Math.round(-msUntilExpiry / 1000)}s ago`;
}

/**
 * Credential source for Claude Code CLI.
 *
 * Reads and writes credentials by delegating all I/O to a pre-configured
 * {@link ICredentialBackend}. Platform-specific concerns (keychain vs file)
 * are handled entirely by the backend; this class owns only the parsing logic.
 *
 * Account identity uses stable UUIDs from the Anthropic OAuth profile endpoint
 * (`account.uuid:organization.uuid`) so that token rotation does not create
 * duplicate account entries. {@link read} does not fall back to a hash-based
 * fingerprint when profile lookup cannot complete; transient profile-fetch
 * failures (network errors, 5xx) are propagated to the caller so that
 * {@link CredentialTracker.poll} emits `credentials.error` instead of
 * false-deactivating the active account. Auth-invalid usage responses
 * (401/403) throw {@link UsageAuthInvalidError} so the tracker can persist a
 * durable re-auth marker instead of retrying forever.
 *
 * The source still exposes {@link extractCredentialKey} as a secondary dedup
 * seam because refresh and recovery paths can temporarily materialize a
 * refresh-token hash before the next successful profile read restores the
 * UUID-based fingerprint.
 */
export class ClaudeCodeSource implements ICredentialSource, ILabelProvider, IUsageProvider {
  public readonly clientId = 'claude-code';
  public readonly displayName = 'Claude Code';

  /**
   * Cached profile keyed on the `refreshToken` that produced it.
   *
   * Evicts on refreshToken mismatch so a token rotation triggers a fresh
   * profile fetch that still resolves to the same stable UUIDs.
   */
  private profileCache: { refreshToken: string; profile: OAuthProfile } | null = null;

  /**
   * Consecutive HTTP 429 usage responses since the last successful usage fetch.
   *
   * Non-429 failures intentionally do not clear this streak: a 500/401/timeout
   * does not prove the shared source-level rate limit has recovered.
   */
  private usageRateLimitStreak = 0;

  /**
   * @param backend - Pre-configured credential backend for reading/writing.
   * @param options - Optional install-directory override for tests or sandboxed runtimes.
   */
  public constructor(
    private readonly backend: ICredentialBackend,
    private readonly options: ClaudeCodeSourceOptions = {},
  ) {}

  /**
   * Checks whether Claude Code is installed and credentials are accessible.
   *
   * Returns `false` immediately if `~/.claude` does not exist (Claude Code not
   * installed), then delegates to the backend to confirm credentials are present.
   * @returns `true` if the directory exists and the backend returns a value.
   */
  public async isAvailable(): Promise<boolean> {
    if (!existsSync(this.installDir)) return false;
    try {
      const raw = await this.backend.read();
      return raw !== null;
    } catch {
      return false;
    }
  }

  /**
   * Reads and parses the current credential from the backend.
   *
   * Handles two credential formats emitted by Claude Code:
   * - **Flat** (file-backed, tests): `{"refreshToken": "...", ...}`
   * - **Enveloped** (macOS keychain): `{"claudeAiOauth": {"refreshToken": "...", ...}}`
   *
   * The `claudeAiOauth` envelope is unwrapped before field extraction so that
   * {@link extractMetadata} and fingerprinting work identically for both formats.
   *
   * The fingerprint is derived from the Anthropic OAuth profile endpoint, yielding
   * a stable `accountUuid:orgUuid` composite that survives token rotation.
   * @returns The parsed credential, or `null` if not found, unparseable, or
   *   the profile response is non-OK (e.g. 401 for an expired token).
   * @throws On transient network failures (timeout, DNS) so that
   *   {@link CredentialTracker.poll} emits `credentials.error` instead of
   *   treating a reachable credential as disappeared.
   */
  public async read(): Promise<RawCredential | null> {
    const raw = await this.backend.read();
    if (!raw) return null;

    const parsed = this.unwrapCredentialPayload(raw);
    if (!parsed) return null;
    const refreshToken = parsed['refreshToken'];
    if (typeof refreshToken !== 'string') return null;

    const accessToken = parsed['accessToken'];
    // fetchProfile throws on transient network failures (timeout, DNS) so the
    // error propagates to poll()'s catch → credentials.error instead of
    // deactivating the active account. Non-OK responses (e.g. 401) return null.
    const profile = typeof accessToken === 'string' ? await this.fetchProfile(accessToken, refreshToken) : null;
    if (!profile) return null;

    const fingerprint = `${profile.accountUuid}:${profile.orgUuid}`;

    return {
      token: raw,
      fingerprint,
      metadata: this.extractMetadata(parsed, profile),
    };
  }

  /**
   * Writes a credential back via the backend.
   * @param credential - The credential to persist.
   */
  public async write(credential: RawCredential): Promise<void> {
    await writeBackendNativeCredential(this.clientId, this.installDir, this.backend, credential, (operation) =>
      executeClaudeCodeNativeCredentialSourceLock(this.installDir, operation),
    );
  }

  /** Remove Claude Code credentials through the configured backend. */
  public async clear(): Promise<void> {
    await clearBackendNativeCredential(this.clientId, this.installDir, this.backend, (operation) =>
      executeClaudeCodeNativeCredentialSourceLock(this.installDir, operation),
    );
  }

  /**
   * Prepare an atomic native write with source-owned generation rollback.
   * @param credential - Target credential to materialize.
   * @returns Prepared mutation whose rollback never overwrites a newer refresh.
   */
  public async prepareNativeCredentialMutation(credential: RawCredential): Promise<PreparedNativeCredentialMutation> {
    return prepareBackendNativeCredentialMutation(
      this.clientId,
      this.installDir,
      this.backend,
      credential,
      (operation) => executeClaudeCodeNativeCredentialSourceLock(this.installDir, operation),
    );
  }

  /**
   * Canonical Claude Code config home that owns this source's credentials.
   * @returns Config directory used as the shared credential lock identity.
   */
  private get installDir(): string {
    return this.options.installDir ?? join(homedir(), '.claude');
  }

  /**
   * Extracts a stable credential key from the raw token string.
   *
   * This remains the reconciliation key even though {@link read} no longer
   * falls back to hash fingerprints. Refresh and startup-recovery paths can
   * still carry a refresh-token hash until a later profile fetch succeeds, so
   * the tracker needs a source-owned key to prove those credentials belong to
   * the same account instead of creating a duplicate row.
   * @param rawToken - The full credential token string.
   * @returns The refresh-token hash, or null when the payload is unusable.
   */
  public extractCredentialKey(rawToken: string): string | null {
    const parsed = this.unwrapCredentialPayload(rawToken);
    if (!parsed) return null;

    const refreshToken = parsed['refreshToken'];
    if (typeof refreshToken !== 'string') return null;

    return computeFingerprint(refreshToken);
  }

  /**
   * Allows the source-owned profile-fingerprint → refresh-token-hash transition.
   *
   * Claude Code normally fingerprints accounts as `accountUuid:orgUuid`, while
   * refresh/recovery paths can temporarily carry the refresh-token hash returned
   * by {@link extractCredentialKey}. The tracker may reconcile that transition
   * when the incoming fingerprint is either the same profile-derived
   * fingerprint or the temporary hash key, and the stored account still has
   * the profile-derived fingerprint shape.
   * @param params - Candidate reconciliation values from the tracker.
   * @returns Whether the mismatch is a Claude-owned fingerprint-format transition.
   */
  public allowsCredentialKeyFingerprintMismatch(params: {
    accountFingerprint: string;
    storedCredentialKey: string;
    incomingFingerprint: string;
    incomingCredentialKey: string;
  }): boolean {
    const { accountFingerprint, storedCredentialKey, incomingFingerprint, incomingCredentialKey } = params;
    const fingerprintParts = accountFingerprint.split(':');
    const isProfileFingerprint = fingerprintParts.length === 2 && fingerprintParts.every((part) => part.length > 0);
    return (
      isProfileFingerprint &&
      storedCredentialKey === incomingCredentialKey &&
      (incomingFingerprint === accountFingerprint || incomingFingerprint === storedCredentialKey)
    );
  }

  /**
   * Extracts display-relevant metadata from the credential JSON.
   * @param parsed - The parsed credential object.
   * @param profile - Stable profile identity resolved from the OAuth API.
   * @returns Metadata record with known fields.
   */
  private extractMetadata(parsed: Record<string, unknown>, profile?: OAuthProfile): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    const subscriptionType = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined;
    if (subscriptionType) {
      metadata.subscriptionType = subscriptionType;
      metadata.planType = subscriptionType;
    }
    if (typeof parsed.rateLimitTier === 'string') metadata.rateLimitTier = parsed.rateLimitTier;
    if (typeof parsed.scopes === 'string') metadata.scopes = parsed.scopes;
    if (profile) {
      metadata.accountUuid = profile.accountUuid;
      metadata.orgUuid = profile.orgUuid;
      if (profile.email) metadata.email = profile.email;
      if (profile.orgName) metadata.organization = profile.orgName;
    }
    return metadata;
  }

  /**
   * Parses the credential JSON and returns both the top-level object and the
   * unwrapped inner payload.
   *
   * When the `claudeAiOauth` envelope is present, `inner` is the envelope
   * contents and `top` is the full JSON; otherwise both reference the same
   * object. Shared between {@link refreshIfNeeded} (which needs both levels
   * for envelope-preserving patches) and {@link unwrapCredentialPayload}
   * (which only needs the inner payload).
   * @param raw - Raw JSON string from the credential backend
   * @returns Parsed top and inner objects, or null if unparseable
   */
  private parseCredentialLevels(raw: string): { top: Record<string, unknown>; inner: Record<string, unknown> } | null {
    try {
      const top = JSON.parse(raw) as Record<string, unknown>;
      const envelope = top['claudeAiOauth'];
      const inner =
        envelope !== undefined && typeof envelope === 'object' && envelope !== null
          ? (envelope as Record<string, unknown>)
          : top;
      return { top, inner };
    } catch {
      return null;
    }
  }

  /**
   * Parse a raw credential JSON string and unwrap the `claudeAiOauth` envelope
   * when present. Shared between {@link read} and {@link resolveUsage} so the
   * two-format handling stays in sync as token shapes evolve.
   * @param raw - Raw JSON string from the credential backend.
   * @returns The parsed credential payload, or null if unparseable.
   */
  private unwrapCredentialPayload(raw: string): Record<string, unknown> | null {
    return this.parseCredentialLevels(raw)?.inner ?? null;
  }

  /**
   * Fetches current usage data for the account identified by the credential.
   *
   * Extracts an OAuth access token from the credential and calls the Anthropic
   * usage API.
   * @param credential - The credential whose usage should be fetched.
   * @returns A usage result wrapping the snapshot, or null on transient failures.
   * @throws UsageAuthInvalidError when the credential is structurally unable
   *   to fetch usage (unparseable payload or missing accessToken).
   */
  public async resolveUsage(credential: RawCredential): Promise<UsageResult | null> {
    const parsed = this.unwrapCredentialPayload(credential.token);
    if (!parsed) {
      throw new UsageAuthInvalidError('Claude Code credential payload is not parseable');
    }
    const accessToken = parsed['accessToken'];
    if (typeof accessToken !== 'string') {
      throw new UsageAuthInvalidError('Claude Code credential has no accessToken for usage tracking');
    }
    const usage = await this.fetchClaudeUsage(accessToken);
    if (!usage) return null;
    return { usage };
  }

  /**
   * Resolves a human-readable label for a Claude Code account.
   *
   * Uses the cached OAuth profile from the most recent {@link read} call.
   * If no cached profile is available (offline during the last read),
   * performs a fresh profile fetch.
   * @param credential - The credential whose label should be resolved.
   * @returns A display label (`"org (email)"`, `"email"`, or `"org"`), or
   *   `null` when the profile endpoint is unreachable or the credential
   *   lacks an access token.
   */
  public async resolveLabel(credential: RawCredential): Promise<string | null> {
    const parsed = this.unwrapCredentialPayload(credential.token);
    if (!parsed) return null;

    const refreshToken = parsed['refreshToken'];
    const accessToken = parsed['accessToken'];
    if (typeof refreshToken !== 'string' || typeof accessToken !== 'string') return null;

    let profile: OAuthProfile | null;
    try {
      profile = await this.fetchProfile(accessToken, refreshToken);
    } catch {
      return null;
    }
    if (!profile) return null;

    const { orgName, email } = profile;
    return formatIdentityLabel(orgName, email);
  }

  /**
   * Refreshes the credential's access token if it has expired or is about
   * to expire.
   *
   * The source owns the OAuth refresh flow (endpoint, client ID, scopes, and
   * the 5-minute expiry buffer that matches Claude CLI's `isOAuthTokenExpired`).
   * The caller owns coordination: re-read the native store before calling this
   * method to adopt any token the native CLI already refreshed, avoiding a
   * redundant refresh round-trip.
   *
   * Claude CLI uses `proper-lockfile` on `~/.claude/` for multi-process refresh
   * coordination (`auth.ts:1491`). We avoid that dependency by having the caller
   * re-read the keychain before invoking this method (see `activateAccount`).
   * If the CLI refreshed between the store read and the re-read, the CLI's fresh
   * token is adopted and this method is never called.
   * @param credential - The credential to check and potentially refresh.
   * @param options - Optional refresh behavior overrides (e.g. force bypass of expiresAt guard)
   * @returns A discriminated result so the caller can abort activation when an
   *   attempted refresh fails, instead of writing a known-stale credential.
   */
  public async refreshIfNeeded(
    credential: RawCredential,
    options?: CredentialRefreshOptions,
  ): Promise<CredentialRefreshResult> {
    const levels = this.parseCredentialLevels(credential.token);
    if (!levels) return { status: 'unchanged' };

    const refreshToken = levels.inner['refreshToken'];
    if (typeof refreshToken !== 'string') return { status: 'unchanged' };

    const force = options?.force ?? false;
    const expiresAtRaw = levels.inner['expiresAt'];
    const expiresAt = typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) ? expiresAtRaw : null;
    if (!force && expiresAt === null) return { status: 'unchanged' };

    const now = Date.now();
    const tokenStillValid = !force && expiresAt !== null && now + EXPIRY_BUFFER_MS < expiresAt;
    if (tokenStillValid) {
      const remainingMs = expiresAt! - now - EXPIRY_BUFFER_MS;
      console.info(
        `[ClaudeCodeSource] ${new Date().toISOString()} refreshIfNeeded skipped: token still valid for ${Math.round(remainingMs / 1000)}s (force=${force})`,
      );
      return { status: 'unchanged' };
    }

    const expiryDesc = expiresAt !== null ? describeTokenExpiry(force, expiresAt - now) : 'no expiresAt present';
    console.info(
      `[ClaudeCodeSource] ${new Date().toISOString()} refreshIfNeeded: ${expiryDesc}, attempting OAuth refresh`,
    );

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: CLAUDE_OAUTH_SCOPES,
    });

    logAccountManagerDiagnostic('ClaudeCodeSource', 'refreshIfNeeded -> POST /v1/oauth/token');
    const result = await performOAuthTokenRequest(CLAUDE_TOKEN_ENDPOINT, body, { timeoutMs: REFRESH_TIMEOUT_MS });

    if (result.status !== 'ok') {
      console.warn(
        `[ClaudeCodeSource] ${new Date().toISOString()} refreshIfNeeded: OAuth ${result.status} — ${result.reason}`,
      );
      return mapOAuthErrorToRefreshResult(result, 'ClaudeCodeSource refresh');
    }

    const { data } = result;
    const newAccessToken = data['access_token'];
    const newRefreshToken = data['refresh_token'];
    const expiresIn = data['expires_in'];

    if (typeof newAccessToken !== 'string' || typeof newRefreshToken !== 'string') {
      return { status: 'failed', reason: 'Claude OAuth refresh returned an invalid token payload' };
    }
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      return { status: 'failed', reason: 'Claude OAuth refresh returned an invalid expiry payload' };
    }

    const newExpiresAt = Date.now() + expiresIn * 1000;

    // Patch the refreshed fields back into the original credential JSON,
    // preserving whichever envelope format (flat or claudeAiOauth) was present.
    // Mutating levels.inner is safe because parseCredentialLevels just parsed
    // a fresh object. When enveloped, levels.inner IS levels.top['claudeAiOauth']
    // (same reference), so JSON.stringify(levels.top) captures the mutations.
    levels.inner['accessToken'] = newAccessToken;
    levels.inner['refreshToken'] = newRefreshToken;
    levels.inner['expiresAt'] = newExpiresAt;

    const newToken = JSON.stringify(levels.top);

    // Use hash fingerprint for the (possibly rotated) refresh token.
    // Profile-based fingerprint is not fetched here — the caller triggers a
    // full read() cycle after writing the refreshed credential back. If that
    // read() succeeds, the UUID fingerprint replaces this temporary hash; if
    // the profile endpoint is unreachable, read() returns null and the poll
    // retries on the next cycle.
    const fingerprint = computeFingerprint(newRefreshToken);

    // Re-extract metadata from the already-mutated inner payload so planType /
    // rateLimitTier reflect the refreshed credential shape.
    const metadata = this.extractMetadata(
      levels.inner,
      this.profileCache?.refreshToken === refreshToken ? this.profileCache.profile : undefined,
    );

    console.info(
      `[ClaudeCodeSource] ${new Date().toISOString()} refreshIfNeeded: OAuth refresh succeeded, new token expires in ${expiresIn}s`,
    );
    return {
      status: 'refreshed',
      credential: { token: newToken, fingerprint, metadata },
    };
  }

  /**
   * Fetches live usage data from the Anthropic OAuth usage endpoint.
   *
   * Uses a 3 s AbortController timeout to prevent hanging on network issues.
   * Maps the API response to the canonical {@link AccountUsage} shape.
   * @param accessToken - The Claude OAuth access token.
   * @returns A usage snapshot, or null on transient/non-auth failures.
   * @throws RateLimitedError on HTTP 429, with exponential backoff duration.
   * @throws UsageAuthInvalidError on HTTP 401/403.
   */
  private async fetchClaudeUsage(accessToken: string): Promise<AccountUsage | null> {
    try {
      logAccountManagerDiagnostic('ClaudeCodeSource', 'fetchClaudeUsage -> GET /api/oauth/usage');
      const response = await fetchWithTimeout(
        'https://api.anthropic.com/api/oauth/usage',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            Accept: 'application/json',
          },
        },
        3000,
      );
      if (response.status === 429) {
        // Per-source streak: the Anthropic rate limit is IP/token-scoped, so
        // all accounts share the same budget. Only a successful usage response
        // clears the streak; non-429 failures do not prove the limit recovered.
        this.usageRateLimitStreak++;
        const retryAfterHeader = response.headers.get('Retry-After');
        const headerMs = parseRetryAfterMs(retryAfterHeader, Date.now());
        const backoffMs = Math.min(60_000 * Math.pow(2, this.usageRateLimitStreak - 1), 10 * 60_000);
        const retryAfterMs = Math.max(headerMs, backoffMs);
        logAccountManagerDiagnostic(
          'ClaudeCodeSource',
          `fetchClaudeUsage - 429 | retry-after: ${retryAfterHeader ?? 'absent'} (${headerMs}ms)` +
            ` | streak: ${this.usageRateLimitStreak}, effective cooldown: ${retryAfterMs}ms`,
        );
        throw new RateLimitedError(retryAfterMs);
      }
      if (response.status === 401 || response.status === 403) {
        throw new UsageAuthInvalidError(
          `Claude usage fetch failed with HTTP ${response.status} ${response.statusText}`,
        );
      }
      // Non-429/non-auth errors do not reset the streak; only a successful usage response proves recovery.
      if (!response.ok) {
        console.error(
          `[ClaudeCodeSource] ${new Date().toISOString()} fetchClaudeUsage — HTTP ${response.status} ${response.statusText}`,
        );
        return null;
      }
      // Any successful usage response proves the source is no longer rate-limited.
      this.usageRateLimitStreak = 0;
      logAccountManagerDiagnostic('ClaudeCodeSource', `fetchClaudeUsage <- ${response.status} OK`);
      const data = (await response.json()) as Record<string, unknown>;
      const windows: AccountUsage['windows'] = [];
      // Fail fast on malformed known windows so we do not under-report blocking.
      const windowDefs = [
        { key: 'five_hour', id: '5h', label: '5 Hour', group: 'overall', windowSeconds: 18000 },
        { key: 'seven_day', id: '7d', label: '7 Day', group: 'overall', windowSeconds: 604800 },
        { key: 'seven_day_sonnet', id: '7d-sonnet', label: 'Sonnet (7 Day)', group: 'model', windowSeconds: 604800 },
      ] as const;
      for (const def of windowDefs) {
        const rawWindow = data[def.key] as Record<string, unknown> | null | undefined;
        if (rawWindow == null) continue;
        const win = parseUsageWindow(rawWindow, def.id, def.label, def.group, def.windowSeconds);
        if (!win) return null;
        windows.push(win);
      }
      if (windows.length === 0) logEmptyClaudeUsageWindows(data);
      const blocked = windows.some((w) => w.utilization >= 100);
      const credits = parseClaudeUsageCredits(data);
      // Validate the fully constructed object against the canonical schema so range/type constraints stay centralized.
      const result = AccountUsageSchema.safeParse({ fetchedAt: Date.now(), windows, blocked, credits });
      return result.success ? result.data : null;
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      if (err instanceof UsageAuthInvalidError) throw err;
      console.error(
        `[ClaudeCodeSource] ${new Date().toISOString()} fetchClaudeUsage failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Fetches the OAuth profile from the Anthropic profile endpoint.
   *
   * Results are cached keyed on the `refreshToken` so that repeated calls
   * within the same token lifecycle (read, resolveLabel, resolveUsage) do not
   * issue redundant network requests. The cache evicts on `refreshToken`
   * mismatch so a token rotation triggers a fresh fetch that resolves to the
   * same stable account/org UUIDs.
   * @param accessToken - The OAuth access token for the API call.
   * @param refreshToken - The current refresh token, used as the cache key.
   * @returns The profile, or null if the response is non-OK or malformed.
   * @throws On transient network failures (timeout, DNS, connection refused)
   *   so that callers can distinguish "credential structurally absent" from
   *   "profile endpoint temporarily unreachable".
   */
  private async fetchProfile(accessToken: string, refreshToken: string): Promise<OAuthProfile | null> {
    // No in-flight dedup needed: CredentialTracker.poll() serializes read()
    // calls via a polling guard, and LabelResolver only runs after the
    // credential event is emitted and awaited — so the cache is always warm
    // by the time resolveLabel() reaches here.
    //
    // Cache is keyed on refreshToken (not on stable UUIDs) so that a fresh
    // login as a different user triggers a re-fetch rather than reusing the
    // previous user's cached identity.
    if (this.profileCache && this.profileCache.refreshToken === refreshToken) {
      return this.profileCache.profile;
    }

    logAccountManagerDiagnostic('ClaudeCodeSource', 'fetchProfile -> GET /api/oauth/profile');
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/api/oauth/profile',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
      },
      3000,
    );
    if (!response.ok) {
      logAccountManagerDiagnostic('ClaudeCodeSource', `fetchProfile <- HTTP ${response.status} ${response.statusText}`);
      if (response.status === 401 || response.status === 403) return null;
      throw new Error(`Profile fetch failed with HTTP ${response.status} ${response.statusText}`);
    }
    logAccountManagerDiagnostic('ClaudeCodeSource', `fetchProfile <- ${response.status} OK`);

    const data = (await response.json()) as Record<string, unknown>;
    const account = data['account'] as Record<string, unknown> | undefined;
    const org = data['organization'] as Record<string, unknown> | undefined;

    const accountUuid = account?.['uuid'];
    const orgUuid = org?.['uuid'];
    if (typeof accountUuid !== 'string' || typeof orgUuid !== 'string') return null;

    const profile: OAuthProfile = {
      accountUuid,
      orgUuid,
      orgName: typeof org?.['name'] === 'string' ? (org['name'] as string) : null,
      email: typeof account?.['email'] === 'string' ? (account['email'] as string) : null,
    };

    this.profileCache = { refreshToken, profile };
    return profile;
  }
}
