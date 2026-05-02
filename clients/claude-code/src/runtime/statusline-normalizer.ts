/**
 * Claude Code statusline normalizer.
 *
 * Receives raw `client:claude-code.statusline.received` payloads together with
 * a pre-resolved identity context and translates them into normalized
 * `client.usage.ingest` request payloads.
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
 * Each documented rate limit window is mapped to a stable key/label pair:
 * - `five_hour` → `{ key: 'five-hour', label: '5 Hour' }`
 * - `seven_day` → `{ key: 'seven-day', label: '7 Day' }`
 * - `seven_day_sonnet` → `{ key: 'seven-day-sonnet', label: '7 Day Sonnet' }`
 *
 * Windows missing `used_percentage` are omitted.  `resets_at` is carried from
 * the raw payload (in Unix seconds) and converted to milliseconds for the
 * normalized contract.
 * @packageDocumentation
 */

import type { ClientAccountIdentifier, ClientUsageIngestRequest, ClientUsageWindow } from '@makaio/contracts/client';
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

  appendWindow(windows, rateLimits.five_hour, 'five-hour', '5 Hour');
  appendWindow(windows, rateLimits.seven_day, 'seven-day', '7 Day');

  // seven_day_sonnet is not a typed field in the schema but travels through
  // the passthrough object. Read it via index access and parse defensively.
  const sevenDaySonnet = parseRateLimitWindow(rateLimits['seven_day_sonnet']);
  if (sevenDaySonnet) {
    appendWindow(windows, sevenDaySonnet, 'seven-day-sonnet', '7 Day Sonnet');
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
