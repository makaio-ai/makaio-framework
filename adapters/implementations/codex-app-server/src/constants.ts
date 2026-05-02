import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Adapter name constant for consistent identification */
export const CodexAppServerAdapterName = 'codex-app-server';

/** Default model for Codex App-Server adapter */
export const DefaultModel = 'gpt-5.1-codex-mini';

/** Default provider for Codex App-Server adapter */
export const DefaultProvider = 'openai';

/** Default timeout configuration for Codex App-Server adapter */
export const DEFAULT_TIMEOUTS = {
  initialization: 30_000,
  acknowledgement: 30_000,
  completion: 60_000,
  toolApproval: 5_000,
  eventWait: 3_000,
} satisfies RequiredTimeoutConfig;
