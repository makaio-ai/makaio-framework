import { describe, expect, it } from 'vitest';
import { commitExecutionLifecycleTransition } from '../workflow-execution-finalizer.js';

describe('post-commit lifecycle control effect', () => {
  it.each(['throw', 'reject'] as const)('preserves reserved publication when control effects %s', async (failure) => {
    const deps = {
      durableLifecycleTransitions: new Map<string, Promise<void>>(),
      lifecyclePublications: new Map<string, Promise<void>>(),
      publishingLifecycleExecutions: new Set<string>(),
    };
    const published = Promise.withResolvers<void>();
    const result = commitExecutionLifecycleTransition(
      deps,
      'owner',
      async () => 'committed',
      async (committed) => {
        expect(committed).toBe('committed');
        published.resolve();
      },
      () => {
        const error = new Error('control delivery failed');
        if (failure === 'throw') throw error;
        return Promise.reject(error);
      },
    );
    await expect(result).rejects.toThrow('control delivery failed');
    await published.promise;
    expect(deps.durableLifecycleTransitions.size).toBe(0);
  });

  it('does not hold the publication start barrier while a control subscriber awaits that publication', async () => {
    const deps = {
      durableLifecycleTransitions: new Map<string, Promise<void>>(),
      lifecyclePublications: new Map<string, Promise<void>>(),
      publishingLifecycleExecutions: new Set<string>(),
    };
    const published = Promise.withResolvers<void>();
    const effects: string[] = [];
    await expect(
      commitExecutionLifecycleTransition(
        deps,
        'owner',
        async () => 'committed',
        async () => {
          effects.push('published');
          published.resolve();
        },
        async () => {
          expect(deps.durableLifecycleTransitions.size).toBe(0);
          effects.push('control-started');
          await published.promise;
          effects.push('control-finished');
        },
      ),
    ).resolves.toBe('committed');
    expect(effects).toEqual(['control-started', 'published', 'control-finished']);
  });
});
