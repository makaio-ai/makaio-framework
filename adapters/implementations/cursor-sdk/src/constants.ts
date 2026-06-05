import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Adapter registration name for Cursor SDK. */
export const CursorSdkAdapterName = 'cursor-sdk' as const;

/** Default model for new Cursor SDK sessions. */
export const DefaultModel = 'composer-2.5';

/**
 * Default timeout configuration for Cursor SDK adapter operations.
 *
 * Cursor SDK manages its own agentic loop over the Composer API, so timeouts
 * account for session initialization, prompt round-trips, and tool approval.
 */
export const DEFAULT_TIMEOUTS = {
  initialization: 60_000,
  acknowledgement: 120_000,
  completion: 600_000,
  toolApproval: 120_000,
  eventWait: 30_000,
} satisfies RequiredTimeoutConfig;
