import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetRegistry } from './WidgetRegistry.js';
import type { WidgetDefinition } from './types.js';

declare module '@makaio/contracts' {
  interface UiScopeMap {
    panel: true;
  }
}

describe('WidgetRegistry', () => {
  let registry: WidgetRegistry;

  beforeEach(() => {
    registry = new WidgetRegistry();
  });

  it('registers and retrieves widgets', () => {
    const definition: WidgetDefinition = {
      component: () => null,
      defaultSize: 'medium',
      id: 'test-widget',
      name: 'Test',
      scope: 'any',
      supportedSizes: ['medium'],
    };

    registry.register(definition);

    expect(registry.get('test-widget')).toBe(definition);
    expect(registry.has('test-widget')).toBe(true);
  });

  it('is idempotent on duplicate registration', () => {
    const definition: WidgetDefinition = {
      component: () => null,
      defaultSize: 'medium',
      id: 'test-widget',
      name: 'Test',
      scope: 'any',
      supportedSizes: ['medium'],
    };

    registry.register(definition);

    expect(() => registry.register(definition)).not.toThrow();
    expect(registry.getAll()).toHaveLength(1);
  });

  it('filters by scope, including any-scope widgets when requested', () => {
    registry.registerAll([
      {
        component: () => null,
        defaultSize: 'medium',
        id: 'global-widget',
        name: 'Global',
        scope: 'global',
        supportedSizes: ['medium'],
      },
      {
        component: () => null,
        defaultSize: 'medium',
        id: 'panel-widget',
        name: 'Panel',
        scope: 'panel',
        supportedSizes: ['medium'],
      },
      {
        component: () => null,
        defaultSize: 'medium',
        id: 'any-widget',
        name: 'Any',
        scope: 'any',
        supportedSizes: ['medium'],
      },
    ]);

    expect(new Set(registry.getByScope('global', false).map(({ id }) => id))).toEqual(new Set(['global-widget']));
    expect(new Set(registry.getByScope('global', true).map(({ id }) => id))).toEqual(
      new Set(['global-widget', 'any-widget']),
    );
    expect(new Set(registry.getByScope('panel', true).map(({ id }) => id))).toEqual(
      new Set(['panel-widget', 'any-widget']),
    );
  });

  it('filters multi-scope widgets into each declared scope', () => {
    registry.registerAll([
      {
        component: () => null,
        defaultSize: 'medium',
        id: 'global-only',
        name: 'Global Only',
        scope: 'global',
        supportedSizes: ['medium'],
      },
      {
        component: () => null,
        defaultSize: 'medium',
        id: 'panel-only',
        name: 'Panel Only',
        scope: 'panel',
        supportedSizes: ['medium'],
      },
      {
        component: () => null,
        defaultSize: 'medium',
        id: 'multi-scope',
        name: 'Multi Scope',
        scope: ['global', 'panel'],
        supportedSizes: ['medium'],
      },
      {
        component: () => null,
        defaultSize: 'medium',
        id: 'any-scope',
        name: 'Any Scope',
        scope: 'any',
        supportedSizes: ['medium'],
      },
    ]);

    expect(registry.getByScope('global', false)).toHaveLength(2); // global-only, multi-scope
    expect(registry.getByScope('panel', false)).toHaveLength(2); // panel-only, multi-scope
    expect(registry.getByScope('global', true)).toHaveLength(3); // global-only, multi-scope, any-scope
    expect(registry.getByScope('panel', true)).toHaveLength(3); // panel-only, multi-scope, any-scope
  });

  it('notifies subscribers on register, unregister, and clear of non-empty state', () => {
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.register({
      component: () => null,
      defaultSize: 'medium',
      id: 'test-widget',
      name: 'Test',
      scope: 'any',
      supportedSizes: ['medium'],
    });
    registry.unregister('test-widget');
    registry.register({
      component: () => null,
      defaultSize: 'medium',
      id: 'other-widget',
      name: 'Other',
      scope: 'any',
      supportedSizes: ['medium'],
    });
    registry.clear();

    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    registry.register({
      component: () => null,
      defaultSize: 'medium',
      id: 'third-widget',
      name: 'Third',
      scope: 'any',
      supportedSizes: ['medium'],
    });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('does not notify subscribers when clear is a no-op', () => {
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.clear();

    expect(listener).not.toHaveBeenCalled();
  });

  it('getAll returns a frozen array that cannot be mutated', () => {
    registry.register({
      component: () => null,
      defaultSize: 'medium',
      id: 'freeze-test',
      name: 'Freeze Test',
      scope: 'any',
      supportedSizes: ['medium'],
    });

    const all = registry.getAll();

    // The array is frozen — pushing must throw in strict mode.
    expect(Object.isFrozen(all)).toBe(true);
    expect(() => (all as WidgetDefinition[]).push({} as WidgetDefinition)).toThrow();
  });
});
