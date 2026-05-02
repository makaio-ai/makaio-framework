import type { IMakaioBus } from '@makaio/bus-core';
import type { IMakaioSession, Turn } from '@makaio/contracts';
import { SessionSubjects } from '@makaio/contracts';
import { TurnStorageSubjects } from '@makaio/services-core/turn';

/** Default limit for recent history query */
const RECENT_HISTORY_LIMIT = 10;

/** Session enrichment result */
export interface SessionEnrichment {
  session: IMakaioSession | undefined;
  recentHistory: Turn[];
  /**
   * Arbitrary context extensions contributed by the `SessionSubjects.enrichContext`
   * bus RPC. Host registers a handler that returns host-owned fields (e.g.,
   * `project`, `worktree`). Framework spreads these onto hook contexts.
   * Empty object when no handler is registered (OSS mode).
   */
  contextExtensions: Record<string, unknown>;
}

/** Empty enrichment for when sessionId is unavailable or lookup fails */
export const EMPTY_ENRICHMENT: SessionEnrichment = {
  session: undefined,
  recentHistory: [],
  contextExtensions: {},
};

/**
 * Fetch session enrichment data from bus.
 *
 * Queries session, recent turn history, and optional host context extensions
 * via the `SessionSubjects.enrichContext` RPC. The turn history and enrichment
 * lookups resolve concurrently — zero added sequential latency. Returns empty
 * enrichment on error (graceful degradation).
 *
 * Host code registers a handler for `SessionSubjects.enrichContext` to
 * contribute additional context fields (e.g., `project`, `worktree`). When no
 * handler is registered, `contextExtensions` is `{}` (OSS-safe).
 * @param bus - Bus instance for making requests
 * @param sessionId - Session ID to look up
 * @returns Enriched session data (session, recentHistory, contextExtensions)
 */
export async function fetchSessionEnrichment(bus: IMakaioBus, sessionId: string): Promise<SessionEnrichment> {
  try {
    // Query session via public API
    const { session } = await bus.request(SessionSubjects.get, { sessionId });

    if (!session) {
      return EMPTY_ENRICHMENT;
    }

    // Query turn history and host context extensions in parallel (independent)
    const [turnsResult, enrichResult] = await Promise.all([
      bus
        .request(TurnStorageSubjects.getBySession, {
          sessionId,
          limit: RECENT_HISTORY_LIMIT,
        })
        .catch(() => ({ turns: [] as Turn[] })),
      bus.requestOptional(SessionSubjects.enrichContext, { sessionId }).catch(() => ({ handled: false as const })),
    ]);

    const contextExtensions: Record<string, unknown> = enrichResult.handled ? enrichResult.data : {};

    return {
      session,
      recentHistory: turnsResult.turns,
      contextExtensions,
    };
  } catch {
    // On error, return empty enrichment (graceful degradation)
    return EMPTY_ENRICHMENT;
  }
}
