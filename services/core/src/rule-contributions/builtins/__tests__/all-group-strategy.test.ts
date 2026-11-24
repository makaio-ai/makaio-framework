import { describe, expect, it } from 'vitest';
import type { MemberResult } from '@makaio/contracts/rules';
import { ALL_GROUP_STRATEGY_KIND, allGroupStrategy } from '../all-group-strategy.js';

describe('allGroupStrategy (makaio.all)', () => {
  it('carries its canonical kind', () => {
    expect(allGroupStrategy.strategy).toBe(ALL_GROUP_STRATEGY_KIND);
    expect(allGroupStrategy.strategy).toBe('makaio.all');
  });

  it('decides a complete GroupDecision: every member in exactly one list', async () => {
    const members = [
      { ruleId: 'high', priority: 3 },
      { ruleId: 'mid', priority: 2 },
      { ruleId: 'low', priority: 1 },
    ];
    const results: Record<string, MemberResult> = {
      high: { matched: true },
      mid: { matched: false },
      low: { matched: true },
    };

    const decision = await allGroupStrategy.decide(members, async (ruleId) => results[ruleId]!);

    expect(decision).toEqual({
      acting: ['high', 'low'],
      stopped: [],
      notMatched: ['mid'],
    });
  });

  it('evaluates every member, descending by the given priority order', async () => {
    const members = [
      { ruleId: 'a', priority: 2 },
      { ruleId: 'b', priority: 1 },
    ];
    const evaluationOrder: string[] = [];

    await allGroupStrategy.decide(members, async (ruleId) => {
      evaluationOrder.push(ruleId);
      return { matched: false };
    });

    expect(evaluationOrder).toEqual(['a', 'b']);
  });

  it('carries a member stopped by an earlier matched member through to the stopped list', async () => {
    const members = [
      { ruleId: 'stopper', priority: 2 },
      { ruleId: 'stopped-member', priority: 1 },
    ];
    const results: Record<string, MemberResult> = {
      stopper: { matched: true },
      'stopped-member': { stopped: ['stopper'] },
    };

    const decision = await allGroupStrategy.decide(members, async (ruleId) => results[ruleId]!);

    expect(decision).toEqual({
      acting: ['stopper'],
      stopped: [{ ruleId: 'stopped-member', by: ['stopper'] }],
      notMatched: [],
    });
  });

  it('returns an empty, complete decision for an empty group', async () => {
    const decision = await allGroupStrategy.decide([], async () => {
      throw new Error('evaluate must not be called for an empty member list');
    });

    expect(decision).toEqual({ acting: [], stopped: [], notMatched: [] });
  });
});
