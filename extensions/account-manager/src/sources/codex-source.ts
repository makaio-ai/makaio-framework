import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import { AccountUsageSchema } from '../bus/schemas.js';
import type { AccountUsage } from '../bus/schemas.js';
import type {
  CredentialRefreshOptions,
  CredentialRefreshResult,
  ICredentialSource,
  RawCredential,
} from '../interfaces/credential-source.js';
import type { ILabelProvider } from '../interfaces/label-provider.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import type { IUsageProvider, UsageResult } from '../interfaces/usage-provider.js';
import type { ICredentialBackend } from '../backends/credential-backend.js';
import { logAccountManagerDiagnostic } from '../utils/diagnostics.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { formatIdentityLabel } from '../utils/format-account-display.js';
import { decodeJwtPayload } from '../utils/jwt.js';
import { buildChatgptFingerprint, extractIdTokenIdentity, isIdTokenConsistent } from '../utils/codex-jwt-claims.js';
import { mapOAuthErrorToRefreshResult, performOAuthTokenRequest } from '../utils/oauth-token-request.js';
import { parseRetryAfterMs } from '../utils/retry-after.js';
import { parseAdditionalRateLimits, parseUsageWindow } from './codex-usage-parser.js';
import type { CodexAuth, CodexSourceOptions, CodexTokens } from './codex-source-types.js';

export type { CodexSourceOptions } from './codex-source-types.js';

/** Token exchange endpoint for Codex ChatGPT OAuth credential refresh. */
const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

/** OAuth client ID registered for the Codex CLI ChatGPT integration. */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Proactive refresh buffer — refresh the access token when it expires within 5 minutes. */
const CODEX_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Timeout for the OAuth token-exchange request. */
const CODEX_REFRESH_TIMEOUT_MS = 5000;

/**
 * Credential source for OpenAI Codex CLI.
 *
 * Reads credentials from `~/.codex/auth.json` (file-based storage only).
 * Does not access the OS keychain — when Codex uses keyring mode, this source
 * reports a config issue via {@link getConfigIssue} and the TUI guides the user
 * to switch to file mode.
 *
 * Supports two auth modes:
 * - `chatgpt`: OAuth tokens with `accountId:userId` compound fingerprint
 *   (falls back to bare `accountId` when the id_token is missing or lacks a user ID)
 * - `apikey`: API key with SHA-256 fingerprint
 */
export class CodexSource implements ICredentialSource, ILabelProvider, IUsageProvider {
  public readonly clientId = 'codex';
  public readonly displayName = 'Codex';

  /**
   * @param backend - The credential backend used for reading and writing
   *   `auth.json`. The backend owns the target path and storage mechanism,
   *   keeping this source free from file-path knowledge.
   * @param options - Optional root override for config probing in tests or sandboxed runtimes.
   */
  public constructor(
    private readonly backend: ICredentialBackend,
    private readonly options: CodexSourceOptions = {},
  ) {}

  /**
   * Checks whether Codex is installed.
   *
   * Installation probing uses the configured Codex home so package-context and
   * test overrides stay aligned with the backend path used for credential I/O.
   * @returns true if the configured Codex home directory exists
   */
  public async isAvailable(): Promise<boolean> {
    return existsSync(this.codexHome);
  }

