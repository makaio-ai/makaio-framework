import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { defineArtifactKind, defineArtifactLifecycleHooks, type ExtensionToken } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { ArtifactLifecycleHookRegistryToken } from '../../framework-packages.js';
import { ArtifactLifecycleHookRegistry } from '../artifact-lifecycle-hook-registry.js';
import { createArtifactLifecycleHookContributionProcessor } from '../artifact-lifecycle-hook-contribution-processor.js';

function makeContext(bus: IMakaioBus, registry?: ArtifactLifecycleHookRegistry): KernelExtensionContext {
  return {
    bus,
    identity: { extensionName: 'planner' } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/planner',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === ArtifactLifecycleHookRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

describe('createArtifactLifecycleHookContributionProcessor', () => {
  it('registers hooks from artifactLifecycleHooks contributions and live kind hooks', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const processor = createArtifactLifecycleHookContributionProcessor();
    const extensionHook = vi.fn();
    const kindHook = vi.fn();
    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactLifecycleHooks: {
        createHooks: () => [{ id: 'planner.extension', event: 'afterCreate', handler: extensionHook }],
      },
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            description: 'Implementation plan artifact kind used by lifecycle hook processor tests.',
            schemaVersion: 1,
            dataSchema: z.object({ title: z.string().min(1), status: z.string() }),
            category: 'knowledge' as const,
            titlePath: 'title',
            hooks: defineArtifactLifecycleHooks({
              hooks: [{ id: 'planner.kind', event: 'afterCreate', handler: kindHook }],
            }),
          }),
        ],
      },
    };

    await processor.processActivated('planner', pkg, makeContext(bus, registry));
    await registry.runAfterCreate({
      artifact: {
        kind: 'implementation-plan',
        id: 'artifact-1',
        revision: 'rev-1',
        schemaVersion: 1,
        scope: { level: 'project', ids: { projectId: 'project-1' } },
        data: { status: 'draft' },
        relations: [],
        actor: { kind: 'agent', id: 'agent-1' },
        timestamp: 1,
      },
      meta: new Map(),
      kindRegistration: undefined,
    });

    expect(extensionHook).toHaveBeenCalledTimes(1);
    expect(kindHook).toHaveBeenCalledTimes(1);
  });

  it('scopes live kind hooks to their owning kind and schema version', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const processor = createArtifactLifecycleHookContributionProcessor();
    const planKindHook = vi.fn();
    const reviewKindHook = vi.fn();
    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            description: 'Implementation plan artifact kind used by lifecycle hook scoping tests.',
            schemaVersion: 1,
            dataSchema: z.object({ title: z.string().min(1), status: z.string() }),
            category: 'knowledge' as const,
            titlePath: 'title',
            hooks: defineArtifactLifecycleHooks({
              hooks: [{ id: 'planner.plan-kind', event: 'afterCreate', handler: planKindHook }],
            }),
          }),
          defineArtifactKind({
            kind: 'review-findings',
            description: 'Review findings artifact kind used by lifecycle hook scoping tests.',
            schemaVersion: 1,
            dataSchema: z.object({ title: z.string().min(1), count: z.number() }),
            category: 'knowledge' as const,
            titlePath: 'title',
            hooks: defineArtifactLifecycleHooks({
              hooks: [
                {
                  id: 'planner.review-kind',
                  event: 'afterCreate',
                  filter: { kind: '*', schemaVersion: 2 },
                  handler: reviewKindHook,
                },
              ],
            }),
          }),
        ],
      },
    };

    await processor.processActivated('planner', pkg, makeContext(bus, registry));
    await registry.runAfterCreate({
      artifact: {
        kind: 'implementation-plan',
        id: 'artifact-1',
        revision: 'rev-1',
        schemaVersion: 1,
        scope: { level: 'project', ids: { projectId: 'project-1' } },
        data: { status: 'draft' },
        relations: [],
        actor: { kind: 'agent', id: 'agent-1' },
        timestamp: 1,
      },
      meta: new Map(),
      kindRegistration: undefined,
    });

    expect(planKindHook).toHaveBeenCalledTimes(1);
    expect(reviewKindHook).not.toHaveBeenCalled();

    await registry.runAfterCreate({
      artifact: {
        kind: 'review-findings',
        id: 'artifact-2',
        revision: 'rev-1',
        schemaVersion: 1,
        scope: { level: 'project', ids: { projectId: 'project-1' } },
        data: { count: 1 },
        relations: [],
        actor: { kind: 'agent', id: 'agent-1' },
        timestamp: 1,
      },
      meta: new Map(),
      kindRegistration: undefined,
    });

    expect(planKindHook).toHaveBeenCalledTimes(1);
    expect(reviewKindHook).toHaveBeenCalledTimes(1);
  });

  it('unregisters hooks when the owning extension stops', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactLifecycleHookRegistry(bus);
    const processor = createArtifactLifecycleHookContributionProcessor();
    const hook = vi.fn();
    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactLifecycleHooks: {
        createHooks: () => [{ id: 'planner.after-create', event: 'afterCreate', handler: hook }],
      },
    };

    await processor.processActivated('planner', pkg, makeContext(bus, registry));
    await processor.processStopped?.('planner');
    await processor.processStopped?.('planner');

    await registry.runAfterCreate({
      artifact: {
        kind: 'implementation-plan',
        id: 'artifact-1',
        revision: 'rev-1',
        schemaVersion: 1,
        scope: { level: 'project', ids: { projectId: 'project-1' } },
        data: { status: 'draft' },
        relations: [],
        actor: { kind: 'agent', id: 'agent-1' },
        timestamp: 1,
      },
      meta: new Map(),
      kindRegistration: undefined,
    });

    expect(hook).not.toHaveBeenCalled();
  });

  it('throws a hard composition error when the hook registry is missing', async () => {
    const processor = createArtifactLifecycleHookContributionProcessor();
    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactLifecycleHooks: { createHooks: () => [] },
    };

    await expect(processor.processActivated('planner', pkg, makeContext(createBusInstance()))).rejects.toThrow(
      'ArtifactLifecycleHookRegistry is not available',
    );
  });
});
