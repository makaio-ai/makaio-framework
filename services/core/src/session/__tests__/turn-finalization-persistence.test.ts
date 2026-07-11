import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { TurnUsage } from '@makaio/contracts';
import { Turn } from '../entities/turn.js';
import { persistTurnCompletion } from '../turn-finalization-persistence.js';
import { TurnStorageSubjects } from '../turns/index.js';
import { resetBusHandlers } from './shared.js';

const CANONICAL_USAGE: TurnUsage = {
  total: { inputTokens: 8, outputTokens: 5 },
  byAgent: { 'agent-a': { inputTokens: 8, outputTokens: 5 } },
};

describe('turn finalization persistence', () => {
  const unsubs: Array<() => void> = [];

  beforeEach(() => resetBusHandlers());

  afterEach(() => {
    unsubs.splice(0).forEach((unsubscribe) => unsubscribe());
    resetBusHandlers();
  });

  it.each([
    ['missing', undefined],
    [
      'mismatched',
      {
        total: { inputTokens: 7, outputTokens: 5 },
        byAgent: { 'agent-a': { inputTokens: 7, outputTokens: 5 } },
      } satisfies TurnUsage,
    ],
  ])('rejects reconciliation whose authoritative usage remains %s', async (_label, reconciledUsage) => {
    const turn = new Turn({
      turnId: 'turn-reconciliation-mismatch',
      sessionId: 'session-reconciliation-mismatch',
      turnNumber: 1,
      agentIds: ['agent-a'],
    });
    let calls = 0;
    unsubs.push(
      MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
        calls += 1;
        ctx.setResult({
          turn: {
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            turnNumber: turn.turnNumber,
            startedAt: turn.startedAt,
            completedAt: Date.now(),
            status: 'completed',
            ...(calls === 2 && reconciledUsage !== undefined && { usage: reconciledUsage }),
          },
          transitioned: false,
        });
      }),
    );

    await expect(
      persistTurnCompletion(MakaioBus, turn, { success: true, errors: [] }, CANONICAL_USAGE),
    ).rejects.toThrow(`Turn completion usage reconciliation did not persist the canonical snapshot for ${turn.turnId}`);
    expect(calls).toBe(2);
  });

  it('accepts an idempotent retry when authoritative storage already contains canonical usage', async () => {
    const turn = new Turn({
      turnId: 'turn-response-loss',
      sessionId: 'session-response-loss',
      turnNumber: 1,
      agentIds: ['agent-a'],
    });
    let calls = 0;
    unsubs.push(
      MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
        calls += 1;
        ctx.setResult({
          turn: {
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            turnNumber: turn.turnNumber,
            startedAt: turn.startedAt,
            completedAt: Date.now(),
            status: 'completed',
            usage: CANONICAL_USAGE,
          },
          transitioned: false,
        });
      }),
    );

    await expect(
      persistTurnCompletion(MakaioBus, turn, { success: true, errors: [] }, CANONICAL_USAGE),
    ).resolves.toEqual({ handled: true, transitioned: true });
    expect(calls).toBe(1);
  });
});
