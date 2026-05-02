import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUTS, TIMEOUT_CATEGORIES, type TimeoutCategory } from '../timeout/types.js';
import { resolveTimeouts, explainTimeout, explainAllTimeouts } from '../timeout/resolve.js';

describe('resolveTimeouts', () => {
  it('returns global defaults when no layers are provided', () => {
    const result = resolveTimeouts([]);

    expect(result.values).toEqual(DEFAULT_TIMEOUTS);
  });

  it('attributes all categories to the global layer when no layers override them', () => {
    const result = resolveTimeouts([]);

    for (const category of TIMEOUT_CATEGORIES) {
      expect(result.sources[category]).toEqual({
        layer: 'global',
        source: 'DEFAULT_TIMEOUTS',
      });
    }
  });

  it('applies a single adapter layer override', () => {
    const result = resolveTimeouts([
      {
        layer: 'adapter',
        source: 'my-adapter',
        config: { completion: 120_000 },
      },
    ]);

    expect(result.values.completion).toBe(120_000);
    expect(result.sources.completion).toEqual({
      layer: 'adapter',
      source: 'my-adapter',
    });
  });

  it('leaves unoverridden categories at global defaults', () => {
    const result = resolveTimeouts([
      {
        layer: 'adapter',
        source: 'my-adapter',
        config: { completion: 120_000 },
      },
    ]);

    for (const category of TIMEOUT_CATEGORIES) {
      if (category === 'completion') continue;
      expect(result.values[category]).toBe(DEFAULT_TIMEOUTS[category]);
      expect(result.sources[category].layer).toBe('global');
    }
  });

  it('later layers override earlier layers', () => {
    const result = resolveTimeouts([
      {
        layer: 'adapter',
        source: 'my-adapter',
        config: { completion: 90_000 },
      },
      {
        layer: 'runtime',
        source: 'config.ts',
        config: { completion: 180_000 },
      },
    ]);

    expect(result.values.completion).toBe(180_000);
    expect(result.sources.completion).toEqual({
      layer: 'runtime',
      source: 'config.ts',
    });
  });

  it('per-call layer overrides runtime layer', () => {
    const result = resolveTimeouts([
      { layer: 'adapter', source: 'my-adapter', config: { acknowledgement: 10_000 } },
      { layer: 'runtime', source: 'config.ts', config: { acknowledgement: 20_000 } },
      { layer: 'call', source: 'sendMessage()', config: { acknowledgement: 5_000 } },
    ]);

    expect(result.values.acknowledgement).toBe(5_000);
    expect(result.sources.acknowledgement).toEqual({
      layer: 'call',
      source: 'sendMessage()',
    });
  });

  it('skips layers where config is undefined', () => {
    const result = resolveTimeouts([
      { layer: 'adapter', source: 'my-adapter', config: undefined },
      { layer: 'runtime', source: 'config.ts', config: { toolApproval: 3_000 } },
    ]);

    expect(result.values.toolApproval).toBe(3_000);
    expect(result.sources.toolApproval.layer).toBe('runtime');
  });

  it('skips individual undefined values within a config', () => {
    const result = resolveTimeouts([
      {
        layer: 'adapter',
        source: 'my-adapter',
        // Only override one category; others are left undefined (partial)
        config: { initialization: 15_000 },
      },
    ]);

    // Explicitly undefined categories should remain at global defaults
    expect(result.values.eventWait).toBe(DEFAULT_TIMEOUTS.eventWait);
    expect(result.sources.eventWait.layer).toBe('global');
  });

  it('resolves all timeout categories', () => {
    const overrides: Partial<Record<TimeoutCategory, number>> = {
      initialization: 1,
      acknowledgement: 2,
      completion: 3,
      toolApproval: 4,
      eventWait: 5,
    };

    const result = resolveTimeouts([{ layer: 'call', source: 'test', config: overrides }]);

    for (const category of TIMEOUT_CATEGORIES) {
      expect(result.values[category]).toBe(overrides[category]);
      expect(result.sources[category].layer).toBe('call');
    }
  });
});

describe('explainTimeout', () => {
  it('returns a human-readable string for a global default', () => {
    const tracked = resolveTimeouts([]);
    const explanation = explainTimeout(tracked, 'completion');

    expect(explanation).toBe(`completion=${DEFAULT_TIMEOUTS.completion}ms (from global: DEFAULT_TIMEOUTS)`);
  });

  it('reflects the overriding layer and source in the explanation', () => {
    const tracked = resolveTimeouts([{ layer: 'adapter', source: 'openai-node', config: { completion: 90_000 } }]);
    const explanation = explainTimeout(tracked, 'completion');

    expect(explanation).toBe('completion=90000ms (from adapter: openai-node)');
  });
});

describe('explainAllTimeouts', () => {
  it('returns one line per timeout category joined by newlines', () => {
    const tracked = resolveTimeouts([]);
    const explanation = explainAllTimeouts(tracked);
    const lines = explanation.split('\n');

    expect(lines).toHaveLength(TIMEOUT_CATEGORIES.length);
    for (const category of TIMEOUT_CATEGORIES) {
      expect(lines.some((line) => line.startsWith(`${category}=`))).toBe(true);
    }
  });
});
