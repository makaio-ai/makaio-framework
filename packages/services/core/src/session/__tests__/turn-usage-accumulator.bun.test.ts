/**
 * Unit tests for TurnUsageAccumulator.
 *
 * Pure class, no bus required.
 */
import { describe, it, expect } from 'bun:test';
import { TurnUsageAccumulator } from '../turn-usage-accumulator.js';

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
      accumulator.add({ agentId: 'a1', inputTokens: 100, outputTokens: 50 });

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
      accumulator.add({ agentId: 'a1', inputTokens: 100, outputTokens: 50 });
      accumulator.add({ agentId: 'a1', inputTokens: 200, outputTokens: 75 });

      const usage = accumulator.flush();

      expect(usage?.total.inputTokens).toBe(300);
      expect(usage?.total.outputTokens).toBe(125);
      expect(usage?.byAgent?.['a1']).toEqual({ inputTokens: 300, outputTokens: 125 });
    });
  });

  describe('flush() aggregates multiple agents', () => {
    it('totals across agents and preserves per-agent breakdown', () => {
      const accumulator = new TurnUsageAccumulator();
      accumulator.add({ agentId: 'a1', inputTokens: 100, outputTokens: 50 });
      accumulator.add({ agentId: 'a2', inputTokens: 200, outputTokens: 80 });

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
      accumulator.add({ agentId: 'a1', inputTokens: 100, outputTokens: 50 });

      accumulator.flush(); // consume events
      const second = accumulator.flush();

      expect(second).toBeUndefined();
    });

    it('accumulates fresh events after flush independently', () => {
      const accumulator = new TurnUsageAccumulator();
      accumulator.add({ agentId: 'a1', inputTokens: 100, outputTokens: 50 });
      accumulator.flush();

      accumulator.add({ agentId: 'a1', inputTokens: 10, outputTokens: 5 });
      const second = accumulator.flush();

      expect(second?.total.inputTokens).toBe(10);
      expect(second?.total.outputTokens).toBe(5);
    });
  });
});
