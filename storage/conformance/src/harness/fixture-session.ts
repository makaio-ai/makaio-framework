/**
 * Shared session fixture for the handler conformance suites.
 *
 * Several suites persist sessions purely to satisfy foreign keys or as the
 * subject under test; this single builder keeps the required-field defaults
 * in one place so an `IMakaioSession` contract change touches one file.
 * @packageDocumentation
 */
import type { IMakaioSession } from '@makaio/contracts';

/**
 * Build a minimal valid session payload for `SessionStorageSubjects.set`.
 *
 * Defaults satisfy every required `IMakaioSession` field; pass overrides for
 * suite-specific values (`sessionId`, `parentSessionId`, `title`, ...).
 * @param overrides - Field overrides applied on top of the defaults.
 * @returns Session payload with defaults applied.
 */
export function makeSession(overrides: Partial<IMakaioSession> = {}): IMakaioSession {
  const now = Date.now();
  return {
    sessionId: `session-${crypto.randomUUID()}`,
    createdAt: now,
    lastActivityAt: now,
    agents: [],
    status: 'active',
    isOrchestrated: false,
    isImported: false,
    ...overrides,
  };
}
