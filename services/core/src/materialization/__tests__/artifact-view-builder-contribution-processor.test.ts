import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { ExtensionArtifactViewBuildersContribution } from '@makaio/contracts/materialization';
import type { ExtensionToken } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { ArtifactViewBuilderRegistryToken } from '../packages.js';
import { ArtifactViewBuilderRegistry } from '../artifact-view-builder-registry.js';
import { createArtifactViewBuilderContributionProcessor } from '../artifact-view-builder-contribution-processor.js';
import { makeBuilder } from './helpers.js';

/**
 * Build a minimal extension context that exposes an optional registry via
 * `getService`.
 * @param registry - Registry instance to expose, or `undefined` to simulate
 *   a missing service.
 * @returns Minimal kernel extension context stub.
 */
function makeContext(registry?: ArtifactViewBuilderRegistry): KernelExtensionContext {
  const bus = createBusInstance();
  return {
    bus,
    identity: {
      extensionName: 'test-ext',
    } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/test-ext',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === ArtifactViewBuilderRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

/**
 * Create a minimal extension package with artifact view builder contributions.
 * @param name - Extension name.
 * @param contribution - Builder contribution.
 * @returns Extension package stub.
 */
function makeExtension(name: string, contribution: ExtensionArtifactViewBuildersContribution): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    artifactViewBuilders: contribution,
  };
}

/* -------------------------------------------------------------------------- */
/*  Filter                                                                    */
/* -------------------------------------------------------------------------- */

describe('createArtifactViewBuilderContributionProcessor', () => {
  describe('filter', () => {
    it('returns true for packages with artifactViewBuilders', () => {
      const processor = createArtifactViewBuilderContributionProcessor();
      const pkg = makeExtension('ext-a', { createBuilders: () => [] });
      expect(processor.filter!(pkg)).toBe(true);
    });

    it('returns false for packages without artifactViewBuilders', () => {
      const processor = createArtifactViewBuilderContributionProcessor();
      const pkg: KernelMakaioExtension = { name: 'plain', displayName: 'Plain', version: '0.1.0' };
      expect(processor.filter!(pkg)).toBe(false);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Activation                                                                */
  /* -------------------------------------------------------------------------- */

  describe('processActivated', () => {
    it('registers builders from the extension contribution', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      const builder = makeBuilder('review-report', 1);
      const pkg = makeExtension('github-ext', {
        createBuilders: () => [builder],
      });

      await processor.processActivated('github-ext', pkg, makeContext(registry));

      expect(registry.getBuilder('review-report', 1)).toBeDefined();
      expect(registry.getBuilder('review-report', 1)!.build).toBe(builder.build);
    });

    it('handles async createBuilders', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      const builder = makeBuilder('review-report', 1);
      const pkg = makeExtension('github-ext', {
        createBuilders: async () => [builder],
      });

      await processor.processActivated('github-ext', pkg, makeContext(registry));

      expect(registry.getBuilder('review-report', 1)).toBeDefined();
    });

    it('throws a hard composition error when the registry is missing', async () => {
      const processor = createArtifactViewBuilderContributionProcessor();
      const pkg = makeExtension('github-ext', { createBuilders: () => [] });

      await expect(processor.processActivated('github-ext', pkg, makeContext())).rejects.toThrow(
        'ArtifactViewBuilderRegistry is not available',
      );
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Dynamic replacement                                                       */
  /* -------------------------------------------------------------------------- */

  describe('dynamic replacement', () => {
    it('replaces builders when the same extension reactivates', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      const v1 = makeBuilder('review-report', 1, 1);
      const v2 = makeBuilder('review-report', 1, 2);

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', { createBuilders: () => [v1] }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)!.version).toBe(1);

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', { createBuilders: () => [v2] }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);
    });

    it('replacement can change the set of contributed kinds', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1), makeBuilder('implementation-plan', 1)],
        }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)).toBeDefined();
      expect(registry.getBuilder('implementation-plan', 1)).toBeDefined();

      // Reactivate with only one builder
      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1, 2)],
        }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);
      expect(registry.getBuilder('implementation-plan', 1)).toBeUndefined();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Deactivation                                                              */
  /* -------------------------------------------------------------------------- */

  describe('processStopped', () => {
    it('removes builders when the extension stops', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1)],
        }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)).toBeDefined();

      await processor.processStopped!('github-ext');
      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
    });

    it('is idempotent for unknown extensions', async () => {
      const processor = createArtifactViewBuilderContributionProcessor();
      await expect(processor.processStopped!('unknown')).resolves.not.toThrow();
    });

    it('is idempotent for already-stopped extensions', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1)],
        }),
        makeContext(registry),
      );

      await processor.processStopped!('github-ext');
      await processor.processStopped!('github-ext');
      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
    });

    it('does not affect builders from other extensions', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1)],
        }),
        makeContext(registry),
      );
      await processor.processActivated(
        'jira-ext',
        makeExtension('jira-ext', {
          createBuilders: () => [makeBuilder('implementation-plan', 1)],
        }),
        makeContext(registry),
      );

      await processor.processStopped!('github-ext');
      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
      expect(registry.getBuilder('implementation-plan', 1)).toBeDefined();
    });

    it('frees keys for re-registration after stop', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1)],
        }),
        makeContext(registry),
      );
      await processor.processStopped!('github-ext');

      // Another extension can now claim the key
      await processor.processActivated(
        'jira-ext',
        makeExtension('jira-ext', {
          createBuilders: () => [makeBuilder('review-report', 1, 2)],
        }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Collision failure during activation                                       */
  /* -------------------------------------------------------------------------- */

  describe('collision failure during activation', () => {
    it('fails activation when builders collide with another extension', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1)],
        }),
        makeContext(registry),
      );

      await expect(
        processor.processActivated(
          'jira-ext',
          makeExtension('jira-ext', {
            createBuilders: () => [makeBuilder('review-report', 1)],
          }),
          makeContext(registry),
        ),
      ).rejects.toThrow(JSON.stringify(['review-report', 1]));

      // The first extension's builder should be intact
      expect(registry.getBuilder('review-report', 1)).toBeDefined();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Open string contributions                                                 */
  /* -------------------------------------------------------------------------- */

  describe('open string contributions', () => {
    it('accepts builders for kinds not known to framework source', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      await processor.processActivated(
        'custom-ext',
        makeExtension('custom-ext', {
          createBuilders: () => [makeBuilder('product-custom-widget', 2024, 3)],
        }),
        makeContext(registry),
      );

      expect(registry.getBuilder('product-custom-widget', 2024)).toBeDefined();
      expect(registry.getBuilder('product-custom-widget', 2024)!.version).toBe(3);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Full lifecycle: activate -> replace -> deactivate                         */
  /* -------------------------------------------------------------------------- */

  describe('full lifecycle', () => {
    it('activate -> replace -> deactivate', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const processor = createArtifactViewBuilderContributionProcessor();

      // Activate
      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1, 1)],
        }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)!.version).toBe(1);

      // Replace
      await processor.processActivated(
        'github-ext',
        makeExtension('github-ext', {
          createBuilders: () => [makeBuilder('review-report', 1, 2)],
        }),
        makeContext(registry),
      );
      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);

      // Deactivate
      await processor.processStopped!('github-ext');
      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
    });
  });
});
