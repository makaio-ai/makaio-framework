import type { ClientAccountIdentifier, ClientAccountObserveRequest } from '@makaio/contracts/client';
import { buildClaudeAccountOrgUuidIdentifier } from '@makaio/client-claude-code';
import type { Account } from './bus/schemas.js';

/**
 * Builds a clients-core account observation request from an account-manager account.
 *
 * Returns `null` when the account metadata does not expose any canonical
 * clients-core identifiers yet.
 * @param clientId - Stable account-manager client identifier
 * @param account - Public account metadata row
 * @returns Observation request, or null when no identifiers can be derived
 */
export function buildClientAccountObserveRequest(
  clientId: string,
  account: Pick<Account, 'label' | 'metadata'>,
): ClientAccountObserveRequest | null {
  const identifiers = buildClientAccountIdentifiers(clientId, account.metadata);
  if (identifiers.length === 0) {
    return null;
  }

  return {
    clientId,
    observedAt: Date.now(),
    displayLabel: normalizeString(account.label),
    identifiers,
  };
}

/**
 * Derives canonical clients-core identifiers from source-specific account metadata.
 * @param clientId - Stable account-manager client identifier
 * @param metadata - Source-specific public account metadata
 * @returns Derived identifiers for `client.account.observe`
 */
function buildClientAccountIdentifiers(clientId: string, metadata: Record<string, unknown>): ClientAccountIdentifier[] {
  switch (clientId) {
    case 'claude-code':
      return buildClaudeIdentifiers(metadata);
    case 'codex':
      return buildCodexIdentifiers(metadata);
    default:
      return [];
  }
}

/**
 * Builds strong Claude account identifiers from stored metadata.
 * @param metadata - Stored Claude account metadata.
 * @returns Strong identifiers when stable UUIDs are available.
 */
function buildClaudeIdentifiers(metadata: Record<string, unknown>): ClientAccountIdentifier[] {
  const identifier = buildClaudeAccountOrgUuidIdentifier(metadata.accountUuid, metadata.orgUuid);
  if (!identifier) {
    return [];
  }

  return [identifier];
}

/**
 * Builds strong Codex account identifiers from stored metadata.
 * @param metadata - Stored Codex account metadata.
 * @returns Strong identifiers when ChatGPT account metadata is available.
 */
function buildCodexIdentifiers(metadata: Record<string, unknown>): ClientAccountIdentifier[] {
  if (normalizeString(metadata.authMode) !== 'chatgpt') {
    return [];
  }

  const accountId = normalizeString(metadata.accountId);
  if (!accountId) {
    return [];
  }

  return [
    {
      scheme: 'account-id',
      value: accountId,
      strength: 'strong',
    },
  ];
}

/**
 * Normalizes optional string metadata fields.
 * @param value - Potentially empty metadata value.
 * @returns Trimmed string when non-empty, otherwise `undefined`.
 */
function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
