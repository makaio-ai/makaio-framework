import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, type ArtifactKindRegistration, type RelationTypeRegistration } from '@makaio/contracts';
import { ArtifactSchemaRegistry } from '../artifact-schema-registry.js';

describe('ArtifactSchemaRegistry', () => {
  let bus: IMakaioBus;
  let registry: ArtifactSchemaRegistry;

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new ArtifactSchemaRegistry(bus);
    await registry.init();
  });

  afterEach(async () => {
    await registry.destroy();
  });

  describe('kind registration and listing', () => {
    it('emits kind.changed when a kind is registered', async () => {
      const changed = new Promise<{ kind: string; schemaVersion: string }>((resolve) => {
        bus.on(ArtifactSubjects.kind.changed, (ctx) => {
          resolve(ctx.payload);
        });
      });
      const registration = {
        kind: 'note',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'coexist' as const,
      };

      await bus.request(ArtifactSubjects.kind.register, registration);

      await expect(changed).resolves.toEqual({ kind: 'note', schemaVersion: '1' });
    });

    it('registers a kind and returns it via kind.list', async () => {
      const planKind = {
        kind: 'implementation-plan',
        schemaVersion: '1',
        dataSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
        conflictPolicy: 'supersedes' as const,
        indexedFields: ['/data/status'],
      };

      await bus.request(ArtifactSubjects.kind.register, planKind);
      const listed = await bus.request(ArtifactSubjects.kind.list, {});

      expect(listed.kinds).toEqual([planKind]);
    });

    it('registers kind.list { registered: true } response', async () => {
      const registration = {
        kind: 'note',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'coexist' as const,
      };

      const result = await bus.request(ArtifactSubjects.kind.register, registration);
      expect(result.registered).toBe(true);
    });

    it('returns detached kind records so callers cannot mutate registry state', async () => {
      const registration: ArtifactKindRegistration = {
        kind: 'note',
        schemaVersion: '1',
        dataSchema: { type: 'object', properties: { title: { type: 'string' } } },
        conflictPolicy: 'coexist' as const,
      };

      await bus.request(ArtifactSubjects.kind.register, registration);
      const listed = await bus.request(ArtifactSubjects.kind.list, { kind: 'note' });
      registration.dataSchema = { type: 'number' };
      listed.kinds[0]!.dataSchema = { type: 'string' };

      expect(registry.getKind('note', '1')?.dataSchema).toEqual({
        type: 'object',
        properties: { title: { type: 'string' } },
      });
    });

    it('replaces an existing kind for the same kind+schemaVersion pair', async () => {
      const v1 = {
        kind: 'implementation-plan',
        schemaVersion: '1',
        dataSchema: { type: 'object', properties: { status: { type: 'string' } } },
        conflictPolicy: 'supersedes' as const,
      };
      const v1Updated = {
        kind: 'implementation-plan',
        schemaVersion: '1',
        dataSchema: { type: 'object', properties: { status: { type: 'string' }, priority: { type: 'number' } } },
        conflictPolicy: 'supersedes' as const,
      };

      await bus.request(ArtifactSubjects.kind.register, v1);
      await bus.request(ArtifactSubjects.kind.register, v1Updated);

      const listed = await bus.request(ArtifactSubjects.kind.list, {});
      expect(listed.kinds).toHaveLength(1);
      expect(listed.kinds[0]?.dataSchema).toEqual(v1Updated.dataSchema);
    });

    it('registers distinct kinds under different kind+schemaVersion pairs', async () => {
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'plan',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'supersedes' as const,
      });
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'plan',
        schemaVersion: '2',
        dataSchema: { type: 'object' },
        conflictPolicy: 'supersedes' as const,
      });

      const listed = await bus.request(ArtifactSubjects.kind.list, {});
      expect(listed.kinds).toHaveLength(2);
    });

    it('filters kind.list results by kind string', async () => {
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'plan',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'supersedes' as const,
      });
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'note',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'coexist' as const,
      });

      const listed = await bus.request(ArtifactSubjects.kind.list, { kind: 'plan' });
      expect(listed.kinds).toHaveLength(1);
      expect(listed.kinds[0]?.kind).toBe('plan');
    });

    it('returns an empty array for kind.list when no kinds are registered', async () => {
      const listed = await bus.request(ArtifactSubjects.kind.list, {});
      expect(listed.kinds).toEqual([]);
    });

    it('deregisters a kind by kind+schemaVersion pair', async () => {
      const planKind = {
        kind: 'plan',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'supersedes' as const,
      };
      await bus.request(ArtifactSubjects.kind.register, planKind);

      registry.deregisterKind('plan', '1');

      expect(registry.getKind('plan', '1')).toBeUndefined();
      await expect(bus.request(ArtifactSubjects.kind.list, {})).resolves.toEqual({ kinds: [] });
    });

    it('emits kind.changed when a kind is deregistered', async () => {
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'plan',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'supersedes' as const,
      });

      const changed = new Promise<{ kind: string; schemaVersion: string }>((resolve) => {
        bus.on(ArtifactSubjects.kind.changed, (ctx) => {
          resolve(ctx.payload);
        });
      });
      registry.deregisterKind('plan', '1');

      await expect(changed).resolves.toEqual({ kind: 'plan', schemaVersion: '1' });
    });
  });

  describe('relation type registration and listing', () => {
    it('registers core relation vocabulary on init', async () => {
      const listed = await bus.request(ArtifactSubjects['relation-type'].list, {});

      expect(listed.relationTypes.map((entry) => entry.type)).toEqual(
        expect.arrayContaining(['supersedes', 'contradicts', 'derives_from', 'responds_to', 'contains', 'refines']),
      );
    });

    it('accepts an identical re-registration of an existing relation type', async () => {
      await bus.request(ArtifactSubjects['relation-type'].register, {
        type: 'derives_from',
        symmetry: 'asymmetric',
      });

      const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'derives_from' });
      expect(listed.relationTypes).toHaveLength(1);
    });

    it('rejects a conflicting duplicate relation type with different symmetry', async () => {
      await bus.request(ArtifactSubjects['relation-type'].register, {
        type: 'custom-link',
        symmetry: 'asymmetric',
      });

      await expect(
        bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'custom-link',
          symmetry: 'symmetric',
        }),
      ).rejects.toThrow("Relation type 'custom-link' is already registered with different symmetry");
    });

    it('rejects conflicting symmetry for a core relation type', async () => {
      await expect(
        bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'derives_from',
          symmetry: 'symmetric',
        }),
      ).rejects.toThrow("Relation type 'derives_from' is already registered with different symmetry");
    });

    it('registers a new custom relation type', async () => {
      await bus.request(ArtifactSubjects['relation-type'].register, {
        type: 'implements',
        symmetry: 'asymmetric',
      });

      const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'implements' });
      expect(listed.relationTypes).toHaveLength(1);
      expect(listed.relationTypes[0]?.type).toBe('implements');
    });

    it('stores detached relation-type records', async () => {
      const registration: RelationTypeRegistration = {
        type: 'external-link',
        symmetry: 'asymmetric',
      };

      await bus.request(ArtifactSubjects['relation-type'].register, registration);
      registration.symmetry = 'symmetric';

      expect(registry.getRelationType('external-link')).toEqual({
        type: 'external-link',
        symmetry: 'asymmetric',
      });
    });

    it('filters relation-type.list by type string', async () => {
      const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'supersedes' });
      expect(listed.relationTypes).toHaveLength(1);
      expect(listed.relationTypes[0]?.type).toBe('supersedes');
    });
  });

  describe('direct API surface', () => {
    it('getKind returns the registration for a known kind+version pair', async () => {
      const planKind = {
        kind: 'plan',
        schemaVersion: '1',
        dataSchema: { type: 'object' },
        conflictPolicy: 'supersedes' as const,
      };
      await bus.request(ArtifactSubjects.kind.register, planKind);

      expect(registry.getKind('plan', '1')).toEqual(planKind);
    });

    it('getKind returns undefined for an unknown kind', () => {
      expect(registry.getKind('unknown', '1')).toBeUndefined();
    });

    it('getRelationType returns a core relation type', () => {
      expect(registry.getRelationType('supersedes')).toEqual({ type: 'supersedes', symmetry: 'asymmetric' });
    });

    it('getRelationType returns undefined for an unknown type', () => {
      expect(registry.getRelationType('unknown-type')).toBeUndefined();
    });
  });
});
