import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Stable adapter type identifier for pi-sdk. */
export const PiSdkAdapterName = 'pi-sdk' as const;

/**
 * Default model for the Pi SDK adapter.
 *
 * Pi routes model names directly to the underlying provider (Anthropic, OpenAI, etc.),
 * so this must match Pi's model identifier exactly.
 */
export const DefaultModel = 'claude-sonnet-4-6';

/**
 * Default timeout configuration for the Pi SDK adapter.
 *
 * Pi SDK manages its own agentic loop over direct API calls, so timeouts
 * account for session initialization, prompt round-trips, and tool approval.
 */
export const DEFAULT_TIMEOUTS = {
  initialization: 60_000,
  acknowledgement: 120_000,
  completion: 600_000,
  toolApproval: 120_000,
  eventWait: 30_000,
} satisfies RequiredTimeoutConfig;
