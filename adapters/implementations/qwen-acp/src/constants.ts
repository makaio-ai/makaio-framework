import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Stable adapter type identifier for qwen-acp. */
export const QwenAcpAdapterName = 'qwen-acp' as const;

/** Default model for Qwen Code CLI. */
export const DefaultModel = 'qwen3.5-plus(openai)';

/**
 * Default timeout configuration for the Qwen ACP adapter.
 *
 * Qwen ACP communicates over stdio via the Agent Client Protocol,
 * so timeouts mirror the ACP session lifecycle phases.
 */
export const DEFAULT_TIMEOUTS = {
  initialization: 30_000,
  acknowledgement: 30_000,
  completion: 60_000,
  toolApproval: 5_000,
  eventWait: 3_000,
} satisfies RequiredTimeoutConfig;
