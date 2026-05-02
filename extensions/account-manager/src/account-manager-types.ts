import type {
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
} from './interfaces/account-store.js';
import type { CredentialSourceWithOptionalLabel, UsageSourceConfig } from './handlers/index.js';

/** Per-source auto-activation behavior configuration. */
export interface AutoActivationSourceConfig {
  enabled: boolean;
}

/** Auto-activation configuration for usage window pings. */
export interface AutoActivationConfig {
  /** Per-source opt-in keyed by clientId (e.g. 'claude-code', 'codex'). */
  sources: Map<string, AutoActivationSourceConfig>;
  /** System prompt for the ping message. */
  systemPrompt: string;
  /** User message content for the ping. */
  message: string;
}

/**
 * Returns whether auto-activation has at least one source opted in.
 * @param config - Optional auto-activation configuration
 * @returns True when at least one source is enabled
 */
export function hasEnabledAutoActivationSource(
  config: AutoActivationConfig | undefined,
): config is AutoActivationConfig {
  return config !== undefined && Array.from(config.sources.values()).some((source) => source.enabled);
}

/**
 * Configuration options for the AccountManager service.
 */
export interface AccountManagerOptions {
  /** Credential sources to monitor */
  sources: CredentialSourceWithOptionalLabel[];
  /** Credential storage backend */
  credentialStore: IAccountCredentialStore;
  /** Public metadata storage backend */
  metadataStore: IAccountMetadataStore;
  /** Optional append-only usage snapshot storage backend */
  usageSnapshotStore?: IAccountUsageSnapshotStore;
  /** Credential polling interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /**
   * Usage polling interval in milliseconds (default: 60000).
   * Set to `0` to disable the default internal usage cadence; individual
   * sources can still opt back in via `usageSourceConfigs.minFetchIntervalMs`. Tests can
   * keep every source manual by leaving those overrides unset and driving
   * refreshes deterministically via the `usage.refresh` RPC.
   */
  usagePollIntervalMs?: number;
  /**
   * CLI command used when comparing installed client wiring entries.
   *
   * Host composition roots should provide their launcher name/path here. The
   * core service does not default this because launcher identity is host policy.
   */
  makaioCommand: string;
  /**
   * Per-source scheduling overrides keyed by `clientId`. Exposed so providers
   * with more relaxed upstream rate limits can run denser per-account
   * schedules than the conservative default.
   */
  usageSourceConfigs?: Map<string, UsageSourceConfig>;
  /** Auto-activation config. When absent, auto-activation is disabled. */
  autoActivation?: AutoActivationConfig;
}

/**
 * Thrown inside `activateAccount` when a credential is irrecoverable.
 *
 * The error carries a `quiesce` promise that resolves once derived-state
 * caches (tracker last-seen, usage quiescence) have been cleared for the
 * zombie account. Callers that catch this error must await `quiesce` before
 * reporting failure so the system re-evaluates from a clean slate.
 */
export class AccountManagerQuiesceError extends Error {
  public constructor(
    message: string,
    public readonly quiesce: Promise<void>,
  ) {
    super(message);
  }
}
