import type { IMakaioBus } from '@makaio/bus-core';
import type { TurnUsage } from '@makaio/contracts';
import type { Turn } from './entities/turn.js';
import type { TurnCompletionResult } from './turn-completion.js';
import type { AgentUsageEvent, TurnUsageAccumulator } from './turn-usage-accumulator.js';
import { TurnStorageSubjects } from './turns/index.js';

/** Canonical terminal metadata shared by transition and reconciliation writes. */
interface CanonicalTurnCompletion {
  status: 'completed' | 'error';
  error: string | undefined;
}

/**
 * Derive the one canonical storage representation of a terminal result.
 * @param result - Terminal result to normalize for storage.
 * @returns Canonical status and error metadata.
 */
function canonicalTurnCompletion(result: TurnCompletionResult): CanonicalTurnCompletion {
  return {
    status: result.success ? 'completed' : 'error',
    error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
  };
}

/**
 * Compare usage structurally without depending on object key insertion order.
 * @param left - First usage snapshot.
 * @param right - Second usage snapshot.
 * @returns Whether both snapshots contain identical metrics.
 */
function usageEquals(left: TurnUsage | undefined, right: TurnUsage | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (
    left.total.inputTokens !== right.total.inputTokens ||
    left.total.outputTokens !== right.total.outputTokens ||
    left.total.cost !== right.total.cost
  ) {
    return false;
  }
  const leftByAgent = left.byAgent ?? {};
  const rightByAgent = right.byAgent ?? {};
  const leftAgentIds = Object.keys(leftByAgent).sort();
  const rightAgentIds = Object.keys(rightByAgent).sort();
  if (leftAgentIds.length !== rightAgentIds.length) return false;
  return leftAgentIds.every((agentId, index) => {
    if (agentId !== rightAgentIds[index]) return false;
    const leftMetrics = leftByAgent[agentId];
    const rightMetrics = rightByAgent[agentId];
    return (
      leftMetrics?.inputTokens === rightMetrics?.inputTokens &&
      leftMetrics?.outputTokens === rightMetrics?.outputTokens &&
      leftMetrics?.cost === rightMetrics?.cost
    );
  });
}

/**
 * Merge one detached usage batch without mutating the canonical accumulator.
 * @param currentUsage - Last durably committed usage snapshot.
 * @param batch - Detached events to merge into that snapshot.
 * @returns A merged snapshot without mutating either input.
 */
function mergeUsageBatch(currentUsage: TurnUsage | undefined, batch: readonly AgentUsageEvent[]): TurnUsage {
  const byAgent = Object.fromEntries(
    Object.entries(currentUsage?.byAgent ?? {}).map(([agentId, metrics]) => [agentId, { ...metrics }]),
  );
  let inputTokens = currentUsage?.total.inputTokens ?? 0;
  let outputTokens = currentUsage?.total.outputTokens ?? 0;
  for (const event of batch) {
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    const current = byAgent[event.agentId];
    byAgent[event.agentId] = {
      inputTokens: (current?.inputTokens ?? 0) + event.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + event.outputTokens,
      ...(current?.cost !== undefined && { cost: current.cost }),
    };
  }
  return {
    total: {
      inputTokens,
      outputTokens,
      ...(currentUsage?.total.cost !== undefined && { cost: currentUsage.total.cost }),
    },
    byAgent,
  };
}

/**
 * Persist a canonical turn result with response-loss reconciliation.
 * @param bus - Bus used for turn storage requests.
 * @param turn - Turn being finalized.
 * @param result - Canonical terminal result.
 * @param usage - Optional usage snapshot.
 * @param expectedStatus - Optional compare-and-set guard.
 * @returns Storage handling and transition result.
 */
export async function persistTurnCompletion(
  bus: IMakaioBus,
  turn: Turn,
  result: TurnCompletionResult,
  usage: TurnUsage | undefined,
  expectedStatus?: 'active',
): Promise<{ handled: boolean; transitioned: boolean }> {
  const canonical = canonicalTurnCompletion(result);
  const completeResult = await bus.requestOptional(TurnStorageSubjects.complete, {
    turnId: turn.turnId,
    status: canonical.status,
    ...(expectedStatus !== undefined && { expectedStatus }),
    error: canonical.error,
    ...(usage !== undefined && { usage }),
  });
  if (!completeResult.handled) return { handled: false, transitioned: true };
  const stored = completeResult.data.turn;
  const alreadyCommitted = stored.status === canonical.status && stored.error === canonical.error;
  if (!alreadyCommitted) return { handled: true, transitioned: false };
  if (usage === undefined || usageEquals(stored.usage, usage)) {
    return { handled: true, transitioned: true };
  }
  if (completeResult.data.transitioned) {
    throw new Error(`Turn completion storage returned non-canonical usage for transitioned turn ${turn.turnId}`);
  }

  const reconciled = await bus.requestOptional(TurnStorageSubjects.complete, {
    turnId: turn.turnId,
    status: canonical.status,
    error: canonical.error,
    usage,
  });
  if (!reconciled.handled || !usageEquals(reconciled.data.turn.usage, usage)) {
    throw new Error(`Turn completion usage reconciliation did not persist the canonical snapshot for ${turn.turnId}`);
  }
  if (reconciled.data.turn.status !== canonical.status || reconciled.data.turn.error !== canonical.error) {
    throw new Error(`Turn completion usage reconciliation changed terminal metadata for ${turn.turnId}`);
  }
  return { handled: true, transitioned: true };
}

/**
 * Drain buffered usage into reconciled terminal snapshots. Each batch is
 * detached before persistence so arrivals during a write form the next batch.
 * @param input - Finalization state and buffered usage dependencies.
 * @returns Updated usage snapshot.
 */
export async function flushBufferedTurnUsage(input: {
  bus: IMakaioBus;
  turn: Turn;
  result: TurnCompletionResult;
  usageAccumulator: TurnUsageAccumulator | undefined;
  currentUsage: TurnUsage | undefined;
  bufferedUsage: Map<string, AgentUsageEvent[]>;
}): Promise<TurnUsage | undefined> {
  const turnId = input.turn.turnId;
  let currentUsage = input.currentUsage;
  while (true) {
    const detached = input.bufferedUsage.get(turnId);
    if (detached === undefined || detached.length === 0) return currentUsage;
    input.bufferedUsage.delete(turnId);
    const mergedUsage = mergeUsageBatch(currentUsage, detached);
    try {
      await persistTurnCompletion(input.bus, input.turn, input.result, mergedUsage);
    } catch (error) {
      const concurrent = input.bufferedUsage.get(turnId) ?? [];
      input.bufferedUsage.set(turnId, [...detached, ...concurrent]);
      throw error;
    }
    for (const usageEvent of detached) input.usageAccumulator?.add(usageEvent);
    currentUsage = input.usageAccumulator?.snapshot() ?? mergedUsage;
  }
}
