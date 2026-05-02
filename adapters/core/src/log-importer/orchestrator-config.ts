const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_EVENTS_PER_SECOND = 100;
const PROGRESS_LOG_INTERVAL_MS = 10_000;

/** Configuration for log import orchestrators. */
export interface LogOrchestratorConfig {
  enabled: boolean;
  directory?: string;
  pollIntervalMs?: number;
  eventsPerSecond?: number;
  adapterId: string;
  adapterName: string;
  checkMakaioManaged?: (sessionId: string) => Promise<boolean>;
}

/** Result of parsing a log file. */
export interface ParseFileResult<TRecord> {
  records: TRecord[];
  bytesRead?: number;
  errors?: Array<{ line?: number; error: string }>;
}

export { DEFAULT_EVENTS_PER_SECOND, DEFAULT_POLL_INTERVAL_MS, PROGRESS_LOG_INTERVAL_MS };
