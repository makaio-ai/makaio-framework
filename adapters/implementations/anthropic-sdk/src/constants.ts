import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Stable adapter type name for bus routing and persistence. */
export const AnthropicSdkAdapterName = 'anthropic-sdk';

/** Default model for new sessions. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** Default timeout configuration for Anthropic SDK adapter. */
export const DEFAULT_TIMEOUTS = {
  initialization: 30_000,
  acknowledgement: 120_000, // Must be >= completion timeout for queued messages waiting behind slow prompts
  completion: 120_000, // Anthropic can be slow for complex prompts or extended thinking
  toolApproval: 5_000,
  eventWait: 30_000,
} satisfies RequiredTimeoutConfig;
