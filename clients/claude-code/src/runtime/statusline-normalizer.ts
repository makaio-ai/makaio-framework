/**
 * Claude Code statusline normalizer.
 *
 * Receives raw `client:claude-code.statusline.received` payloads and translates
 * them into two deliberately separate contracts:
 * - account quota windows for `client.usage.ingest`;
 * - session-local usage for `client.session.usage.snapshot`.
 *
 * ## Identity contract
 *
 * The normalizer is a pure function — it does not perform bus lookups or
 * account registry operations.  The caller is responsible for resolving the
 * `clientAccountId` and associated identifiers from the session-account-linking
 * seam and passing them in via {@link StatuslineIdentityContext}.  This keeps
 * the normalizer testable in isolation and prevents any code path from inferring
 * identity from Claude statusline data alone.
 *
 * ## Rate limit window mapping
 *
 * Each documented rate limit window is mapped to a stable key/label pair
 * that matches the IDs used by the Claude Code API usage source:
 * - `five_hour` → `{ key: '5h', label: '5 Hour' }`
 * - `seven_day` → `{ key: '7d', label: '7 Day' }`
 * - `seven_day_sonnet` → `{ key: '7d-sonnet', label: 'Sonnet (7 Day)' }`
 *
 * Windows missing `used_percentage` are omitted.  `resets_at` is carried from
 * the raw payload (in Unix seconds) and converted to milliseconds for the
 * normalized contract.
 * @packageDocumentation
 */

import type {
  ClientAccountIdentifier,
  ClientSessionUsageSnapshot,
  ClientUsageIngestRequest,
  ClientUsageWindow,
} from '@makaio/contracts/client';
import type { ClaudeCodeStatuslineRawPayload, ClaudeStatuslineRateLimitWindow } from '../schemas/statusline.js';

/** Stable client ID for Claude Code. */
const CLIENT_ID = 'claude-code';

/** Ingress source tag for normalized statusline payloads. */
const SOURCE = 'statusline';

/**
 * Resolved identity context passed by the service to the normalizer.
 *
 * The service performs the session lookup, extracts `clientAccountId` from
 * the session record, and parses the stored identifiers from
 * `lastClientIdentityObservation`.  The normalizer receives this context
 * without needing bus access.
 */
export interface StatuslineIdentityContext {
  /** Canonical client account ID resolved from the session record. */
  readonly clientAccountId: string;
  /** Makaio session resolved from the native session lookup, when present. */
  readonly sessionId?: string;
  /**
   * Canonical identifiers associated with the account.
   *
   * At least one identifier is required for a valid `client.usage.ingest`
   * request.  The service guarantees this by only building an identity
   * context when identifiers are present.
   */
  readonly identifiers: ReadonlyArray<ClientAccountIdentifier>;
  /** Optional display label for the account, sourced from the observation. */
  readonly displayLabel?: string;
}

/**
 * Normalize a raw Claude Code statusline payload into a `client.usage.ingest`
 * request payload.
 *
 * Returns `null` when:
 * - The payload carries no rate limit windows with a `used_percentage` value, or
 * - The provided `identity` has no identifiers.
 *
 * The normalizer must **never** infer account identity from the raw statusline
 * payload.  Identity is resolved by the caller through the session-account-
 * linking seam and passed in via `identity`.
 * @param raw - Raw statusline payload delivered on
 *   `client:claude-code.statusline.received`
 * @param identity - Pre-resolved identity context from the session record
 * @returns Normalized `client.usage.ingest` request, or `null` when there is
 *   insufficient data to build one
 */
export function normalizeClaudeCodeStatusline(
  raw: ClaudeCodeStatuslineRawPayload,
  identity: StatuslineIdentityContext,
): ClientUsageIngestRequest | null {
  if (identity.identifiers.length === 0) {
    return null;
  }

  const windows = buildUsageWindows(raw);
  if (windows.length === 0) {
    return null;
  }

  return {
    clientId: CLIENT_ID,
    observedAt: Date.now(),
    source: SOURCE,
    account: {
      displayLabel: identity.displayLabel,
      identifiers: Array.from(identity.identifiers),
    },
    usage: { windows },
    metadata: buildMetadata(raw),
  };
}

/**
 * Normalize the session-local measurements in a Claude Code statusline payload.
 *
 * Claude's `current_usage` values represent the latest API request and the
 * `context_window.total_*` values represent the current context. Neither is
 * labeled as a cumulative session counter. Only the `cost.total_*` and code
 * change fields are mapped to `total*` fields in the normalized contract.
 *
 * Account identity is optional so standalone local sessions remain observable
 * even when no account registry is active. The caller may attach a resolved
 * canonical account ID; this function never infers one from statusline data.
 * @param raw - Raw statusline payload.
 * @param clientAccountId - Canonical account ID resolved by the caller.
 * @param sessionId - Makaio session ID resolved by the caller.
 * @returns Content-free session usage snapshot, or `null` when the payload has
 *   no session ID or no usage measurements.
 */
