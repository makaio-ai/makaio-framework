import type { Account } from '../bus/schemas.js';
import { getUsageAuthDisplayText } from './usage-auth-state.js';

/** Number of ID characters shown when no label is available. */
const DISPLAY_ID_LENGTH = 8;

/**
 * Returns a human-readable display label for an account.
 *
 * Falls back to the first {@link DISPLAY_ID_LENGTH} characters of the account
 * UUID (pre-release; no legacy non-UUID IDs exist) when no label has been set.
 * UUIDs begin with hex characters, so the truncated prefix remains a readable
 * short identifier.
 * @param account - The public account object
 * @returns A human-readable label string
 */
export function displayLabel(account: Pick<Account, 'label' | 'id'>): string {
  return account.label || account.id.slice(0, DISPLAY_ID_LENGTH);
}

/**
 * Formats account metadata into a compact display string.
 *
 * Covers display-relevant fields from all known credential sources:
 * - Codex ChatGPT: `authMode`, `planType`
 * - Codex API key: `authMode`
 * - Claude Code: `planType`, `rateLimitTier`
 * - Usage tracker: persisted re-auth markers add a note
 * @param metadata - The metadata record from the account
 * @returns Comma-separated string, or empty string if no displayable fields
 */
export function collectMetaParts(metadata: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (typeof metadata.authMode === 'string') parts.push(metadata.authMode);
  if (typeof metadata.planType === 'string') parts.push(metadata.planType);
  if (typeof metadata.rateLimitTier === 'string') parts.push(metadata.rateLimitTier);
  const usageAuthDisplay = getUsageAuthDisplayText(metadata);
  if (usageAuthDisplay) parts.push(usageAuthDisplay);
  return parts;
}

/**
 * Formats account metadata into a compact display string.
 *
 * Covers display-relevant fields from all known credential sources:
 * - Codex ChatGPT: `authMode`, `planType`
 * - Codex API key: `authMode`
 * - Claude Code: `planType`, `rateLimitTier`
 * - Usage tracker: persisted re-auth markers add a note
 * @param metadata - The metadata record from the account
 * @returns Comma-separated string, or empty string if no displayable fields
 */
export function displayMeta(metadata: Record<string, unknown>): string {
  return collectMetaParts(metadata).join(', ');
}

/**
 * Builds the standard identity label used by credential sources.
 * @param name - Human-readable account or organization name.
 * @param email - Account email address.
 * @returns `"name (email)"`, `"name"`, `"email"`, or null when both are empty.
 */
export function formatIdentityLabel(name: string | null, email: string | null): string | null {
  const n = name?.trim() || null;
  const e = email?.trim() || null;
  if (n && e) return `${n} (${e})`;
  if (n) return n;
  if (e) return e;
  return null;
}
