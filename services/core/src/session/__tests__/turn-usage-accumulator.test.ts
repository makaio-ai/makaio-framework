/**
 * Unit tests for TurnUsageAccumulator.
 *
 * Pure class, no bus required.
 */
import { describe, it, expect } from 'vitest';
import { TurnUsageAccumulator, type AgentUsageEvent } from '../turn-usage-accumulator.js';

/**
 * Build one fully identified additive provider usage event.
 * @param overrides - Usage fields to override.
 */
function usageEvent(overrides: Partial<AgentUsageEvent> = {}): AgentUsageEvent {
  return {
    agentId: 'a1',
    inputTokens: 100,
    inputCachedTokens: 0,
    outputTokens: 50,
    granularity: 'provider-call',
    llmCallId: crypto.randomUUID(),
    ...overrides,
  };
}

describe('TurnUsageAccumulator', () => {
  describe('flush() with no events', () => {
    it('returns undefined when no events were added', () => {
      const accumulator = new TurnUsageAccumulator();
      expect(accumulator.flush()).toBeUndefined();
    });
  });

  describe('flush() after single agent single event', () => {
    it('returns correct totals for one agent one call', () => {
      const accumulator = new TurnUsageAccumulator();
      accumulator.add(usageEvent());

      const usage = accumulator.flush();

      expect(usage).toBeDefined();
      expect(usage?.total.inputTokens).toBe(100);
      expect(usage?.total.outputTokens).toBe(50);
      expect(usage?.byAgent?.['a1']).toEqual({ inputTokens: 100, outputTokens: 50 });
    });
  });

  describe('flush() accumulates multiple events for same agent', () => {
    it('sums token counts across calls', () => {
      const accumulator = new TurnUsageAccumulator();
      accumulator.add(usageEvent({ llmCallId: 'call-1' }));
      accumulator.add(usageEvent({ inputTokens: 200, inputCachedTokens: 25, outputTokens: 75, llmCallId: 'call-2' }));

      const usage = accumulator.flush();

      expect(usage?.total.inputTokens).toBe(300);
      expect(usage?.total.outputTokens).toBe(125);
      expect(usage?.total.cachedInputTokens).toBe(25);
      expect(usage?.byAgent?.['a1']).toEqual({ inputTokens: 300, cachedInputTokens: 25, outputTokens: 125 });
    });
  });

  describe('flush() aggregates multiple agents', () => {
    it('totals across agents and preserves per-agent breakdown', () => {
      const accumulator = new TurnUsageAccumulator();
      accumulator.add(usageEvent({ agentId: 'a1', llmCallId: 'call-a1' }));
      accumulator.add(usageEvent({ agentId: 'a2', inputTokens: 200, outputTokens: 80, llmCallId: 'call-a2' }));

      const usage = accumulator.flush();

      expect(usage?.total.inputTokens).toBe(300);
      expect(usage?.total.outputTokens).toBe(130);
      expect(usage?.byAgent?.['a1']).toEqual({ inputTokens: 100, outputTokens: 50 });
      expect(usage?.byAgent?.['a2']).toEqual({ inputTokens: 200, outputTokens: 80 });
    });
  });

  describe('flush() resets state', () => {
    it('returns undefined on second flush with no new events', () => {
      const accumulator = new TurnUsageAccumulator();
      accumulator.add(usageEvent());

      accumulator.flush(); // consume events
      const second = accumulator.flush();

      expect(second).toBeUndefined();
    });

    it('accumulates fresh events after flush independently', () => {
      const accumulator = new TurnUsageAccumulator();
      accumulator.add(usageEvent());
      accumulator.flush();

      accumulator.add(usageEvent({ inputTokens: 10, outputTokens: 5 }));
      const second = accumulator.flush();

      expect(second?.total.inputTokens).toBe(10);
      expect(second?.total.outputTokens).toBe(5);
    });
  });

  it('deduplicates identified provider calls', () => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.add(usageEvent({ llmCallId: 'same-call' }));
    accumulator.add(usageEvent({ llmCallId: 'same-call' }));

    expect(accumulator.snapshot()?.total).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('keeps unidentified provider calls additive', () => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.add(usageEvent({ llmCallId: undefined }));
    accumulator.add(usageEvent({ llmCallId: undefined }));

    expect(accumulator.snapshot()?.total.inputTokens).toBe(200);
  });

  it.each([
    ['provider-call', 'query-aggregate'],
    ['query-aggregate', 'provider-call'],
  ] as const)('omits an agent with mixed %s and %s coverage independent of order', (first, second) => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.add(usageEvent({ granularity: first }));
    accumulator.add(usageEvent({ granularity: second }));
    accumulator.add(usageEvent({ agentId: 'a2', llmCallId: 'unaffected' }));

    expect(accumulator.snapshot()?.byAgent).toEqual({
      a2: { inputTokens: 100, outputTokens: 50 },
    });
  });

  it('omits latest-request gauges from additive turn usage', () => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.add(usageEvent({ granularity: 'latest-request-gauge' }));

    expect(accumulator.snapshot()).toBeUndefined();
  });

  it('previews buffered events without mutating authoritative state', () => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.add(usageEvent({ llmCallId: 'persisted' }));

    expect(accumulator.preview([usageEvent({ llmCallId: 'buffered' })])?.total.inputTokens).toBe(200);
    expect(accumulator.snapshot()?.total.inputTokens).toBe(100);
  });
});