export function normalizeClaudeCodeSessionUsage(
  raw: ClaudeCodeStatuslineRawPayload,
  clientAccountId?: string,
  sessionId?: string,
): ClientSessionUsageSnapshot | null {
  const adapterSessionId = nonEmptyString(raw.session_id);
  if (adapterSessionId === undefined) {
    return null;
  }

  const measurements = collectSessionUsageMeasurements(raw);
  const { contextThresholdExceeded, ...quantitativeMeasurements } = measurements;

  if (
    contextThresholdExceeded !== true &&
    Object.values(quantitativeMeasurements).every((value) => value === undefined)
  ) {
    return null;
  }

  return {
    clientId: CLIENT_ID,
    clientAccountId,
    sessionId,
    adapterSessionId,
    source: SOURCE,
    observedAt: Date.now(),
    ...collectClientAndModelIdentity(raw),
    ...measurements,
    costCurrency: measurements.totalCost !== undefined ? 'USD' : undefined,
    costProvenance: measurements.totalCost !== undefined ? 'client-reported' : undefined,
  };
}

/**
 * Collect non-measurement client and model labels from a statusline payload.
 * @param raw - Raw statusline payload.
 * @returns Optional normalized client and model fields.
 */
function collectClientAndModelIdentity(raw: ClaudeCodeStatuslineRawPayload): Partial<ClientSessionUsageSnapshot> {
  return {
    clientVersion: nonEmptyString(raw.version),
    modelId: nonEmptyString(raw.model?.id),
    modelDisplayName: nonEmptyString(raw.model?.display_name),
    modelFamily: nonEmptyString(raw.model?.family),
  };
}

/**
 * Collect supported usage measurements without changing gauge/counter semantics.
 * @param raw - Raw statusline payload.
 * @returns Optional normalized usage measurements.
 */
function collectSessionUsageMeasurements(raw: ClaudeCodeStatuslineRawPayload): Partial<ClientSessionUsageSnapshot> {
  return {
    ...collectLatestRequestMeasurements(raw),
    ...collectContextMeasurements(raw),
    ...collectCumulativeMeasurements(raw),
  };
}

/**
 * Collect most-recent request token gauges.
 * @param raw - Raw statusline payload.
 * @returns Optional latest-request token fields.
 */
function collectLatestRequestMeasurements(raw: ClaudeCodeStatuslineRawPayload): Partial<ClientSessionUsageSnapshot> {
  const currentUsage = raw.context_window?.current_usage ?? undefined;
  return {
    latestRequestInputTokens: nonNegativeNumber(currentUsage?.input_tokens),
    latestRequestOutputTokens: nonNegativeNumber(currentUsage?.output_tokens),
    latestRequestCacheReadTokens: nonNegativeNumber(currentUsage?.cache_read_input_tokens),
    latestRequestCacheWriteTokens: nonNegativeNumber(currentUsage?.cache_creation_input_tokens),
  };
}

/**
 * Collect current context-window gauges.
 * @param raw - Raw statusline payload.
 * @returns Optional current-context fields.
 */
function collectContextMeasurements(raw: ClaudeCodeStatuslineRawPayload): Partial<ClientSessionUsageSnapshot> {
  const contextWindow = raw.context_window;
  return {
    currentContextInputTokens: nonNegativeNumber(contextWindow?.total_input_tokens),
    currentContextOutputTokens: nonNegativeNumber(contextWindow?.total_output_tokens),
    contextWindowSizeTokens: nonNegativeNumber(contextWindow?.context_window_size),
    contextUsedPercentage: percentage(contextWindow?.used_percentage),
    contextRemainingPercentage: percentage(contextWindow?.remaining_percentage),
    contextThresholdExceeded: raw.exceeds_200k_tokens,
  };
}

/**
 * Collect cumulative cost, duration, and code-change counters.
 * @param raw - Raw statusline payload.
 * @returns Optional cumulative measurement fields.
 */
