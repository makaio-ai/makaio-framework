/**
 * Tests for restoreAgentUsageFromTurns.
 *
 * Uses real memory turn storage (no mocks), verifying the function reads
 * persisted usage from completed turns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { registerMemoryTurnStorage, TurnStorageSubjects } from '@makaio/services-core/session';
import type { TurnUsage } from '@makaio/contracts';
import { restoreAgentUsageFromTurns } from '../restore-agent-usage.js';

describe('restoreAgentUsageFromTurns', () => {
  let cleanup: () => void = () => {};

  /**
   * Create and complete a turn, optionally with usage.
   * @param sessionId - Session ID owning the turn
   * @param usage - Optional usage payload to persist on completion
   * @returns Created turn from storage
   */
  async function createCompletedTurn(
    sessionId: string,
    usage?: TurnUsage,
  ): Promise<Awaited<ReturnType<typeof MakaioBus.request<typeof TurnStorageSubjects.create>>>['turn']> {
    const { turn } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId });
    await MakaioBus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'completed',
      ...(usage !== undefined && { usage }),
    });
    return turn;
  }

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanup = registerMemoryTurnStorage(MakaioBus);
  });

  afterEach(() => {
    cleanup();
  });

  it('returns zero totals when session has no completed turns', async () => {
    const result = await restoreAgentUsageFromTurns(MakaioBus, 'session-empty', 'agent-1');

    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.totalCalls).toBe(0);
  });

  it('returns zero totals when turn storage handler is not registered', async () => {
    // Unregister the real handler so requestOptional returns not-handled
    cleanup();
    try {
      const result = await restoreAgentUsageFromTurns(MakaioBus, 'session-no-handler', 'agent-1');

      expect(result.totalInputTokens).toBe(0);
      expect(result.totalOutputTokens).toBe(0);
      expect(result.totalCalls).toBe(0);
    } finally {
      // Re-register so afterEach cleanup() remains valid even when assertions fail.
      const newCleanup = registerMemoryTurnStorage(MakaioBus);
      cleanup = newCleanup;
    }
  });

  it('sums usage from a single completed turn', async () => {
    await createCompletedTurn('session-1', {
      total: { inputTokens: 100, outputTokens: 50 },
      byAgent: {
        'agent-1': { inputTokens: 100, outputTokens: 50 },
      },
    });

    const result = await restoreAgentUsageFromTurns(MakaioBus, 'session-1', 'agent-1');

    expect(result.totalInputTokens).toBe(100);
    expect(result.totalOutputTokens).toBe(50);
    // totalCalls is always 0 after rehydration: it counts API calls since the
    // last process start, not lifetime calls. Turn history lacks the fidelity
    // to reconstruct an accurate call count (one turn may span multiple calls).
    expect(result.totalCalls).toBe(0);
  });

  it('sums usage across multiple completed turns', async () => {
    await createCompletedTurn('session-2', {
      total: { inputTokens: 100, outputTokens: 40 },
      byAgent: { 'agent-1': { inputTokens: 100, outputTokens: 40 } },
    });
    await createCompletedTurn('session-2', {
      total: { inputTokens: 200, outputTokens: 80 },
      byAgent: { 'agent-1': { inputTokens: 200, outputTokens: 80 } },
    });

    const result = await restoreAgentUsageFromTurns(MakaioBus, 'session-2', 'agent-1');

    expect(result.totalInputTokens).toBe(300);
    expect(result.totalOutputTokens).toBe(120);
    // totalCalls is always 0 after rehydration — see single-turn test comment.
    expect(result.totalCalls).toBe(0);
  });

  it('only counts turns where the specific agent contributed', async () => {
    // turn1 has agent-1
    await createCompletedTurn('session-3', {
      total: { inputTokens: 100, outputTokens: 40 },
      byAgent: { 'agent-1': { inputTokens: 100, outputTokens: 40 } },
    });

    // turn2 has agent-2 only (agent-1 not present)
    await createCompletedTurn('session-3', {
      total: { inputTokens: 999, outputTokens: 500 },
      byAgent: { 'agent-2': { inputTokens: 999, outputTokens: 500 } },
    });

    const result = await restoreAgentUsageFromTurns(MakaioBus, 'session-3', 'agent-1');

    // Only turn1 contributed to token totals
    expect(result.totalInputTokens).toBe(100);
    expect(result.totalOutputTokens).toBe(40);
    // totalCalls is always 0 after rehydration — see single-turn test comment.
    expect(result.totalCalls).toBe(0);
  });

  it('ignores turns with no usage data', async () => {
    await createCompletedTurn('session-4');

    const result = await restoreAgentUsageFromTurns(MakaioBus, 'session-4', 'agent-1');

    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.totalCalls).toBe(0);
  });
});
