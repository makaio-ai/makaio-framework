import type { AccountUsage } from '../bus/schemas.js';
import type { RawCredential } from './credential-source.js';

/**
 * Result of a usage resolution. Bundles the usage snapshot with optional
 * metadata corrections discovered during the fetch (e.g. a plan-type change
 * reported by the upstream API).
 */
export interface UsageResult {
  /** The usage snapshot. */
  usage: AccountUsage;
  /**
   * When present, these key-value pairs should be merged into the account's
   * stored metadata. Only keys whose values differ from the current metadata
   * need to be included.
   */
  metadataPatches?: Record<string, unknown>;
}

/**
 * Thrown by {@link IUsageProvider.resolveUsage} when the upstream API returns
 * HTTP 429. Carries the server's `retry-after` duration so the tracker can
 * extend the per-account error cooldown beyond the default, preventing a
 * punishment spiral on rate-limited endpoints.
 */
export class RateLimitedError extends Error {
  /** Minimum ms to wait before retrying. */
  public readonly retryAfterMs: number;

  /**
   * @param retryAfterMs - Backoff duration from the `retry-after` header,
   *   or a provider-chosen default when the header is absent/zero.
   */
  public constructor(retryAfterMs: number) {
    super(`Rate limited — retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown by {@link IUsageProvider.resolveUsage} when the upstream API rejects
 * the credential definitively (for example HTTP 401/403).
 *
 * Unlike transient fetch failures, this means the usage endpoint will keep
 * failing until the credential changes, so callers should persist the failure
 * against the credential fingerprint instead of retrying on a cooldown loop.
 */
export class UsageAuthInvalidError extends Error {
  /** Human-readable upstream failure reason. */
  public readonly reason: string;

  /**
   * @param reason - Provider-specific failure detail
   */
  public constructor(reason: string) {
    super(reason);
    this.name = 'UsageAuthInvalidError';
    this.reason = reason;
  }
}

/** Provider for fetching volatile account usage data (rate limits, credits). */
export interface IUsageProvider {
  /**
   * Fetches current usage for the account identified by the credential.
   * @param credential - The credential identifying the account.
   * @returns A usage result with optional metadata patches, or null on transient failure.
   * @throws RateLimitedError when the upstream endpoint returns HTTP 429
   * @throws UsageAuthInvalidError when the credential is definitively rejected
   */
  resolveUsage(credential: RawCredential): Promise<UsageResult | null>;
}
