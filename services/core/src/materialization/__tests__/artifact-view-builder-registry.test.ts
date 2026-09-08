import { describe, expect, it } from 'vitest';
import type { ArtifactViewBuilder } from '@makaio/contracts/materialization';
import { ArtifactViewBuilderCollisionError, ArtifactViewBuilderRegistry } from '../artifact-view-builder-registry.js';
import { makeBuilder } from './helpers.js';

/* -------------------------------------------------------------------------- */
/*  Lookup                                                                    */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewBuilderRegistry', () => {
  it('accepts a builder authored with a literal kind', () => {
    const registry = new ArtifactViewBuilderRegistry();
    const builder: ArtifactViewBuilder<'review-report'> = {
      kind: 'review-report',
      schemaVersion: 1,
      version: 1,
      async build() {
        return undefined;
      },
    };

    registry.replaceBuildersForOwner('ext-a', [builder]);

    expect(registry.getBuilder('review-report', 1)).toBeDefined();
  });

  describe('getBuilder', () => {
    it('returns undefined when no builder is registered', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
    });

    it('returns the builder for an exact kind + schemaVersion match', () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builder = makeBuilder('review-report', 1);
      registry.replaceBuildersForOwner('ext-a', [builder]);

      const found = registry.getBuilder('review-report', 1);
      expect(found).toBeDefined();
      expect(found!.kind).toBe('review-report');
      expect(found!.schemaVersion).toBe(1);
    });

    it('does not match when kind differs', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);

      expect(registry.getBuilder('implementation-plan', 1)).toBeUndefined();
    });

    it('does not match when schemaVersion differs', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);

      expect(registry.getBuilder('review-report', 2)).toBeUndefined();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Builder version validation                                                */
  /* -------------------------------------------------------------------------- */

  describe('version validation', () => {
    it('rejects version 0', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 0)]);
      }).toThrow('non-positive version');
    });

    it('rejects negative version', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, -1)]);
      }).toThrow('non-positive version');
    });

    it('rejects fractional version', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 1.5)]);
      }).toThrow('non-positive version');
    });

    it('accepts version 1', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 1)]);
      }).not.toThrow();
    });

    it('accepts large positive integer version', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 42)]);
      }).not.toThrow();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Atomic owner replacement                                                  */
  /* -------------------------------------------------------------------------- */

  describe('replaceBuildersForOwner', () => {
    it('replaces all builders for an owner atomically', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [
        makeBuilder('review-report', 1, 1),
        makeBuilder('implementation-plan', 1, 1),
      ]);

      expect(registry.getBuilder('review-report', 1)).toBeDefined();
      expect(registry.getBuilder('implementation-plan', 1)).toBeDefined();

      // Replace with a different set
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 2)]);

      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);
      expect(registry.getBuilder('implementation-plan', 1)).toBeUndefined();
    });

    it('replacement with empty array removes all builders for the owner', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);
      expect(registry.getBuilder('review-report', 1)).toBeDefined();

      registry.replaceBuildersForOwner('ext-a', []);
      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
    });

    it('replacement with empty array is equivalent to removal for getBuildersForOwner', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);
      expect(registry.getBuildersForOwner('ext-a')).toHaveLength(1);

      registry.replaceBuildersForOwner('ext-a', []);
      expect(registry.getBuildersForOwner('ext-a')).toBeUndefined();
    });

    it('does not affect builders from other owners', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);
      registry.replaceBuildersForOwner('ext-b', [makeBuilder('implementation-plan', 1)]);

      // Replace ext-a
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 2)]);

      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);
      expect(registry.getBuilder('implementation-plan', 1)).toBeDefined();
    });

    it('detaches stored builders from the caller-supplied array', () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builders = [makeBuilder('review-report', 1)];
      registry.replaceBuildersForOwner('ext-a', builders);

      // Mutating the input array should not affect the registry
      builders.length = 0;
      expect(registry.getBuilder('review-report', 1)).toBeDefined();
    });

    it('stores frozen copies detached from the caller-supplied builder objects', () => {
      const registry = new ArtifactViewBuilderRegistry();
      const mutable: {
        kind: string;
        schemaVersion: number;
        version: number;
        build: ArtifactViewBuilder['build'];
      } = {
        kind: 'review-report',
        schemaVersion: 1,
        version: 1,
        build: async () => undefined,
      };
      registry.replaceBuildersForOwner('ext-a', [mutable]);

      // Mutating the caller's object after registration must not
      // desynchronize the registry's index or stored state.
      mutable.kind = 'hijacked-kind';
      mutable.version = 99;

      const found = registry.getBuilder('review-report', 1);
      expect(found).toBeDefined();
      expect(found!.kind).toBe('review-report');
      expect(found!.version).toBe(1);
      expect(registry.getBuilder('hijacked-kind', 1)).toBeUndefined();
    });

    it('returns frozen builder objects from lookups', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);

      expect(Object.isFrozen(registry.getBuilder('review-report', 1))).toBe(true);
      expect(Object.isFrozen(registry.getBuildersForOwner('ext-a')![0])).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Intra-owner duplicate detection                                           */
  /* -------------------------------------------------------------------------- */

  describe('intra-owner collision', () => {
    it('rejects duplicate kind + schemaVersion within the same owner', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [
          makeBuilder('review-report', 1, 1),
          makeBuilder('review-report', 1, 2),
        ]);
      }).toThrow(ArtifactViewBuilderCollisionError);
    });

    it('collision error identifies the owner', () => {
      const registry = new ArtifactViewBuilderRegistry();
      try {
        registry.replaceBuildersForOwner('ext-a', [
          makeBuilder('review-report', 1, 1),
          makeBuilder('review-report', 1, 2),
        ]);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactViewBuilderCollisionError);
        const collision = error as ArtifactViewBuilderCollisionError;
        expect(collision.incomingOwner).toBe('ext-a');
        expect(collision.existingOwner).toBe('ext-a');
        expect(collision.key).toBe(JSON.stringify(['review-report', 1]));
      }
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Cross-owner collision detection                                           */
  /* -------------------------------------------------------------------------- */

  describe('cross-owner collision', () => {
    it('rejects the same kind + schemaVersion from different owners', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);

      expect(() => {
        registry.replaceBuildersForOwner('ext-b', [makeBuilder('review-report', 1)]);
      }).toThrow(ArtifactViewBuilderCollisionError);
    });

    it('collision error identifies both owners', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);

      try {
        registry.replaceBuildersForOwner('ext-b', [makeBuilder('review-report', 1)]);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactViewBuilderCollisionError);
        const collision = error as ArtifactViewBuilderCollisionError;
        expect(collision.incomingOwner).toBe('ext-b');
        expect(collision.existingOwner).toBe('ext-a');
      }
    });

    it('allows the same owner to replace its own key', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 1)]);

      // Same owner, same key — this is a replacement, not a collision
      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 2)]);
      }).not.toThrow();

      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);
    });

    it('allows different kind + schemaVersion across owners', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);

      expect(() => {
        registry.replaceBuildersForOwner('ext-b', [makeBuilder('implementation-plan', 1)]);
      }).not.toThrow();

      expect(registry.getBuilder('review-report', 1)).toBeDefined();
      expect(registry.getBuilder('implementation-plan', 1)).toBeDefined();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Rollback / no partial mutation                                            */
  /* -------------------------------------------------------------------------- */

  describe('rollback on collision', () => {
    it('leaves state unchanged when cross-owner collision occurs', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 1)]);

      expect(() => {
        registry.replaceBuildersForOwner('ext-b', [
          makeBuilder('implementation-plan', 1, 1),
          makeBuilder('review-report', 1, 2), // collides with ext-a
        ]);
      }).toThrow(ArtifactViewBuilderCollisionError);

      // ext-a's builder should be intact
      expect(registry.getBuilder('review-report', 1)!.version).toBe(1);
      // ext-b's non-colliding builder should NOT be registered
      expect(registry.getBuilder('implementation-plan', 1)).toBeUndefined();
      // ext-b should have no registered builders
      expect(registry.getBuildersForOwner('ext-b')).toBeUndefined();
    });

    it('leaves state unchanged when intra-owner collision occurs during replacement', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 1)]);

      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [
          makeBuilder('implementation-plan', 1, 1),
          makeBuilder('implementation-plan', 1, 2), // intra-owner duplicate
        ]);
      }).toThrow(ArtifactViewBuilderCollisionError);

      // Previous ext-a builder should be intact (intra-owner validation
      // happens before the candidate index is built)
      expect(registry.getBuilder('review-report', 1)!.version).toBe(1);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Owner removal                                                             */
  /* -------------------------------------------------------------------------- */

  describe('removeBuildersForOwner', () => {
    it('removes all builders for an owner', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [
        makeBuilder('review-report', 1),
        makeBuilder('implementation-plan', 1),
      ]);

      registry.removeBuildersForOwner('ext-a');

      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
      expect(registry.getBuilder('implementation-plan', 1)).toBeUndefined();
      expect(registry.getBuildersForOwner('ext-a')).toBeUndefined();
    });

    it('is a no-op for unknown owners', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(() => {
        registry.removeBuildersForOwner('unknown');
      }).not.toThrow();
    });

    it('does not affect builders from other owners', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);
      registry.replaceBuildersForOwner('ext-b', [makeBuilder('implementation-plan', 1)]);

      registry.removeBuildersForOwner('ext-a');

      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
      expect(registry.getBuilder('implementation-plan', 1)).toBeDefined();
    });

    it('frees the key for re-registration by another owner', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1, 1)]);

      registry.removeBuildersForOwner('ext-a');

      expect(() => {
        registry.replaceBuildersForOwner('ext-b', [makeBuilder('review-report', 1, 2)]);
      }).not.toThrow();

      expect(registry.getBuilder('review-report', 1)!.version).toBe(2);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  getBuildersForOwner                                                       */
  /* -------------------------------------------------------------------------- */

  describe('getBuildersForOwner', () => {
    it('returns undefined for unknown owners', () => {
      const registry = new ArtifactViewBuilderRegistry();
      expect(registry.getBuildersForOwner('unknown')).toBeUndefined();
    });

    it('returns a detached copy of the builder list', () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builder = makeBuilder('review-report', 1);
      registry.replaceBuildersForOwner('ext-a', [builder]);

      const snapshot = registry.getBuildersForOwner('ext-a');
      expect(snapshot).toHaveLength(1);

      // Mutating the snapshot should not affect the registry
      (snapshot as ArtifactViewBuilder[]).length = 0;
      expect(registry.getBuildersForOwner('ext-a')).toHaveLength(1);
    });

    it('preserves builder function identity', () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builder = makeBuilder('review-report', 1);
      registry.replaceBuildersForOwner('ext-a', [builder]);

      const snapshot = registry.getBuildersForOwner('ext-a');
      expect(snapshot![0]!.build).toBe(builder.build);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Builder outcomes                                                          */
  /* -------------------------------------------------------------------------- */

  describe('builder outcomes', () => {
    it('builder returning undefined keeps generic sections', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builder = makeBuilder('review-report', 1, 1, undefined);
      registry.replaceBuildersForOwner('ext-a', [builder]);

      const found = registry.getBuilder('review-report', 1)!;
      const result = await found.build({
        artifact: {
          kind: 'review-report',
          id: 'a-1',
          revision: 'r-1',
          schemaVersion: 1,
          scope: { level: 'global' },
          data: {},
          relations: [],
          actor: { kind: 'agent', id: 'agent-1' },
          timestamp: 1,
        },
        level: 'full',
        affordance: { kind: 'own-view' },
        params: undefined,
        genericSections: [{ type: 'summary', title: 'Summary', text: 'test' }],
        genericNavigation: { breadcrumbs: [], related: [] },
        relations: [],
      });
      expect(result).toBeUndefined();
    });

    it('builder returning sections replaces generic sections', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const replacementSections = [{ type: 'summary' as const, title: 'Custom', text: 'custom text' }];
      const builder = makeBuilder('review-report', 1, 1, { sections: replacementSections });
      registry.replaceBuildersForOwner('ext-a', [builder]);

      const found = registry.getBuilder('review-report', 1)!;
      const result = await found.build({
        artifact: {
          kind: 'review-report',
          id: 'a-1',
          revision: 'r-1',
          schemaVersion: 1,
          scope: { level: 'global' },
          data: {},
          relations: [],
          actor: { kind: 'agent', id: 'agent-1' },
          timestamp: 1,
        },
        level: 'full',
        affordance: { kind: 'own-view' },
        params: undefined,
        genericSections: [],
        genericNavigation: { breadcrumbs: [], related: [] },
        relations: [],
      });
      expect(result).toEqual({ sections: replacementSections });
    });

    it('builder returning render: false suppresses rendering', async () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builder = makeBuilder('review-report', 1, 1, { render: false });
      registry.replaceBuildersForOwner('ext-a', [builder]);

      const found = registry.getBuilder('review-report', 1)!;
      const result = await found.build({
        artifact: {
          kind: 'review-report',
          id: 'a-1',
          revision: 'r-1',
          schemaVersion: 1,
          scope: { level: 'global' },
          data: {},
          relations: [],
          actor: { kind: 'agent', id: 'agent-1' },
          timestamp: 1,
        },
        level: 'full',
        affordance: { kind: 'own-view' },
        params: undefined,
        genericSections: [],
        genericNavigation: { breadcrumbs: [], related: [] },
        relations: [],
      });
      expect(result).toEqual({ render: false });
    });
  });

  /* -------------------------------------------------------------------------- */
  /*  Open string kinds                                                         */
  /* -------------------------------------------------------------------------- */

  describe('open string kinds', () => {
    it('accepts arbitrary kind strings not known to framework source', () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builder = makeBuilder('product-custom-widget', 3, 1);

      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [builder]);
      }).not.toThrow();

      expect(registry.getBuilder('product-custom-widget', 3)).toBeDefined();
    });

    it('accepts positive integer schema versions', () => {
      const registry = new ArtifactViewBuilderRegistry();
      const builder = makeBuilder('review-report', 20240713, 1);

      expect(() => {
        registry.replaceBuildersForOwner('ext-a', [builder]);
      }).not.toThrow();

      expect(registry.getBuilder('review-report', 20240713)).toBeDefined();
    });

    it('removes all registrations', () => {
      const registry = new ArtifactViewBuilderRegistry();
      registry.replaceBuildersForOwner('ext-a', [makeBuilder('review-report', 1)]);
      registry.replaceBuildersForOwner('ext-b', [makeBuilder('implementation-plan', 1)]);

      registry.clear();

      expect(registry.getBuilder('review-report', 1)).toBeUndefined();
      expect(registry.getBuilder('implementation-plan', 1)).toBeUndefined();
      expect(registry.getBuildersForOwner('ext-a')).toBeUndefined();
      expect(registry.getBuildersForOwner('ext-b')).toBeUndefined();
    });
  });
});
