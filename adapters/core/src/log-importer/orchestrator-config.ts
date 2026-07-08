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
  /**
   * Stable client application id (e.g. `'claude-code'`).
   *
   * When provided AND `checkMakaioManaged` is not overridden, the default
   * detector queries the runtime registry (`client.runtime.isAdapterManaged`)
   * in addition to storage truth. This enables correct skip behaviour for
   * the hook-first ingestion race: a session that only has a tracking stub
   * in storage is still recognised as adapter-managed when the runtime
   * registry holds a record for its `(adapterSessionId, clientId)`.
   */
  clientId?: string;
  /**
   * Machine identifier of the machine running this orchestrator.
   * Caller-supplied at construction time; stamped on every
   * `storage:session.importUpsert` payload so imported sessions are
   * attributed to the correct machine. Pass `undefined` to omit.
   */
  machineId?: string | null;
}

/** Result of parsing a log file. */
export interface ParseFileResult<TRecord> {
  records: TRecord[];
  bytesRead?: number;
  errors?: Array<{ line?: number; error: string }>;
}

export { DEFAULT_EVENTS_PER_SECOND, DEFAULT_POLL_INTERVAL_MS, PROGRESS_LOG_INTERVAL_MS };
