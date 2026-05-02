import type { IMakaioBus } from '@makaio/bus-core';
import { TurnStorageSubjects } from '@makaio/services-core/turn';
import type { AgentUsageTotals } from './types.js';

/**
 * Sum `turn.usage.byAgent[agentId]` across all completed turns for a session.
 *
 * Called during dead-agent rehydration to restore the in-memory usage baseline.
 * Token totals are fully restored so session-level cumulative usage remains
 * reliable across process restarts.
 *
 * `totalCalls` is intentionally reset to zero — it counts API calls since the
 * last process start, not lifetime calls. The historical per-turn data does not
 * have sufficient fidelity to reconstruct a correct lifetime call count (one
 * turn may map to multiple API calls), so zero is the honest default rather
 * than a plausible-but-wrong number. See `AgentUsageTotals` for the full
 * semantics.
 *
 * Uses `requestOptional` so callers that run without a session service
 * (e.g. isolated adapter tests) receive zero-valued totals rather than errors.
 * @param bus - Global bus used to query turn storage
 * @param sessionId - Makaio session ID whose completed turns are queried
 * @param agentId - Agent whose per-turn usage contributions are summed
 * @returns Restored usage totals; all zeros when no turn history is found
 */
export async function restoreAgentUsageFromTurns(
  bus: IMakaioBus,
  sessionId: string,
  agentId: string,
): Promise<AgentUsageTotals> {
  const totals: AgentUsageTotals = { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 };

  const result = await bus.requestOptional(TurnStorageSubjects.getBySession, {
    sessionId,
    status: 'completed',
  });

  if (!result.handled) {
    return totals;
  }

  for (const turn of result.data.turns) {
    const agentMetrics = turn.usage?.byAgent?.[agentId];
    if (agentMetrics) {
      totals.totalInputTokens += agentMetrics.inputTokens;
      totals.totalOutputTokens += agentMetrics.outputTokens;
    }
  }

  return totals;
}
