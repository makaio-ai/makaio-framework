import type { IMakaioBus } from '@makaio/bus-core';
import type { IUsageProvider } from '../interfaces/usage-provider.js';
import type {
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
} from '../interfaces/account-store.js';
import type { RawCredential } from '../interfaces/credential-source.js';

export type UsagePreparedCredential =
  | { status: 'ready'; credential: RawCredential; changed: boolean }
  | { status: 'invalid'; credential: RawCredential; reason: string };

/**
 * Default cadence for the internal periodic poll tick.
 *
 * One fetch per source per tick — some upstream endpoints are tightly
 * IP-rate-limited, so sweeping all accounts in parallel produces 429s in
 * multi-account setups. The scheduler picks the most-overdue account each
 * tick instead.
 */
export const DEFAULT_USAGE_POLL_INTERVAL_MS = 60_000;

/** Default target interval for active accounts. */
export const DEFAULT_ACTIVE_INTERVAL_MS = 60_000;

/**
 * Default target interval for inactive accounts.
 *
 * Kept conservative here; the production package overrides this to 5 minutes
 * through per-source usage configs.
 */
export const DEFAULT_INACTIVE_INTERVAL_MS = 15 * 60_000;

/**
 * Per-source scheduling configuration.
 *
 * Lets providers with more relaxed upstream rate limits (Codex) run a denser
 * schedule than providers with tight limits (Claude Code). Values are
 * supplied by package code, not external input — callers are responsible for
 * passing finite non-negative millisecond counts. A zero or negative
 * `minFetchIntervalMs` deliberately disables periodic scheduling for that source.
 */
export interface UsageSourceConfig {
  /** Source-level rate cap: minimum ms between consecutive API requests. */
  minFetchIntervalMs?: number;
  /** Maximum random delay (ms) added before each periodic fetch to avoid window-boundary alignment. */
  jitterMs?: number;
  /** Target freshness for active accounts. Defaults to {@link DEFAULT_ACTIVE_INTERVAL_MS}. */
  activeIntervalMs?: number;
  /** Target freshness for inactive accounts. Defaults to {@link DEFAULT_INACTIVE_INTERVAL_MS}. */
  inactiveIntervalMs?: number;
}

/**
 * Resolves the scheduler tick interval for a source.
 * @param config - Optional per-source overrides.
 * @param pollIntervalMs - Global tracker fallback.
 * @returns Effective minimum interval between scheduler ticks.
 */
export function resolveMinFetchInterval(config: UsageSourceConfig | undefined, pollIntervalMs: number): number {
  return config?.minFetchIntervalMs ?? pollIntervalMs;
}

/**
 * Resolves the freshness target for an account based on activity state.
 * @param config - Optional per-source overrides.
 * @param active - Whether the account is currently active.
 * @returns Effective target interval for overdue scheduling.
 */
export function resolveTargetInterval(config: UsageSourceConfig | undefined, active: boolean): number {
  return active
    ? (config?.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS)
    : (config?.inactiveIntervalMs ?? DEFAULT_INACTIVE_INTERVAL_MS);
}

/**
 * Resolves how long a linked normalized client snapshot should suppress
 * provider polling before the tracker falls back to API fetches again.
 *
 * The suppression window must be at least as long as both the source-level
 * fetch cap and the target freshness interval for the linked account.
 * @param config - Optional per-source overrides.
 * @param pollIntervalMs - Global tracker fallback cadence.
 * @param active - Whether the linked account is active.
 * @param observedAt - When the canonical client snapshot was observed.
 * @returns Epoch milliseconds when the linked snapshot stops suppressing polling.
 */
export function resolveLinkedClientSnapshotFreshUntil(
  config: UsageSourceConfig | undefined,
  pollIntervalMs: number,
  active: boolean,
  observedAt: number,
): number {
  return observedAt + Math.max(resolveMinFetchInterval(config, pollIntervalMs), resolveTargetInterval(config, active));
}

/**
 * Dependencies injected into {@link UsageTracker}.
 */
export interface UsageTrackerDeps {
  /** Bus instance for subscribing to events, emitting events, and handling RPCs. */
  bus: IMakaioBus;
  /** Map from clientId to the usage-capable source for that client. */
  sources: Map<string, IUsageProvider>;
  /** Credential persistence layer. */
  credentialStore: IAccountCredentialStore;
  /** Public metadata persistence layer. */
  metadataStore: IAccountMetadataStore;
  /** Optional append-only snapshot persistence backend. */
  usageSnapshotStore?: IAccountUsageSnapshotStore;
  /**
   * Global periodic poll cadence. Defaults to {@link DEFAULT_USAGE_POLL_INTERVAL_MS}.
   * Set to `0` to disable; sources can still opt back in via
   * {@link UsageSourceConfig.minFetchIntervalMs}.
   */
  pollIntervalMs?: number;
  /** Per-source scheduling overrides keyed by `clientId`. */
  sourceConfigs?: Map<string, UsageSourceConfig>;
  /**
   * Prepares the freshest credential for a usage fetch.
   *
   * When provided, the tracker calls this before falling back to the stored
   * credential. The callback may adopt fresher native credentials, refresh an
   * expired token, or report a durable auth-invalid result for the current
   * stored account credential.
   * @param clientId - The client identifier to read credentials for
   * @param accountId - The account the credential must still belong to
   * @returns Prepared credential outcome, or null when unavailable
   */
  readCredential?: (clientId: string, accountId: string) => Promise<UsagePreparedCredential | null>;
}
