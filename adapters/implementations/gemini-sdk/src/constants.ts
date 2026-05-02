import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Adapter name constant for consistent identification */
export const GeminiSdkAdapterName = 'gemini-sdk';

/** Default timeout configuration for Gemini adapter */
export const DEFAULT_TIMEOUTS = {
  initialization: 30_000,
  acknowledgement: 30_000,
  completion: 60_000,
  toolApproval: 5_000,
  eventWait: 10_000,
} satisfies RequiredTimeoutConfig;
