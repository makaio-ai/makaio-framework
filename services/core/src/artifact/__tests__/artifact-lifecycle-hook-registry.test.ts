import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { ArtifactLifecycleHookRegistration, ArtifactRevision } from '@makaio/contracts';
import {
  ArtifactLifecycleHookRegistry,
  ArtifactLifecycleHookRejectedError,
} from '../artifact-lifecycle-hook-registry.js';

const baseArtifact: ArtifactRevision = {
  kind: 'implementation-plan',
  id: 'artifact-1',
  revision: 'rev-1',
  schemaVersion: '1',
  scope: { level: 'project', ids: { projectId: 'project-1' } },
  data: { status: 'draft' },
  relations: [],
  actor: { kind: 'agent', id: 'agent-1' },
  timestamp: 1,
};

describe('ArtifactLifecycleHookRegistry', () => {
  it('runs before hooks in priority order and applies draft patches', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const calls: string[] = [];

    registry.registerHooks('alpha', [
      {
        id: 'low',
        event: 'beforeCreate',
        priority: -1,
        handler: (ctx) => {
          calls.push('low');
          ctx.updateDraft({ data: { ...ctx.draft.data, low: true } });
        },
      },
      {
        id: 'high',
        event: 'beforeCreate',
        priority: 10,
        handler: (ctx) => {
          calls.push('high');
          ctx.updateDraft({ data: { ...ctx.draft.data, high: true } });
        },
      },
    ]);

    const result = await registry.runBeforeCreate({
      draft: baseArtifact,
      kindRegistration: undefined,
    });

    expect(calls).toEqual(['high', 'low']);
    expect(result.draft.data).toEqual({ status: 'draft', high: true, low: true });
    expect(result.skipMaterialization).toBe(false);
  });

  it('lets draft patches clear optional confidence and representations', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    registry.registerHooks('cleanup', [
      {
        id: 'clear-optionals',
        event: 'beforeRevise',
        handler: (ctx) => {
          ctx.updateDraft({ confidence: undefined, representations: undefined });
        },
      },
    ]);

    const result = await registry.runBeforeRevise({
      draft: {
        ...baseArtifact,
        confidence: {
          level: 'stated',
          basis: [
            {
              kind: 'human-review',
              actor: { kind: 'human', id: 'reviewer-1' },
              timestamp: 1,
            },
          ],
        },
        representations: { summary: 'Initial summary' },
      },
      previous: baseArtifact,
      kindRegistration: undefined,
    });

    expect('confidence' in result.draft).toBe(false);
    expect('representations' in result.draft).toBe(false);
  });

  it('rejects before hooks fail closed before persistence', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    registry.registerHooks('policy', [
      {
        id: 'reject-empty',
        event: 'beforeCreate',
        handler: (ctx) => ctx.rejectCreation('findings are required'),
      },
    ]);

    await expect(
      registry.runBeforeCreate({
        draft: baseArtifact,
        kindRegistration: undefined,
      }),
    ).rejects.toThrow(ArtifactLifecycleHookRejectedError);
  });

  it('lets reaction hooks prevent lower-priority default projection', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const defaultProjection = vi.fn();
    const nonDefaultFollowUp = vi.fn();
    registry.registerHooks('github', [
      {
        id: 'custom',
        event: 'afterCreate',
        priority: 10,
        handler: (ctx) => ctx.preventDefault(),
      },
      {
        id: 'non-default-follow-up',
        event: 'afterCreate',
        priority: 0,
        handler: nonDefaultFollowUp,
      },
      {
        id: 'default',
        event: 'afterCreate',
        priority: -100,
        handler: defaultProjection,
      },
    ]);

    await registry.runAfterCreate({
      artifact: baseArtifact,
      meta: new Map(),
      kindRegistration: undefined,
      projectionPolicy: { mode: 'comment' },
    });

    expect(nonDefaultFollowUp).toHaveBeenCalledTimes(1);
    expect(defaultProjection).not.toHaveBeenCalled();
  });

  it('lets callers skip default projection without suppressing custom reactions', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const defaultProjection = vi.fn();
    const nonDefaultFollowUp = vi.fn();
    registry.registerHooks('github', [
      {
        id: 'non-default-follow-up',
        event: 'afterCreate',
        priority: 0,
        handler: nonDefaultFollowUp,
      },
      {
        id: 'default',
        event: 'afterCreate',
        priority: -100,
        handler: defaultProjection,
      },
    ]);

    await registry.runAfterCreate({
      artifact: baseArtifact,
      meta: new Map(),
      kindRegistration: undefined,
      projectionPolicy: { mode: 'comment' },
      skipDefaultProjection: true,
    });

    expect(nonDefaultFollowUp).toHaveBeenCalledTimes(1);
    expect(defaultProjection).not.toHaveBeenCalled();
  });

  it('logs reaction hook errors and continues with later hooks', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const laterHook = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    registry.registerHooks('policy', [
      {
        id: 'throwing',
        event: 'afterCreate',
        priority: 10,
        handler: () => {
          throw new Error('reaction failed');
        },
      },
      {
        id: 'later',
        event: 'afterCreate',
        priority: 0,
        handler: laterHook,
      },
    ]);

    try {
      await registry.runAfterCreate({
        artifact: baseArtifact,
        meta: new Map(),
        kindRegistration: undefined,
        projectionPolicy: { mode: 'none' },
      });

      expect(laterHook).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('cleans up hook registrations without deleting later same-owner replacements', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const oldHook = vi.fn();
    const newHook = vi.fn();

    const cleanupOld = registry.registerHooks('owner', [{ id: 'old', event: 'afterCreate', handler: oldHook }]);
    const cleanupNew = registry.registerHooks('owner', [{ id: 'new', event: 'afterCreate', handler: newHook }]);
    cleanupOld();
    cleanupOld();

    await registry.runAfterCreate({
      artifact: baseArtifact,
      meta: new Map(),
      kindRegistration: undefined,
      projectionPolicy: { mode: 'none' },
    });

    expect(oldHook).not.toHaveBeenCalled();
    expect(newHook).toHaveBeenCalledTimes(1);

    cleanupNew();
    await registry.runAfterCreate({
      artifact: baseArtifact,
      meta: new Map(),
      kindRegistration: undefined,
      projectionPolicy: { mode: 'none' },
    });

    expect(newHook).toHaveBeenCalledTimes(1);
  });

  it('filters hooks by kind and schema version', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const matching = vi.fn();
    const other = vi.fn();
    const hooks: ArtifactLifecycleHookRegistration[] = [
      {
        id: 'matching',
        event: 'afterCreate',
        filter: { kind: 'implementation-plan', schemaVersion: '1' },
        handler: matching,
      },
      { id: 'other', event: 'afterCreate', filter: { kind: 'review-findings' }, handler: other },
    ];
    registry.registerHooks('filters', hooks);

    await registry.runAfterCreate({
      artifact: baseArtifact,
      meta: new Map(),
      kindRegistration: undefined,
      projectionPolicy: { mode: 'none' },
    });

    expect(matching).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
