import { expect, it } from 'vitest';
import type { RuleSourceContribution, RuleSourceTrigger } from '@makaio/contracts/rules';
import { RuleSourceRegistry } from './rule-source-registry.js';

it('only exposes canonical triggers owned by the reader extension', () => {
  const registry = new RuleSourceRegistry();
  const activation = new AbortController();
  const timer: RuleSourceTrigger = { kind: 'alpha.timer', params: undefined, subjects: [] };
  registry.register(
    'rules',
    {
      rulesFor: async () => ({ set: null }),
      ruleTriggers: () => [timer, { ...timer, kind: 'alpha.timer.' }, { ...timer, kind: 'beta.timer' }],
      onTriggersChanged: () => () => {},
    },
    activation.signal,
  );

  expect(registry.capabilityFor('alpha', activation.signal).triggers().current()).toEqual([timer]);
  activation.abort();
});

it('rejects a delayed source from a closed generation and preserves its successor', () => {
  const registry = new RuleSourceRegistry();
  const old = new AbortController();
  const next = new AbortController();
  const source: RuleSourceContribution = {
    rulesFor: async () => ({ set: null }),
    ruleTriggers: () => [],
    onTriggersChanged: () => () => {},
  };

  const oldLease = registry.register('rules', source, old.signal);
  expect(() => registry.register('rules', source, next.signal)).toThrow('second one');
  old.abort();
  const replacement = { ...source };
  registry.register('rules', replacement, next.signal);

  expect(() => registry.register('rules', source, old.signal)).toThrow();
  oldLease.release();
  registry.release(old.signal);
  expect(registry.get()).toBe(replacement);
  registry.release(next.signal);
  expect(registry.get()).toBeUndefined();
  expect(next.signal.aborted).toBe(false);
});

it('releases an upstream listener when the source activation closes during subscription', () => {
  const registry = new RuleSourceRegistry();
  const old = new AbortController();
  const next = new AbortController();
  const listeners = new Set<() => void>();
  const replacement: RuleSourceContribution = {
    rulesFor: async () => ({ set: null }),
    ruleTriggers: () => [],
    onTriggersChanged: () => () => {},
  };
  const delayed: RuleSourceContribution = {
    ...replacement,
    onTriggersChanged(listener) {
      listeners.add(listener);
      old.abort();
      registry.register('rules', replacement, next.signal);
      return () => listeners.delete(listener);
    },
  };

  expect(() => registry.register('rules', delayed, old.signal)).toThrow();
  expect(listeners.size).toBe(0);
  expect(registry.get()).toBe(replacement);
  next.abort();
});

it('compares trigger declarations by value regardless of order while accounting for repeats', () => {
  const registry = new RuleSourceRegistry();
  const activation = new AbortController();
  const first: RuleSourceTrigger = { kind: 'rules.trigger', params: { value: 1 }, subjects: ['test.changed'] };
  const second: RuleSourceTrigger = { ...first, params: { value: 2 } };
  let triggers = [first, first, second];
  const upstream = new EventTarget();
  registry.register(
    'rules',
    {
      rulesFor: async () => ({ set: null }),
      ruleTriggers: () => triggers,
      onTriggersChanged(listener) {
        upstream.addEventListener('change', listener);
        return () => upstream.removeEventListener('change', listener);
      },
    },
    activation.signal,
  );
  const reader = registry.triggersFor('rules', activation.signal);
  const changes: RuleSourceTrigger[][] = [];
  reader.onChange(() => changes.push(reader.current()));

  triggers = [second, first, first];
  upstream.dispatchEvent(new Event('change'));
  expect(changes).toEqual([]);

  triggers = [second, first, second];
  upstream.dispatchEvent(new Event('change'));
  expect(changes).toEqual([triggers]);
  activation.abort();
});

it('releases the upstream subscription even when an activation listener stops abort propagation', () => {
  const registry = new RuleSourceRegistry();
  const activation = new AbortController();
  activation.signal.addEventListener('abort', (event) => event.stopImmediatePropagation(), { once: true });
  const listeners = new Set<() => void>();
  registry.register(
    'rules',
    {
      rulesFor: async () => ({ set: null }),
      ruleTriggers: () => [],
      onTriggersChanged(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    activation.signal,
  );

  activation.abort();
  expect(listeners.size).toBe(0);
});
