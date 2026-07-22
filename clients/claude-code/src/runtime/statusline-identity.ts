/**
 * Statusline identity resolution helpers.
 *
 * Pure functions that resolve or enrich {@link StatuslineIdentityContext}
 * from session storage records and account observations.  Extracted from
 * the service module to keep file length within the project lint threshold.
 * @packageDocumentation
 */

import { ClientAccountIdentifierSchema } from '@makaio/contracts/client';
import { z } from 'zod';
import type { StatuslineIdentityContext } from './statusline-normalizer.js';

/**
 * Attach a resolved Makaio session without changing standalone identities.
 * @param identity - Resolved client account identity
 * @param sessionId - Optional Makaio session identifier
 * @returns Identity enriched with the session identifier when available
 */
export function attachSessionId(
  identity: StatuslineIdentityContext,
  sessionId: string | undefined,
): StatuslineIdentityContext {
  return sessionId === undefined || identity.sessionId === sessionId ? identity : { ...identity, sessionId };
}

/**
 * Extract a {@link StatuslineIdentityContext} from a session record.
 *
 * Reads the `clientAccountId` field and parses the `identifiers` array from
 * `lastClientIdentityObservation.payload.identifiers`.  Returns `null` when
 * either is absent or when the stored identifiers cannot be parsed.
 * @param session - Session record returned by the storage layer
 * @returns Resolved identity context, or `null` when insufficient evidence
 */
// Structural param type is intentional — this helper accepts the subset of
// session fields it needs rather than coupling to a storage entity.
export function resolveIdentityFromSession(session: {
  sessionId: string;
  clientAccountId?: string;
  lastClientIdentityObservation?: { payload: Record<string, unknown> };
}): StatuslineIdentityContext | null {
  const clientAccountId = session.clientAccountId;
  if (!clientAccountId) {
    return null;
  }

  const rawIdentifiers = session.lastClientIdentityObservation?.payload['identifiers'];
  if (!Array.isArray(rawIdentifiers) || rawIdentifiers.length === 0) {
    return null;
  }

  let identifiers;
  try {
    identifiers = z.array(ClientAccountIdentifierSchema).min(1).parse(rawIdentifiers);
  } catch {
    return null;
  }

  const displayLabel = session.lastClientIdentityObservation?.payload['displayLabel'];

  return {
    clientAccountId,
    sessionId: session.sessionId,
    identifiers,
    displayLabel: typeof displayLabel === 'string' && displayLabel.trim().length > 0 ? displayLabel.trim() : undefined,
  };
}