  /**
   * Reads the current credential from Codex's auth file via the backend.
   * @returns The parsed credential, or null if not found or unparseable
   */
  public async read(): Promise<RawCredential | null> {
    const raw = await this.backend.read();
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as CodexAuth;

      if (parsed.auth_mode === 'apikey') {
        return this.readApiKeyMode(raw, parsed);
      }

      return this.readChatgptMode(raw, parsed);
    } catch {
      return null;
    }
  }

  /**
   * Writes a credential back to Codex's auth file via the backend.
   * @param credential - The credential to write
   */
  public async write(credential: RawCredential): Promise<void> {
    await this.backend.write(credential.token);
  }

  /**
   * Refreshes the Codex access token if expired.
   *
   * Prefers RFC 8693 token exchange using the id_token when it is still valid.
   * Falls back to a standard `grant_type=refresh_token` flow when the id_token
   * is expired or missing, avoiding the timeout that would otherwise leave
   * inactive accounts in an infinite transient-retry loop.
   * @param credential - The credential to check and potentially refresh.
   * @param options - Optional refresh behavior overrides (e.g. force bypass of expiry guard)
   * @returns A discriminated result so the caller can abort activation when
   *   the refresh fails, instead of writing a known-stale credential.
   */
  public async refreshIfNeeded(
    credential: RawCredential,
    options?: CredentialRefreshOptions,
  ): Promise<CredentialRefreshResult> {
    let parsed: CodexAuth;
    try {
      parsed = JSON.parse(credential.token) as CodexAuth;
    } catch {
      return { status: 'unchanged' };
    }

    if ((parsed.auth_mode && parsed.auth_mode !== 'chatgpt') || !parsed.tokens) return { status: 'unchanged' };

    const accessToken = parsed.tokens.access_token;
    if (typeof accessToken !== 'string') return { status: 'unchanged' };

    const claims = decodeJwtPayload(accessToken);
    const exp = claims?.['exp'];
    if (typeof exp !== 'number') return { status: 'unchanged' };

    if (!options?.force && exp * 1000 > Date.now() + CODEX_EXPIRY_BUFFER_MS) return { status: 'unchanged' };

    if (this.isIdTokenUsable(parsed.tokens.id_token)) {
      return this.refreshViaTokenExchange(parsed, parsed.tokens.id_token!, credential);
    }

    const refreshToken = parsed.tokens.refresh_token;
    if (typeof refreshToken === 'string' && refreshToken.length > 0) {
      return this.refreshViaRefreshToken(parsed, refreshToken, credential);
    }

    return { status: 'failed', reason: 'No usable id_token or refresh_token for credential refresh' };
  }

  /**
   * Returns whether the id_token JWT is present, has a numeric `exp` claim, and
   * will not expire within {@link CODEX_EXPIRY_BUFFER_MS}. Tokens with a missing
   * or non-numeric `exp` are treated as unusable rather than assumed valid.
   * @param idToken - The id_token string from the auth payload
   * @returns Whether the id_token can be used for token exchange
   */
  private isIdTokenUsable(idToken: string | undefined): boolean {
    if (typeof idToken !== 'string') return false;
    const claims = decodeJwtPayload(idToken);
    const exp = claims?.['exp'];
    return typeof exp === 'number' && exp * 1000 > Date.now() + CODEX_EXPIRY_BUFFER_MS;
  }

  /**
   * Refreshes via RFC 8693 token exchange using a valid id_token.
   * @param parsed - Parsed auth payload
   * @param idToken - Valid id_token for the exchange
   * @param credential - Original credential (fingerprint is preserved)
   * @returns Refresh result
   */
  private async refreshViaTokenExchange(
    parsed: CodexAuth,
    idToken: string,
    credential: RawCredential,
  ): Promise<CredentialRefreshResult> {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: CODEX_CLIENT_ID,
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    });

    const result = await performOAuthTokenRequest(CODEX_TOKEN_ENDPOINT, body, {
      timeoutMs: CODEX_REFRESH_TIMEOUT_MS,
    });

    if (result.status !== 'ok') return mapOAuthErrorToRefreshResult(result, 'CodexSource token exchange');

    return this.buildRefreshedCredential(parsed, result.data, credential);
  }

  /**
   * Refreshes via standard OAuth2 refresh_token grant.
   *
   * Used when the id_token is expired or missing — the refresh_token is
   * long-lived and can obtain new access and id tokens independently.
   * @param parsed - Parsed auth payload
   * @param refreshToken - The OAuth refresh token
   * @param credential - Original credential (fingerprint is preserved)
   * @returns Refresh result
   */
  private async refreshViaRefreshToken(
    parsed: CodexAuth,
    refreshToken: string,
    credential: RawCredential,
  ): Promise<CredentialRefreshResult> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const result = await performOAuthTokenRequest(CODEX_TOKEN_ENDPOINT, body, {
      timeoutMs: CODEX_REFRESH_TIMEOUT_MS,
    });

    if (result.status !== 'ok') return mapOAuthErrorToRefreshResult(result, 'CodexSource refresh_token');

    return this.buildRefreshedCredential(parsed, result.data, credential);
  }

  /**
   * Builds a refreshed credential from a successful OAuth token response.
   *
   * Shared between the id_token token-exchange and refresh_token grant paths.
   * @param parsed - Original parsed auth payload
   * @param data - Token endpoint response body
   * @param credential - Original credential (fingerprint is preserved)
   * @returns Refreshed credential result, or failed if the response payload is invalid
   */
  private buildRefreshedCredential(
    parsed: CodexAuth,
    data: Record<string, unknown>,
    credential: RawCredential,
  ): CredentialRefreshResult {
    const newAccessToken = data['access_token'];
    if (typeof newAccessToken !== 'string') {
      return { status: 'failed', reason: 'Codex OAuth refresh returned an invalid token payload' };
    }

    const updatedTokens: CodexTokens = {
      ...parsed.tokens,
      access_token: newAccessToken,
      ...(typeof data['id_token'] === 'string' ? { id_token: data['id_token'] } : undefined),
      ...(typeof data['refresh_token'] === 'string' ? { refresh_token: data['refresh_token'] } : undefined),
    };

    const rebuiltAuth: CodexAuth = {
      ...parsed,
      tokens: updatedTokens,
      last_refresh: new Date().toISOString(),
    };

    const metadata = this.extractChatgptMetadata(rebuiltAuth);

    return {
      status: 'refreshed',
      credential: {
        token: JSON.stringify(rebuiltAuth),
        fingerprint: credential.fingerprint,
        metadata,
      },
    };
  }

  /**
   * Checks whether Codex is configured for file-based credential storage.
   *
   * Reads `~/.codex/config.toml` and checks the `cli_auth_credentials_store`
   * setting. When not set to `"file"`, Codex may store credentials in the OS
   * keychain which is inaccessible without user prompts.
   * @returns Config issue description if not in file mode, null if file mode is active
   */
  public async getConfigIssue(): Promise<{ reason: string; action: string } | null> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const config = parseTOML(content) as Record<string, unknown>;
      if (config.cli_auth_credentials_store === 'file') {
        return null;
      }
    } catch {
      // File doesn't exist or parse error — Codex uses default (keyring)
    }

    return {
      reason: 'Credentials stored in OS keychain',
      action: "Press 'f' to switch Codex to file mode",
    };
  }

  /**
   * Switches Codex to file-backed credential storage.
   *
   * The source owns the config path so the service never duplicates Codex
   * home-directory resolution separately from availability/config probing.
   */
  public async configureFileMode(): Promise<void> {
    const backupPath = `${this.configPath}.bak`;

    let content = '';
    try {
      content = await readFile(this.configPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (content) {
      await writeFile(backupPath, content, { mode: 0o600 });
    }

    const config = content ? (parseTOML(content) as Record<string, unknown>) : {};
    config.cli_auth_credentials_store = 'file';

    await mkdir(this.codexHome, { recursive: true });
    await writeFile(this.configPath, stringifyTOML(config), { mode: 0o600 });
  }

  /**
   * Extracts a stable deduplication key from the raw token string.
   *
   * Returns `accountId:userId` for ChatGPT mode (falls back to bare
   * `accountId` when the id_token is missing or lacks a user ID) or
   * `computeFingerprint(OPENAI_API_KEY)` for API-key mode.
   * @param rawToken - The full credential token string (same as `RawCredential.token`)
   * @returns A stable key string, or null when the token is unparseable or lacks required fields
   */
  public extractCredentialKey(rawToken: string): string | null {
    let parsed: CodexAuth;
    try {
      parsed = JSON.parse(rawToken) as CodexAuth;
    } catch {
      return null;
    }

    if (parsed.auth_mode === 'apikey') {
      const apiKey = parsed.OPENAI_API_KEY;
      if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
      return computeFingerprint(apiKey);
    }

    return buildChatgptFingerprint(parsed);
  }

  /**
   * Allows the `accountId` → `accountId:userId` fingerprint-format transition.
   *
   * Legacy accounts stored a bare `accountId` fingerprint.  After the compound
   * key migration, `extractCredentialKey` returns `accountId:userId`.  This
   * hook tells `findByCredentialKey` to accept the mismatch when the stored
   * compound key is a strict extension of the legacy fingerprint.
   * @param params - Candidate reconciliation values from the tracker
   * @returns `true` when the mismatch is the expected legacy→compound transition
   */
  public allowsCredentialKeyFingerprintMismatch(params: {
    accountFingerprint: string;
    storedCredentialKey: string;
    incomingFingerprint: string;
    incomingCredentialKey: string;
  }): boolean {
    return (
      !params.accountFingerprint.includes(':') && params.storedCredentialKey.startsWith(`${params.accountFingerprint}:`)
    );
  }

  /**
   * Reads credentials in ChatGPT OAuth mode.
   *
   * Uses `accountId:userId` as the fingerprint — `accountId` alone is
   * org-scoped and shared by team members, so the user-scoped
   * `chatgpt_user_id` from the id_token is appended to distinguish
   * individual users within the same org.
   * @param raw - Raw file content
   * @param parsed - Parsed auth JSON
   * @returns The credential, or null if missing required fields
   */
  private readChatgptMode(raw: string, parsed: CodexAuth): RawCredential | null {
    const fingerprint = buildChatgptFingerprint(parsed);
    if (!fingerprint) return null;

    return {
      token: raw,
      fingerprint,
      metadata: this.extractChatgptMetadata(parsed),
    };
  }

  /**
   * Reads credentials in API key mode.
   *
   * Uses SHA-256 fingerprint of the API key (no `account_id` available).
   * @param raw - Raw file content
   * @param parsed - Parsed auth JSON
   * @returns The credential, or null if missing API key
   */
  private readApiKeyMode(raw: string, parsed: CodexAuth): RawCredential | null {
    const apiKey = parsed.OPENAI_API_KEY;
    if (typeof apiKey !== 'string' || apiKey.length === 0) return null;

    return {
      token: raw,
      fingerprint: computeFingerprint(apiKey),
      metadata: { authMode: 'apikey', apiProvider: 'openai' },
    };
  }

  /**
   * Extracts display metadata from ChatGPT OAuth credentials.
   *
   * Identity fields (name, email) are only extracted when the id_token is
   * internally consistent with `tokens.account_id`.
   * @param parsed - The parsed auth object
   * @returns Metadata record
   */
  private extractChatgptMetadata(parsed: CodexAuth): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      authMode: 'chatgpt',
      apiProvider: 'openai',
    };

    if (parsed.tokens?.account_id) metadata.accountId = parsed.tokens.account_id;

    const idToken = parsed.tokens?.id_token;
    if (typeof idToken === 'string') {
      const claims = decodeJwtPayload(idToken);
      if (claims) {
        const identity = extractIdTokenIdentity(claims);
        if (identity.planType !== undefined) metadata.planType = identity.planType;
        if (isIdTokenConsistent(claims, parsed.tokens?.account_id)) {
          if (identity.name) metadata.name = identity.name;
          if (identity.email) metadata.email = identity.email;
        }
      }
    }

    return metadata;
  }

  /**
   * Resolves a human-readable label for a newly detected Codex account.
   *
   * Only applicable in ChatGPT OAuth mode. Prefers claims from the `id_token`
   * (no network required) and falls through to a best-effort `/v1/me` fetch.
   * @param credential - The newly detected credential
   * @returns A display label or null if resolution fails
   */
  public async resolveLabel(credential: RawCredential): Promise<string | null> {
    try {
      const parsed = JSON.parse(credential.token) as CodexAuth;
      if (parsed.auth_mode === 'apikey') return null;
      const cachedLabel = this.labelFromIdToken(parsed);
      if (cachedLabel) return cachedLabel;
      const accessToken = parsed.tokens?.access_token;
      if (typeof accessToken !== 'string') return null;

      const info = await this.fetchAccountInfo(accessToken);
      if (!info) return null;

      return formatIdentityLabel(info.name, info.email);
    } catch {
      return null;
    }
  }

  /**
   * Extracts a display label from the ChatGPT OAuth id_token when available.
   *
   * Guards against mixed-state auth files by verifying the JWT's
   * `chatgpt_account_id` matches `tokens.account_id`. Returns null on
   * mismatch so the caller falls through to the `/v1/me` network probe.
   * @param parsed - Parsed Codex auth payload
   * @returns `"name (email)"`, `"name"`, `"email"`, or null
   */
  private labelFromIdToken(parsed: CodexAuth): string | null {
    const idToken = parsed.tokens?.id_token;
    if (typeof idToken !== 'string') return null;
    const claims = decodeJwtPayload(idToken);
    if (!claims) return null;
    if (!isIdTokenConsistent(claims, parsed.tokens?.account_id)) return null;
    const identity = extractIdTokenIdentity(claims);
    const { name, email } = identity;
    return formatIdentityLabel(name, email);
  }

  /**
   * Fetches current usage data for the account identified by the credential.
   *
   * Only applicable in ChatGPT OAuth mode — API key accounts have no usage
   * endpoint. Extracts the OAuth access token and delegates to
   * {@link fetchCodexUsage}.
   * @param credential - The credential whose usage should be fetched.
   * @returns A usage snapshot, or null on transient failures.
   * @throws UsageAuthInvalidError when the credential is structurally unable
   *   to fetch usage (apikey mode, or no access_token present).
   */
  public async resolveUsage(credential: RawCredential): Promise<UsageResult | null> {
    try {
      const parsed = JSON.parse(credential.token) as CodexAuth;
      if (parsed.auth_mode === 'apikey') {
        throw new UsageAuthInvalidError('Codex apikey-mode credentials do not support usage tracking');
      }
      const accessToken = parsed.tokens?.access_token;
      if (typeof accessToken !== 'string') {
        throw new UsageAuthInvalidError('Codex credential has no access_token for usage tracking');
      }
      return await this.fetchCodexUsage(accessToken);
    } catch (err) {
      if (err instanceof RateLimitedError || err instanceof UsageAuthInvalidError) throw err;
      console.error('[CodexSource] resolveUsage failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Fetches live usage data from the ChatGPT WHAM usage endpoint.
   *
   * Uses a 3 s AbortController timeout to prevent hanging on network issues.
   * Maps the API response to the canonical {@link AccountUsage} shape.
   * Also extracts `plan_type` as a metadata patch and maps
   * `additional_rate_limits` entries to model-specific usage windows.
   * @param accessToken - The ChatGPT OAuth access token.
   * @returns A usage result with optional metadata patches, or null on transient/non-auth errors.
   * @throws RateLimitedError when the usage endpoint returns HTTP 429
   * @throws UsageAuthInvalidError when the credential is definitively rejected
   */
  private async fetchCodexUsage(accessToken: string): Promise<UsageResult | null> {
    try {
      logAccountManagerDiagnostic('CodexSource', 'fetchCodexUsage -> GET /backend-api/wham/usage');
      const response = await fetchWithTimeout(
        'https://chatgpt.com/backend-api/wham/usage',
        { headers: { Authorization: `Bearer ${accessToken}` } },
        3000,
      );
      logAccountManagerDiagnostic('CodexSource', `fetchCodexUsage <- ${response.status}`);
      if (response.status === 429) {
        const retryAfterMs = Math.max(parseRetryAfterMs(response.headers.get('Retry-After'), Date.now()), 60_000);
        throw new RateLimitedError(retryAfterMs);
      }
      if (response.status === 401 || response.status === 403) {
        throw new UsageAuthInvalidError(`Codex usage fetch failed with HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.ok) return null;

      const data = (await response.json()) as Record<string, unknown>;
      const rateLimit = data['rate_limit'] as Record<string, unknown> | null | undefined;

      const windows: AccountUsage['windows'] = [];

      // Fail fast when a known window key is present but malformed — returning
      // a partial snapshot could under-report throttling via the `blocked` flag.
      const windowDefs = [
        { key: 'primary_window', id: '5h', label: '5 Hour', group: 'overall' },
        { key: 'secondary_window', id: '7d', label: '7 Day', group: 'overall' },
      ] as const;
      for (const def of windowDefs) {
        const rawWindow = rateLimit?.[def.key] as Record<string, unknown> | null | undefined;
        if (rawWindow == null) continue;
        const win = parseUsageWindow(rawWindow, def.id, def.label, def.group);
        if (!win) return null;
        windows.push(win);
      }

      parseAdditionalRateLimits(data, windows);

      // blocked reflects the account-level limit_reached flag, not per-model
      // utilization. A model window at 100% means that model is throttled, but
      // the account can still make requests to other models. Per-window
      // utilization is rendered individually via UsageGauge.
      const blocked = rateLimit?.['limit_reached'] === true;

      // Credits are supplementary display data — validate shape before including
      // so a malformed credits payload doesn't reject the entire usage snapshot.
      const creditsData = data['credits'] as Record<string, unknown> | null | undefined;
      const credits: AccountUsage['credits'] =
        creditsData != null && typeof creditsData['has_credits'] === 'boolean'
          ? {
              enabled: creditsData['has_credits'],
              balance: typeof creditsData['balance'] === 'string' ? creditsData['balance'] : undefined,
            }
          : undefined;

      // Validate the fully constructed object against the canonical schema so
      // range/type constraints (e.g. utilization 0–100, integer timestamps) are
      // enforced in one place and stay in sync with future schema tightening.
      const result = AccountUsageSchema.safeParse({ fetchedAt: Date.now(), windows, blocked, credits });
      if (!result.success) return null;

      const metadataPatches: Record<string, unknown> = {};
      const planType = data['plan_type'];
      if (typeof planType === 'string') metadataPatches.planType = planType;

      return {
        usage: result.data,
        ...(Object.keys(metadataPatches).length > 0 ? { metadataPatches } : undefined),
      };
    } catch (err) {
      if (err instanceof RateLimitedError || err instanceof UsageAuthInvalidError) throw err;
      console.error('[CodexSource] fetchCodexUsage failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Fetches account display info from `/v1/me` using the access token.
   * Uses a 3 s AbortController timeout to prevent network hangs.
   * @param accessToken - The ChatGPT OAuth access token
   * @returns Name and email fields, or null on any failure
   */
  private async fetchAccountInfo(accessToken: string): Promise<{ name: string | null; email: string | null } | null> {
    try {
      logAccountManagerDiagnostic('CodexSource', 'fetchAccountInfo -> GET /v1/me');
      const response = await fetchWithTimeout(
        'https://api.openai.com/v1/me',
        { headers: { Authorization: `Bearer ${accessToken}` } },
        3000,
      );
      logAccountManagerDiagnostic('CodexSource', `fetchAccountInfo <- ${response.status}`);
      if (!response.ok) return null;
      const data = (await response.json()) as Record<string, unknown>;
      return {
        name: typeof data.name === 'string' ? data.name : null,
        email: typeof data.email === 'string' ? data.email : null,
      };
    } catch {
      return null;
    }
  }

  private get codexHome(): string {
    return this.options.codexHome ?? join(homedir(), '.codex');
  }

  private get configPath(): string {
    return join(this.codexHome, 'config.toml');
  }
}
