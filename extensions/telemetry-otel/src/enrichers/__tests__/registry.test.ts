import { describe, expect, it } from 'vitest';
import type { SpanDraft, SpanEnricherRule } from '../../contracts/index.js';
import { SpanEnricherRuleRegistry } from '../registry.js';

const draft: SpanDraft = {
  spanId: 'frame:wfx-1:frame-1',
  executionId: 'wfx-1',
  frameId: 'frame-1',
  namespace: 'workflow',
  subject: 'frame.started',
  name: 'Frame analyze',
  kind: 'internal',
  status: 'ok',
  startedAt: 1000,
  endedAt: 1500,
  attributes: {},
  links: [],
  events: [],
};

function makeRule(overrides: Partial<SpanEnricherRule> & Pick<SpanEnricherRule, 'id'>): SpanEnricherRule {
  return {
    name: overrides.id,
    enabled: true,
    priority: 0,
    condition: { field: 'namespace', operator: { $eq: 'workflow' } },
    action: { attributes: { 'test.key': overrides.id } },
    ...overrides,
  };
}

describe('SpanEnricherRuleRegistry.evaluate', () => {
  it('returns matching rules in descending priority order', () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register(makeRule({ id: 'low', priority: 10 }));
    registry.register(makeRule({ id: 'high', priority: 100 }));
    registry.register(makeRule({ id: 'mid', priority: 50 }));
    registry.register(
      makeRule({ id: 'other-namespace', priority: 200, condition: { field: 'namespace', operator: { $eq: 'bus' } } }),
    );

    expect(registry.evaluate(draft).map((rule) => rule.id)).toEqual(['high', 'mid', 'low']);
  });

  it('throws an error naming the rule id when an expression only fails at run time', () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register(makeRule({ id: 'good', priority: 10 }));
    registry.register(makeRule({ id: 'runtime-broken', priority: 20, condition: { $expr: "'{bad'|parseJson == 1" } }));

    expect(() => registry.evaluate(draft)).toThrow(/runtime-broken/);
  });
});

describe('SpanEnricherRuleRegistry.register', () => {
  it('registers a valid rule', () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register(makeRule({ id: 'valid', condition: { field: 'attributes.model', operator: { $exists: true } } }));

    expect(registry.evaluate(draft)).toEqual([]);
  });

  it('rejects a rule with a broken expression and names the rule id', () => {
    const registry = new SpanEnricherRuleRegistry();

    expect(() => registry.register(makeRule({ id: 'broken-rule', condition: { $expr: '(' } }))).toThrow(
      /broken-rule.*expression-syntax/,
    );
    expect(registry.evaluate(draft)).toEqual([]);
  });

  it('rejects a rule that reads a field the span draft does not provide', () => {
    const registry = new SpanEnricherRuleRegistry();

    expect(() =>
      registry.register(makeRule({ id: 'unknown-field', condition: { field: 'noSuchField', operator: { $eq: 1 } } })),
    ).toThrow(/unknown-field.*unknown-root/);
  });
});
