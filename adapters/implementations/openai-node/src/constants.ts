import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Adapter name constant for consistent identification */
export const OpenAINodeAdapterName = 'openai-node';

/** Default model to use if not specified in config */
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3.1:thinking';

/** Default timeout configuration for OpenAI adapter */
export const DEFAULT_TIMEOUTS = {
  initialization: 30_000,
  acknowledgement: 120_000, // Must be >= completion timeout for queued messages waiting behind slow prompts
  completion: 120_000, // OpenAI can be slow for complex prompts
  toolApproval: 5_000,
  eventWait: 30_000,
} satisfies RequiredTimeoutConfig;

/** Timeout for live OpenAI-compatible model discovery requests. */
export const MODEL_FETCH_TIMEOUT_MS = 15_000;
