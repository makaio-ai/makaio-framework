import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { OnboardingStepRegistry } from './OnboardingStepRegistry.js';
import type { OnboardingStepDefinition } from './types.js';

const StubStep = () => null;

describe('OnboardingStepRegistry', () => {
  let registry: OnboardingStepRegistry;

  /**
   * Build a minimal valid step definition for testing.
   * @param id - Step identifier
   * @param order - Sort order
   */
  const makeStep = (id: string, order: number): OnboardingStepDefinition => ({
    id,
    title: `Step ${id}`,
    kaiState: 'neutral',
    order,
    component: StubStep,
  });

  beforeEach(() => {
    registry = new OnboardingStepRegistry();
  });

  it('returns steps sorted by order and unregister removes the step', () => {
    const unregisterB = registry.register(makeStep('b', 20));
    registry.register(makeStep('a', 10));
    registry.register(makeStep('c', 30));

    expect(registry.getAll().map((s) => s.id)).toEqual(['a', 'b', 'c']);

    unregisterB();

    expect(registry.getAll().map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('re-registering the same id replaces the previous entry', () => {
    registry.register(makeStep('x', 5));
    registry.register({ ...makeStep('x', 99), title: 'Updated' });

    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Updated');
    expect(all[0].order).toBe(99);
  });

  it('notifies subscribers on mutation', () => {
    const listener = mock();
    const unsubscribe = registry.subscribe(listener);

    registry.register(makeStep('y', 1));
    expect(listener).toHaveBeenCalledTimes(1);

    registry.unregister('y');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.register(makeStep('z', 2));
    // After unsubscribing the listener must not be called again.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('throws on invalid step definition', () => {
    expect(() =>
      registry.register({
        id: '',
        title: 'Bad',
        kaiState: 'neutral',
        order: 1,
        component: StubStep,
      }),
    ).toThrow();
  });

  it('throws when order is not a finite number', () => {
    expect(() =>
      registry.register({
        id: 'bad-order',
        title: 'Bad Order',
        kaiState: 'neutral',
        order: NaN,
        component: StubStep,
      }),
    ).toThrow();
  });

  it('a throwing subscriber does not prevent delivery to subsequent subscribers', () => {
    const second = mock();

    registry.subscribe(() => {
      throw new Error('listener boom');
    });
    registry.subscribe(second);

    // The second listener must be called even though the first throws.
    // The thrown error is re-thrown after all deliveries complete.
    expect(() => registry.register(makeStep('fault-test', 1))).toThrow('listener boom');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stale cleanup does not unregister a re-registered step', () => {
    const staleCleanup = registry.register(makeStep('reuse', 5));

    // Simulate unregister followed by re-registration before stale cleanup runs.
    registry.unregister('reuse');
    registry.register({ ...makeStep('reuse', 5), title: 'Newer' });

    // Stale cleanup should be a no-op because the stored definition differs.
    staleCleanup();

    expect(registry.get('reuse')?.title).toBe('Newer');
  });

  it('condition callback runs with OnboardingContext', () => {
    const condition = mock(() => true);
    const step = makeStep('conditional', 10);
    registry.register({ ...step, condition });

    const ctx = { adapters: [], extensions: [], clients: [] };
    const registered = registry.get('conditional');
    expect(registered?.condition?.(ctx)).toBe(true);
    expect(condition).toHaveBeenCalledWith(ctx);
  });
});
