import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Adapter name constant for consistent identification */
export const GitHubCopilotSdkAdapterName = 'github-copilot-sdk';

/** Default timeout configuration for GitHub Copilot adapter */
export const DEFAULT_TIMEOUTS = {
  initialization: 30_000,
  acknowledgement: 60_000, // Must be >= completion timeout for queued messages waiting behind slow prompts
  completion: 60_000,
  toolApproval: 5_000,
  eventWait: 10_000,
} satisfies RequiredTimeoutConfig;
