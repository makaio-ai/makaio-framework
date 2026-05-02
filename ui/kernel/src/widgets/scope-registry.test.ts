import { describe, expect, it, vi } from 'vitest';
import { widgetScopeRegistry, type WidgetScopeDefinition } from './scope-registry.js';

declare module '@makaio/contracts' {
  interface UiScopeMap {
    'dedup-scope-1': true;
    'get-all-scope-1': true;
    'has-test-scope-1': true;
    'minimal-scope-1': true;
    'plugin-scope-1': true;
    'plugin-scope-2': true;
    'plugin-scope-3': true;
    'plugin-scope-4': true;
    'plugin-scope-unregistered': true;
    'subscribe-scope-1': true;
    'subscribe-scope-2': true;
    'subscribe-scope-3': true;
    'subscribe-scope-4': true;
  }
}

/**
 * Built-in scopes that are always pre-populated by the registry.
 * Matches the initial Map entries in WidgetScopeRegistryImpl.
 */
const BUILT_IN_SCOPES = ['global', 'any'] as const;

describe('widgetScopeRegistry', () => {
  /**
   * The singleton registry is module-level state; custom scopes registered in
   * one test would bleed into others. We snapshot the known-good initial entries
   * and clean up any extras at the end of each test by reaching into the private
   * Map via getAll() and removing non-built-in entries through a fresh instance.
   *
   * Because WidgetScopeRegistryImpl is not exported we cannot reset the
   * singleton's internal Map directly. Instead, each test that registers a custom
   * scope must use a unique scope key to avoid cross-test collisions.
   */

  describe('built-in scopes', () => {
    it('has the framework-owned scopes pre-registered', () => {
      for (const scope of BUILT_IN_SCOPES) {
        expect(widgetScopeRegistry.has(scope)).toBe(true);
      }
    });

    it('getAll() includes all built-in scopes', () => {
      const all = widgetScopeRegistry.getAll();

      for (const scope of BUILT_IN_SCOPES) {
        expect(all.has(scope)).toBe(true);
      }
    });

    it('returns a copy from getAll() — mutations do not affect the registry', () => {
      const snapshot = widgetScopeRegistry.getAll();
      snapshot.set('plugin-scope-1', { label: 'Mutated' });

      expect(widgetScopeRegistry.has('plugin-scope-1')).toBe(false);
    });
  });

  describe('register()', () => {
    it('registers a new custom scope', () => {
      const def: WidgetScopeDefinition = {
        label: 'Custom Scope',
        description: 'Custom scope widgets',
      };

      widgetScopeRegistry.register('plugin-scope-2', def);

      expect(widgetScopeRegistry.has('plugin-scope-2')).toBe(true);
      expect(widgetScopeRegistry.getAll().get('plugin-scope-2')).toEqual(def);
    });

    it('does not overwrite an already-registered scope', () => {
      const first: WidgetScopeDefinition = { label: 'First' };
      const second: WidgetScopeDefinition = { label: 'Second' };

      widgetScopeRegistry.register('dedup-scope-1', first);
      widgetScopeRegistry.register('dedup-scope-1', second);

      expect(widgetScopeRegistry.getAll().get('dedup-scope-1')).toEqual(first);
    });

    it('registers a scope without an optional description', () => {
      const def: WidgetScopeDefinition = { label: 'Minimal' };

      widgetScopeRegistry.register('minimal-scope-1', def);

      const stored = widgetScopeRegistry.getAll().get('minimal-scope-1');
      expect(stored?.label).toBe('Minimal');
      expect(stored?.description).toBeUndefined();
    });
  });

  describe('has()', () => {
    it('returns true for a registered scope', () => {
      widgetScopeRegistry.register('has-test-scope-1', { label: 'Has Test' });

      expect(widgetScopeRegistry.has('has-test-scope-1')).toBe(true);
    });

    it('returns false for an unregistered scope', () => {
      expect(widgetScopeRegistry.has('plugin-scope-unregistered')).toBe(false);
    });
  });

  describe('getAll()', () => {
    it('includes newly registered scopes', () => {
      widgetScopeRegistry.register('get-all-scope-1', { label: 'Get All Test' });

      const all = widgetScopeRegistry.getAll();

      expect(all.has('get-all-scope-1')).toBe(true);
    });
  });

  describe('subscribe()', () => {
    it('notifies the listener when a new scope is registered', () => {
      const listener = vi.fn();
      const unsubscribe = widgetScopeRegistry.subscribe(listener);

      widgetScopeRegistry.register('subscribe-scope-1', { label: 'Subscribe Test' });

      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('does not notify the listener after unsubscribing', () => {
      const listener = vi.fn();
      const unsubscribe = widgetScopeRegistry.subscribe(listener);

      unsubscribe();

      widgetScopeRegistry.register('subscribe-scope-2', { label: 'After Unsub' });

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not notify when registering a duplicate scope (no change occurred)', () => {
      widgetScopeRegistry.register('subscribe-scope-3', { label: 'Existing' });

      const listener = vi.fn();
      const unsubscribe = widgetScopeRegistry.subscribe(listener);

      // Duplicate registration — no notification expected.
      widgetScopeRegistry.register('subscribe-scope-3', { label: 'Duplicate' });

      expect(listener).not.toHaveBeenCalled();

      unsubscribe();
    });

    it('notifies multiple independent listeners', () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = widgetScopeRegistry.subscribe(listenerA);
      const unsubB = widgetScopeRegistry.subscribe(listenerB);

      widgetScopeRegistry.register('subscribe-scope-4', { label: 'Multi' });

      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);

      unsubA();
      unsubB();
    });
  });

  describe('singleton export', () => {
    it('widgetScopeRegistry is a stable singleton — same reference across imports', async () => {
      const { widgetScopeRegistry: imported } = await import('./scope-registry.js');

      expect(imported).toBe(widgetScopeRegistry);
    });
  });
});
