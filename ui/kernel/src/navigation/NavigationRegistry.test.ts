import { beforeEach, describe, expect, it } from 'vitest';
import { NavigationRegistry } from './NavigationRegistry.js';
import type { NavigationTarget } from './types.js';

declare module '@makaio/contracts' {
  interface UiNavigationLevelMap {
    workspace: true;
  }
}

function buildTarget(overrides: Partial<NavigationTarget> = {}): NavigationTarget {
  return {
    action: { type: 'focus', focusContext: 'settings' },
    id: 'settings',
    label: 'Settings',
    level: 'root',
    ...overrides,
  };
}

describe('NavigationRegistry', () => {
  let registry: NavigationRegistry;

  beforeEach(() => {
    registry = new NavigationRegistry();
  });

  it('accepts host-augmented level targets', () => {
    const unregister = registry.register(buildTarget({ id: 'workspace-board', level: 'workspace' }));

    expect(registry.get('workspace-board')).toBeDefined();

    unregister();
    expect(registry.get('workspace-board')).toBeUndefined();
  });

  it('rejects whitespace-only levels', () => {
    expect(() => registry.register(buildTarget({ id: 'blank-level', level: '   ' as never }))).toThrow(
      'must have a non-empty level',
    );
  });

  it('rejects invalid runtime action discriminants', () => {
    const target = buildTarget({
      id: 'broken-action',
      action: { type: 'broken' } as never,
    });

    expect(() => registry.register(target)).toThrow('must have a valid action');
  });

  it('stores immutable snapshots of targets and actions', () => {
    const action = {
      type: 'focus',
      focusContext: 'settings',
    } as const;
    const mutableAction = action as { type: string; focusContext: string };
    registry.register(
      buildTarget({
        id: 'immutable-target',
        action,
      }),
    );

    const stored = registry.get('immutable-target');
    expect(stored).toBeDefined();
    const frozenTarget = stored as NavigationTarget;
    expect(Object.isFrozen(frozenTarget)).toBe(true);
    expect(Object.isFrozen(frozenTarget.action)).toBe(true);

    mutableAction.type = 'command';
    expect(frozenTarget.action.type).toBe('focus');
  });
});
