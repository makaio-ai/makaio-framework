import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { ExtensionToken } from '@makaio/contracts';
import { ArtifactSubjects, defineArtifactKind } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { ArtifactSchemaRegistryToken } from '../../framework-packages.js';
import { createArtifactKindContributionProcessor } from '../artifact-contribution-processor.js';
import { ArtifactSchemaRegistry } from '../artifact-schema-registry.js';

/**
 * Build a minimal extension context that shares the given bus and exposes an
 * optional registry via `getService`.
 *
 * The context must share the same bus as the registry so that RPCs emitted by
 * the contribution processor reach the handler registered by the registry.
 * @param bus - The shared bus instance used by both registry and context.
 * @param registry - Registry instance to expose, or `undefined` to simulate a
 *   missing service.
 * @returns Minimal kernel extension context stub.
 */
function makeContext(bus: IMakaioBus, registry?: ArtifactSchemaRegistry): KernelExtensionContext {
  return {
    bus,
    identity: {
      extensionName: 'planner',
    } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/planner',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === ArtifactSchemaRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

describe('createArtifactKindContributionProcessor', () => {
  it('registers executable artifact kind contributions through the registry service', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactSchemaRegistry(bus);
    await registry.init();
    const processor = createArtifactKindContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            schemaVersion: '1',
            dataSchema: z.object({ status: z.enum(['draft', 'approved']) }),
            conflictPolicy: 'supersedes',
          }),
        ],
      },
    };

    await processor.processActivated('planner', pkg, makeContext(bus, registry));

    const listed = await bus.request(ArtifactSubjects.kind.list, {});
    expect(listed.kinds.map((entry) => entry.kind)).toEqual(['implementation-plan']);

    await registry.destroy();
  });

  it('registers multiple artifact kinds from a single extension', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactSchemaRegistry(bus);
    await registry.init();
    const processor = createArtifactKindContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            schemaVersion: '1',
            dataSchema: z.object({ status: z.enum(['draft', 'approved']) }),
            conflictPolicy: 'supersedes',
          }),
          defineArtifactKind({
            kind: 'design-note',
            schemaVersion: '1',
            dataSchema: z.object({ content: z.string() }),
            conflictPolicy: 'coexist',
          }),
        ],
      },
    };

    await processor.processActivated('planner', pkg, makeContext(bus, registry));

    const listed = await bus.request(ArtifactSubjects.kind.list, {});
    expect(listed.kinds.map((entry) => entry.kind).sort()).toEqual(['design-note', 'implementation-plan']);

    await registry.destroy();
  });

  it('ignores packages without artifact kind contributions', () => {
    const processor = createArtifactKindContributionProcessor();

    const plain: KernelMakaioExtension = { name: 'plain', displayName: 'Plain', version: '0.1.0' };
    expect(processor.filter!(plain)).toBe(false);

    const withEmpty: KernelMakaioExtension = {
      name: 'empty',
      displayName: 'Empty',
      version: '0.1.0',
      artifactKinds: { kinds: [] },
    };
    expect(processor.filter!(withEmpty)).toBe(false);

    const withKinds: KernelMakaioExtension = {
      name: 'contrib',
      displayName: 'Contrib',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'foo',
            schemaVersion: '1',
            dataSchema: z.object({}),
            conflictPolicy: 'supersedes',
          }),
        ],
      },
    };
    expect(processor.filter!(withKinds)).toBe(true);
  });

  it('throws a hard composition error when ArtifactSchemaRegistry is missing', async () => {
    const bus = createBusInstance();
    const processor = createArtifactKindContributionProcessor();
    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            schemaVersion: '1',
            dataSchema: z.object({ status: z.string() }),
            conflictPolicy: 'supersedes',
          }),
        ],
      },
    };

    await expect(processor.processActivated('planner', pkg, makeContext(bus))).rejects.toThrow(
      'ArtifactSchemaRegistry is not available',
    );
  });

  it('deregisters artifact kinds on processStopped and restores them on re-enable', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactSchemaRegistry(bus);
    await registry.init();
    const processor = createArtifactKindContributionProcessor();

    const pkg: KernelMakaioExtension = {
      name: 'planner',
      displayName: 'Planner',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            schemaVersion: '1',
            dataSchema: z.object({ status: z.string() }),
            conflictPolicy: 'supersedes',
          }),
        ],
      },
    };

    await processor.processActivated('planner', pkg, makeContext(bus, registry));
    await processor.processStopped?.('planner');
    await expect(bus.request(ArtifactSubjects.kind.list, {})).resolves.toEqual({ kinds: [] });

    await processor.processActivated('planner', pkg, makeContext(bus, registry));
    const listed = await bus.request(ArtifactSubjects.kind.list, {});
    expect(listed.kinds.map((entry) => entry.kind)).toEqual(['implementation-plan']);

    await registry.destroy();
  });

  it('rebuilds active registrations when a stopped extension shares a kind key', async () => {
    const bus = createBusInstance();
    const registry = new ArtifactSchemaRegistry(bus);
    await registry.init();
    const processor = createArtifactKindContributionProcessor();

    const alpha: KernelMakaioExtension = {
      name: 'alpha',
      displayName: 'Alpha',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            schemaVersion: '1',
            dataSchema: z.object({ status: z.literal('alpha') }),
            conflictPolicy: 'supersedes',
          }),
        ],
      },
    };
    const beta: KernelMakaioExtension = {
      name: 'beta',
      displayName: 'Beta',
      version: '0.1.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'implementation-plan',
            schemaVersion: '1',
            dataSchema: z.object({ status: z.literal('beta') }),
            conflictPolicy: 'supersedes',
          }),
        ],
      },
    };

    await processor.processActivated('alpha', alpha, makeContext(bus, registry));
    await processor.processActivated('beta', beta, makeContext(bus, registry));

    expect(registry.getKind('implementation-plan', '1')?.dataSchema).toMatchObject({
      properties: { status: { const: 'beta' } },
    });

    await processor.processStopped?.('beta');

    expect(registry.getKind('implementation-plan', '1')?.dataSchema).toMatchObject({
      properties: { status: { const: 'alpha' } },
    });

    await registry.destroy();
  });
});
