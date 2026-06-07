import { describe, expect, it, vi } from 'vitest';
import { defineArtifactLifecycleHooks } from '../lifecycle-hooks.js';
import type { ArtifactLifecycleHookRegistration } from '../lifecycle-hooks.js';

describe('defineArtifactLifecycleHooks', () => {
  it('returns an immutable registration container without changing handlers', () => {
    const handler = vi.fn();
    const definition = defineArtifactLifecycleHooks({
      hooks: [
        {
          id: 'planner.before-create',
          event: 'beforeCreate',
          filter: { kind: 'implementation-plan' },
          priority: 10,
          handler,
        },
      ],
    });

    expect(definition.hooks).toEqual([
      {
        id: 'planner.before-create',
        event: 'beforeCreate',
        filter: { kind: 'implementation-plan' },
        priority: 10,
        handler,
      },
    ]);
    expect(definition.hooks).not.toBe(
      defineArtifactLifecycleHooks({
        hooks: definition.hooks,
      }).hooks,
    );
  });

  it('source array mutations after construction do not affect the definition', () => {
    const handler = vi.fn();
    const sourceHooks: ArtifactLifecycleHookRegistration[] = [{ id: 'x', event: 'beforeCreate', handler }];
    const definition = defineArtifactLifecycleHooks({ hooks: sourceHooks });
    sourceHooks.push({ id: 'y', event: 'afterCreate', handler });
    expect(definition.hooks).toHaveLength(1);
  });
});