function collectCumulativeMeasurements(raw: ClaudeCodeStatuslineRawPayload): Partial<ClientSessionUsageSnapshot> {
  const cost = raw.cost;
  return {
    totalCost: nonNegativeNumber(cost?.total_cost_usd),
    totalDurationMs: nonNegativeNumber(cost?.total_duration_ms),
    totalApiDurationMs: nonNegativeNumber(cost?.total_api_duration_ms),
    totalLinesAdded: nonNegativeNumber(cost?.total_lines_added),
    totalLinesRemoved: nonNegativeNumber(cost?.total_lines_removed),
    totalEdits: nonNegativeNumber(cost?.total_edits),
  };
}

/**
 * Convert raw rate limit windows into normalized `ClientUsageWindow` records.
 *
 * Only windows with a present `used_percentage` value are included.  The raw
 * `resets_at` field is in Unix seconds and is multiplied by 1000 to produce
 * the millisecond epoch expected by `ClientUsageWindowSchema`.
 * @param raw - Raw statusline payload
 * @returns Array of normalized usage windows (may be empty)
 */
function buildUsageWindows(raw: ClaudeCodeStatuslineRawPayload): ClientUsageWindow[] {
  const rateLimits = raw.rate_limits;
  if (!rateLimits) {
    return [];
  }

  const windows: ClientUsageWindow[] = [];

  appendWindow(windows, rateLimits.five_hour, '5h', '5 Hour');
  appendWindow(windows, rateLimits.seven_day, '7d', '7 Day');

  // seven_day_sonnet is not a typed field in the schema but travels through
  // the passthrough object. Read it via index access and parse defensively.
  const sevenDaySonnet = parseRateLimitWindow(rateLimits['seven_day_sonnet']);
  if (sevenDaySonnet) {
    appendWindow(windows, sevenDaySonnet, '7d-sonnet', 'Sonnet (7 Day)');
  }

  return windows;
}

/**
 * Append a normalized window to the accumulator when `used_percentage` is
 * present.
 * @param windows - Mutable accumulator of built windows
 * @param raw - Raw rate limit window from the statusline payload
 * @param key - Stable window key for the normalized contract
 * @param label - Human-readable window label
 */
function appendWindow(
  windows: ClientUsageWindow[],
  raw: ClaudeStatuslineRateLimitWindow | undefined,
  key: string,
  label: string,
): void {
  if (
    !raw ||
    raw.used_percentage === undefined ||
    !Number.isFinite(raw.used_percentage) ||
    raw.used_percentage < 0 ||
    raw.used_percentage > 100
  ) {
    return;
  }

  windows.push({
    key,
    label,
    usedPercentage: raw.used_percentage,
    resetsAt:
      raw.resets_at !== undefined && Number.isFinite(raw.resets_at) && raw.resets_at >= 0
        ? raw.resets_at * 1000
        : undefined,
  });
}

/**
 * Attempt to parse an unknown value as a rate limit window record.
 *
 * Used to safely extract passthrough fields like `seven_day_sonnet` that are
 * present in the raw payload but not declared in the typed schema.
 * @param value - Unknown value from a passthrough object
 * @returns Parsed rate limit window, or `undefined` when the value is not a
 *   conforming object
 */
function parseRateLimitWindow(value: unknown): ClaudeStatuslineRateLimitWindow | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usedPercentage = typeof record['used_percentage'] === 'number' ? record['used_percentage'] : undefined;
  const resetsAt = typeof record['resets_at'] === 'number' ? record['resets_at'] : undefined;

  return { used_percentage: usedPercentage, resets_at: resetsAt };
}

/**
 * Build the optional metadata map from a raw statusline payload.
 *
 * Carries session-scoped extras (`session_id`, `cwd`) that do not map to
 * standard `client.usage.ingest` fields.  Returns `undefined` when all
 * candidate fields are absent so the metadata key is omitted entirely.
 * @param raw - Raw statusline payload
 * @returns Metadata record, or `undefined` when all fields are absent
 */
function buildMetadata(raw: ClaudeCodeStatuslineRawPayload): Record<string, unknown> | undefined {
  const sessionId = raw.session_id;
  const cwd = raw.cwd ?? raw.workspace?.current_dir;

  const meta: Record<string, unknown> = {};
  if (sessionId !== undefined) meta['sessionId'] = sessionId;
  if (cwd !== undefined) meta['cwd'] = cwd;

  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Normalize an optional string.
 * @param value - Candidate string.
 * @returns Non-empty string, or `undefined`.
 */
function nonEmptyString(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * Normalize an optional non-negative measurement.
 * @param value - Candidate numeric measurement.
 * @returns Finite non-negative number, or `undefined`.
 */
function nonNegativeNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Normalize an optional percentage.
 * @param value - Candidate percentage.
 * @returns Finite percentage between zero and one hundred, or `undefined`.
 */
function percentage(value: number | null | undefined): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}
