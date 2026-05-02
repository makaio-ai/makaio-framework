import type { ClientAccountIdentifier } from '@makaio/contracts/client';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Build the canonical strong Claude account identifier when both UUIDs exist.
 * @param accountUuid - Stable Claude account UUID reported by a Claude runtime
 * @param orgUuid - Stable Claude organization UUID reported by a Claude runtime
 * @returns Strong identifier, or `undefined` when either UUID is missing
 */
export function buildClaudeAccountOrgUuidIdentifier(
  accountUuid: unknown,
  orgUuid: unknown,
): ClientAccountIdentifier | undefined {
  const normalizedAccountUuid = normalizeUuid(accountUuid);
  const normalizedOrgUuid = normalizeUuid(orgUuid);
  if (!normalizedAccountUuid || !normalizedOrgUuid) {
    return undefined;
  }

  return {
    scheme: 'account-org-uuid',
    value: `${normalizedAccountUuid}:${normalizedOrgUuid}`,
    strength: 'strong',
  };
}

/**
 * Normalize optional UUID-like values before building canonical identifiers.
 * @param value - Potentially empty UUID field from Claude account metadata
 * @returns Trimmed UUID string when present and valid
 */
function normalizeUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined;
}
