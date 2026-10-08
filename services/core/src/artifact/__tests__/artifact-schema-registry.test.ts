import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createBusInstance, RequestError, type IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  ArtifactKindRegistrationSchema,
  RelationTypeConflictError,
  type ArtifactKindRegistration,
  type RelationTypeRegistration,
} from '@makaio/contracts';
import { ArtifactSchemaRegistry } from '../artifact-schema-registry.js';

/**
 * Add the shared readable-title requirement to a registry fixture schema.
 * @param schema - Additional schema fields for a specific test.
 * @returns A schema with a required title and the requested test properties.
 */
function titleSchema(schema: ArtifactKindRegistration['dataSchema'] = {}): ArtifactKindRegistration['dataSchema'] {
  const properties = schema.properties;
  return {
    type: 'object',
    ...schema,
    properties: {
      ...(properties !== null && typeof properties === 'object' && !Array.isArray(properties) ? properties : {}),
      title: { type: 'string' },
    },
    required: [...new Set([...(Array.isArray(schema.required) ? schema.required : []), 'title'])],
  };
}

/**
 * Builds a minimal {@link ArtifactKindRegistration} for use in tests.
 * @param kind - Kind discriminator string.
 * @param schemaVersion - Positive schema version.
 * @param dataSchema - Optional JSON Schema for the kind's data payload.
 * @returns A minimal valid kind registration.
 */
function makeKind(
  kind: string,
  schemaVersion: number,
  dataSchema: ArtifactKindRegistration['dataSchema'] = titleSchema(),
): ArtifactKindRegistration {
  return {
    kind,
    description: `${kind} test kind`,
    schemaVersion,
    dataSchema: titleSchema(dataSchema),
    category: 'knowledge' as const,
    titlePath: 'title',
  };
}

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

  it('rejects legacy registration metadata at the bus boundary', async () => {
    const registration = { ...makeKind('note', 1), conflictPolicy: 'coexist' };
    await expect(bus.request(ArtifactSubjects.kind.register, registration)).rejects.toThrow();
    expect(registry.getKind('note', 1)).toBeUndefined();
  });

  it('validates an entire owner replacement before removing its existing registrations', () => {
    const owner = { source: 'extension' as const, ownerKey: 'test' };
    const current = makeKind('note', 1);
    registry.replaceKindRegistrationsForOwner(owner, [current]);
    const invalid = { ...makeKind('other', 1), titlePath: 'absent' };
    expect(() => registry.replaceKindRegistrationsForOwner(owner, [makeKind('new', 1), invalid])).toThrow();
    expect(registry.getKind('note', 1)).toEqual(current);
    expect(registry.getKind('new', 1)).toBeUndefined();
  });

  it.each([
    undefined,
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2020-12/schema',
  ])('accepts supported dialect %s through direct and batch registration', async (dialect) => {
    const dataSchema = dialect === undefined ? titleSchema() : titleSchema({ $schema: dialect });
    const direct = makeKind('direct', 1, dataSchema);
    registry.registerKind(direct);
    expect(registry.getKind('direct', 1)).toEqual(direct);
    const batch = makeKind('batch', 1, dataSchema);
    registry.replaceKindRegistrationsForOwner({ source: 'extension', ownerKey: 'dialects' }, [batch]);
    expect(registry.getKind('batch', 1)).toEqual(batch);
    const busKind = makeKind('bus', 1, dataSchema);
    await bus.request(ArtifactSubjects.kind.register, busKind);
    expect(registry.getKind('bus', 1)).toEqual(busKind);
  });

  it.each([
    'https://json-schema.org/draft/2019-09/schema',
    'https://example.org/schema',
  ])('rejects unsupported dialect %s before any registry mutation', async (dialect) => {
    const owner = { source: 'extension' as const, ownerKey: 'dialects' };
    const current = makeKind('current', 1);
    registry.registerKind(current, owner);
    const invalid = makeKind('current', 1, titleSchema({ $schema: dialect }));
    expect(() => registry.registerKind(invalid, owner)).toThrow(/Unsupported data schema dialect/);
    expect(registry.getKind('current', 1)).toEqual(current);
    expect(() => registry.replaceKindRegistrationsForOwner(owner, [makeKind('new', 1), invalid])).toThrow(
      /Unsupported data schema dialect/,
    );
    expect(registry.getKind('current', 1)).toEqual(current);
    expect(registry.getKind('new', 1)).toBeUndefined();
    await expect(bus.request(ArtifactSubjects.kind.register, invalid)).rejects.toThrow(
      /Unsupported data schema dialect/,
    );
    expect(registry.getKind('current', 1)).toEqual(current);
  });

  it.each([
    undefined,
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2020-12/schema',
  ])('rejects malformed complete schemas before direct, bus or batch mutations (%s)', async (dialect) => {
    const owner = { source: 'extension' as const, ownerKey: 'validated-owner' };
    const current = makeKind('current', 2);
    registry.registerKind(current, owner);
    const invalid = makeKind('current', 2, {
      ...(dialect === undefined ? {} : { $schema: dialect }),
      properties: { optional: { type: 'string', minLength: '1' } },
    });
    expect(ArtifactKindRegistrationSchema.safeParse(invalid).success).toBe(true);
    const failure = /Invalid data schema for artifact kind 'current' version '2'.*minLength/;
    expect(() => registry.registerKind(invalid, owner)).toThrow(failure);
    expect(registry.getKind('current', 2)).toEqual(current);
    await expect(bus.request(ArtifactSubjects.kind.register, invalid)).rejects.toThrow(failure);
    expect(registry.getKind('current', 2)).toEqual(current);
    expect(() => registry.replaceKindRegistrationsForOwner(owner, [makeKind('new', 1), invalid])).toThrow(failure);
    expect(registry.getKind('current', 2)).toEqual(current);
    expect(registry.getKind('new', 1)).toBeUndefined();
  });

  it.each([
    {
      dialect: 'http://json-schema.org/draft-07/schema#',
      tuple: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
    },
    {
      dialect: 'https://json-schema.org/draft/2020-12/schema',
      tuple: { type: 'array', prefixItems: [{ type: 'string' }], items: false },
    },
  ])('compiles the declared $dialect vocabulary and standard formats', ({ dialect, tuple }) => {
    const registration = makeKind('position', 1, {
      $schema: dialect,
      properties: { coordinates: tuple, contact: { type: 'string', format: 'email' } },
    });
    registry.registerKind(registration);
    expect(registry.getKind('position', 1)).toEqual(registration);
  });

  it('accepts the canonical evidence semantic annotation during authoritative registration', () => {
    const registration = makeKind('evidence-record', 1, {
      properties: {
        evidence: { type: 'object', 'x-makaio-value-type': 'evidence/v1' },
      },
    });

    registry.registerKind(registration);

    expect(registry.getKind('evidence-record', 1)).toEqual(registration);
  });

  it.each([
    { optional: { type: 'string', pattern: '[' } },
    { optional: { type: 'string', format: 'not-a-supported-format' } },
  ])('rejects schemas that cannot compile even when their keyword values have valid types', (properties) => {
    const registration = makeKind('invalid', 1, { properties });
    expect(ArtifactKindRegistrationSchema.safeParse(registration).success).toBe(true);
    expect(() => registry.registerKind(registration)).toThrow(
      /Invalid data schema for artifact kind 'invalid' version '1'/,
    );
    expect(registry.getKind('invalid', 1)).toBeUndefined();
  });

  it('isolates local schema identifiers across different Kind registrations', () => {
    const first = makeKind('first', 1, { $id: 'urn:kind:local', properties: { optional: { type: 'string' } } });
    const second = makeKind('second', 1, { $id: 'urn:kind:local', properties: { optional: { type: 'number' } } });
    registry.replaceKindRegistrationsForOwner({ source: 'extension', ownerKey: 'isolated' }, [first, second]);
    expect(registry.getKind('first', 1)).toEqual(first);
    expect(registry.getKind('second', 1)).toEqual(second);
  });

  it('accepts an implicit root object schema through authoritative registration', () => {
    const registration = {
      ...makeKind('implicit', 1),
      dataSchema: { properties: { title: { type: 'string' } }, required: ['title'] },
    };
    registry.registerKind(registration);
    expect(registry.getKind('implicit', 1)).toEqual(registration);
  });

  describe('kind registration and listing', () => {
    it('emits kind.changed when a kind is registered', async () => {
      const changed = new Promise<{ kind: string; schemaVersion: number }>((resolve) => {
        bus.on(ArtifactSubjects.kind.changed, (ctx) => {
          resolve(ctx.payload);
        });
      });
      const registration = {
        kind: 'note',
        description: 'Minimal note kind fixture for kind.changed event test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      };

      await bus.request(ArtifactSubjects.kind.register, registration);

      await expect(changed).resolves.toEqual({ kind: 'note', schemaVersion: 1 });
    });

    it('registers a kind and returns it via kind.list', async () => {
      const planKind = {
        kind: 'implementation-plan',
        description: 'Minimal implementation-plan kind fixture for kind.list registration test.',
        schemaVersion: 1,
        dataSchema: titleSchema({ properties: { status: { type: 'string' } }, required: ['status'] }),
        category: 'knowledge' as const,
        titlePath: 'title',
        indexedFields: ['status'],
      };

      await bus.request(ArtifactSubjects.kind.register, planKind);
      const listed = await bus.request(ArtifactSubjects.kind.list, {});

      expect(listed.kinds).toEqual([planKind]);
    });

    it('registers kind.list { registered: true } response', async () => {
      const registration = {
        kind: 'note',
        description: 'Minimal note kind fixture for registered flag test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      };

      const result = await bus.request(ArtifactSubjects.kind.register, registration);
      expect(result.registered).toBe(true);
    });

    it('returns detached kind records so callers cannot mutate registry state', async () => {
      const registration: ArtifactKindRegistration = {
        kind: 'note',
        description: 'Minimal note kind fixture for detached record mutation test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      };

      await bus.request(ArtifactSubjects.kind.register, registration);
      const listed = await bus.request(ArtifactSubjects.kind.list, { kind: 'note' });
      registration.dataSchema = { type: 'number' };
      listed.kinds[0]!.dataSchema = { type: 'string' };

      expect(registry.getKind('note', 1)?.dataSchema).toEqual(titleSchema());
    });

    it('replaces an existing kind for the same kind+schemaVersion pair', async () => {
      const v1 = {
        kind: 'implementation-plan',
        description: 'Minimal implementation-plan v1 fixture for replacement test.',
        schemaVersion: 1,
        dataSchema: titleSchema({ properties: { status: { type: 'string' } } }),
        category: 'knowledge' as const,
        titlePath: 'title',
      };
      const v1Updated = {
        kind: 'implementation-plan',
        description: 'Minimal implementation-plan v1 updated fixture for replacement test.',
        schemaVersion: 1,
        dataSchema: titleSchema({ properties: { status: { type: 'string' }, priority: { type: 'number' } } }),
        category: 'knowledge' as const,
        titlePath: 'title',
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
        description: 'Minimal plan v1 fixture for distinct-version pair test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      });
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'plan',
        description: 'Minimal plan v2 fixture for distinct-version pair test.',
        schemaVersion: 2,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      });

      const listed = await bus.request(ArtifactSubjects.kind.list, {});
      expect(listed.kinds).toHaveLength(2);
    });

    it('filters kind.list results by kind string', async () => {
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'plan',
        description: 'Minimal plan fixture for kind.list filter-by-kind test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      });
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'note',
        description: 'Minimal note fixture for kind.list filter-by-kind test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
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
        description: 'Minimal plan fixture for deregister-by-version test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      };
      await bus.request(ArtifactSubjects.kind.register, planKind);

      registry.deregisterKind('plan', 1);

      expect(registry.getKind('plan', 1)).toBeUndefined();
      await expect(bus.request(ArtifactSubjects.kind.list, {})).resolves.toEqual({ kinds: [] });
    });

    it('emits kind.changed when a kind is deregistered', async () => {
      await bus.request(ArtifactSubjects.kind.register, {
        kind: 'plan',
        description: 'Minimal plan fixture for kind.changed on deregister test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      });

      const changed = new Promise<{ kind: string; schemaVersion: number }>((resolve) => {
        bus.on(ArtifactSubjects.kind.changed, (ctx) => {
          resolve(ctx.payload);
        });
      });
      registry.deregisterKind('plan', 1);

      await expect(changed).resolves.toEqual({ kind: 'plan', schemaVersion: 1 });
    });

    it('keeps extension-owned kinds ahead of factory and target registrations, then resurfaces lower-priority owners', async () => {
      const extensionKind = makeKind('plan', 1, { type: 'object', properties: { source: { const: 'extension' } } });
      const factoryKind = makeKind('plan', 1, { type: 'object', properties: { source: { const: 'factory' } } });
      const targetKind = makeKind('plan', 1, { type: 'object', properties: { source: { const: 'target' } } });

      registry.registerKind(targetKind, { source: 'target-repo', ownerKey: 'target:acme/factory:acme/app' });
      registry.registerKind(factoryKind, { source: 'factory-repo', ownerKey: 'factory:acme/factory' });
      registry.registerKind(extensionKind, { source: 'extension', ownerKey: 'extension:planner' });

      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(extensionKind.dataSchema);

      registry.deregisterKind('plan', 1, { source: 'extension', ownerKey: 'extension:planner' });
      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(factoryKind.dataSchema);

      registry.deregisterKind('plan', 1, { source: 'factory-repo', ownerKey: 'factory:acme/factory' });
      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(targetKind.dataSchema);
    });

    it('emits kind.changed only when the active winner changes', async () => {
      const extensionKind = makeKind('plan', 1, { type: 'object', properties: { source: { const: 'extension' } } });
      const factoryKind = makeKind('plan', 1, { type: 'object', properties: { source: { const: 'factory' } } });
      const events: Array<{ kind: string; schemaVersion: number }> = [];
      bus.on(ArtifactSubjects.kind.changed, (ctx) => {
        events.push(ctx.payload);
      });

      registry.registerKind(extensionKind, { source: 'extension', ownerKey: 'extension:planner' });
      await vi.waitFor(
        () => {
          expect(events).toEqual([{ kind: 'plan', schemaVersion: 1 }]);
        },
        { timeout: 5000 },
      );

      registry.registerKind(factoryKind, { source: 'factory-repo', ownerKey: 'factory:acme/factory' });
      expect(events).toEqual([{ kind: 'plan', schemaVersion: 1 }]);

      registry.deregisterKind('plan', 1, { source: 'factory-repo', ownerKey: 'factory:acme/factory' });
      expect(events).toEqual([{ kind: 'plan', schemaVersion: 1 }]);

      registry.registerKind(factoryKind, { source: 'factory-repo', ownerKey: 'factory:acme/factory' });
      registry.deregisterKind('plan', 1, { source: 'extension', ownerKey: 'extension:planner' });

      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(factoryKind.dataSchema);
      await vi.waitFor(
        () => {
          expect(events).toEqual([
            { kind: 'plan', schemaVersion: 1 },
            { kind: 'plan', schemaVersion: 1 },
          ]);
        },
        { timeout: 5000 },
      );
    });

    it('uses LIFO ordering for same-tier extension contributors', () => {
      const alphaKind = makeKind('plan', 1, { type: 'object', properties: { owner: { const: 'alpha' } } });
      const betaKind = makeKind('plan', 1, { type: 'object', properties: { owner: { const: 'beta' } } });

      registry.registerKind(alphaKind, { source: 'extension', ownerKey: 'extension:alpha' });
      registry.registerKind(betaKind, { source: 'extension', ownerKey: 'extension:beta' });

      // Later registration wins for extensions (LIFO)
      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(betaKind.dataSchema);

      registry.deregisterKind('plan', 1, { source: 'extension', ownerKey: 'extension:beta' });
      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(alphaKind.dataSchema);
    });

    it('warns and keeps first winner for same-tier repo collision', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const firstKind = makeKind('plan', 1, { type: 'object', properties: { owner: { const: 'first' } } });
      const secondKind = makeKind('plan', 1, { type: 'object', properties: { owner: { const: 'second' } } });

      registry.registerKind(firstKind, { source: 'factory-repo', ownerKey: 'factory:acme/first' });
      registry.registerKind(secondKind, { source: 'factory-repo', ownerKey: 'factory:acme/second' });

      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(firstKind.dataSchema);
      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockRestore();
    });

    it('replaces all registrations for one owner without removing other owners', () => {
      registry.registerKind(makeKind('plan', 1), { source: 'factory-repo', ownerKey: 'factory:acme/factory' });
      registry.registerKind(makeKind('audit', 1), {
        source: 'target-repo',
        ownerKey: 'target:acme/factory:acme/app',
      });

      registry.replaceKindRegistrationsForOwner({ source: 'factory-repo', ownerKey: 'factory:acme/factory' }, [
        makeKind('blueprint', 1),
      ]);

      expect(registry.getKind('plan', 1)).toBeUndefined();
      expect(registry.getKind('blueprint', 1)).toBeDefined();
      expect(registry.getKind('audit', 1)).toBeDefined();
    });

    it('keeps first same-tier repo winner during owner replacement', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const firstKind = makeKind('plan', 1, { type: 'object', properties: { owner: { const: 'first' } } });
      const secondKind = makeKind('plan', 1, { type: 'object', properties: { owner: { const: 'second' } } });
      const refreshedFirstKind = makeKind('plan', 1, {
        type: 'object',
        properties: { owner: { const: 'first' }, refreshed: { type: 'boolean' } },
      });

      registry.replaceKindRegistrationsForOwner({ source: 'target-repo', ownerKey: 'target:acme/factory:acme/app-a' }, [
        firstKind,
      ]);
      registry.replaceKindRegistrationsForOwner({ source: 'target-repo', ownerKey: 'target:acme/factory:acme/app-b' }, [
        secondKind,
      ]);
      registry.replaceKindRegistrationsForOwner({ source: 'target-repo', ownerKey: 'target:acme/factory:acme/app-a' }, [
        refreshedFirstKind,
      ]);

      expect(registry.getKind('plan', 1)?.dataSchema).toEqual(refreshedFirstKind.dataSchema);
      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockRestore();
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
      ).rejects.toThrow(
        "Relation type 'custom-link' is already registered with different symmetry (existing: 'asymmetric', new: 'symmetric')",
      );
    });

    it('rejects conflicting symmetry for a core relation type', async () => {
      await expect(
        bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'derives_from',
          symmetry: 'symmetric',
        }),
      ).rejects.toThrow(
        "Relation type 'derives_from' is already registered with different symmetry (existing: 'asymmetric', new: 'symmetric')",
      );
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

    describe('merged endpoint contributions', () => {
      const docs = { sourceKinds: ['knowledge-document'], targetKinds: ['knowledge-document'] };
      const caps = { sourceKinds: ['capability'], targetKinds: ['capability'] };

      /**
       * Registers the two `part_of` contributions used by several tests.
       * @returns Resolves once both contributions are registered.
       */
      async function registerPartOfContributions(): Promise<void> {
        const first = await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
          ...docs,
        });
        const second = await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
          endpoints: [caps],
        });
        expect([first.registered, second.registered]).toEqual([true, true]);
      }

      it('merges contributions from several modules into one normal-form entry', async () => {
        await registerPartOfContributions();

        const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'part_of' });

        expect(listed.relationTypes).toHaveLength(1);
        const entry = listed.relationTypes[0];
        expect(entry).not.toHaveProperty('sourceKinds');
        expect(entry).not.toHaveProperty('targetKinds');
        // Sorted by structural key JSON([sourceKinds, targetKinds, targetRefClasses]): 'capability' < 'knowledge-document'.
        expect(entry?.endpoints).toEqual([caps, docs]);
      });

      it('deduplicates an identical constrained contribution', async () => {
        for (let i = 0; i < 2; i++) {
          await bus.request(ArtifactSubjects['relation-type'].register, {
            type: 'part_of',
            symmetry: 'asymmetric',
            ...docs,
          });
        }

        const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'part_of' });

        expect(listed.relationTypes).toHaveLength(1);
        expect(listed.relationTypes[0]?.endpoints).toEqual([docs]);
      });

      it('opens the type when an unconstrained contribution follows constrained ones', async () => {
        await registerPartOfContributions();
        await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
        });

        const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'part_of' });

        expect(listed.relationTypes).toHaveLength(1);
        expect(listed.relationTypes[0]).not.toHaveProperty('endpoints');
      });

      it('rejects differing implications and accepts equal ones', async () => {
        await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
          implication: 'has_part',
        });

        const error = await bus
          .request(ArtifactSubjects['relation-type'].register, {
            type: 'part_of',
            symmetry: 'asymmetric',
            implication: 'other_part',
          })
          .catch((value: unknown) => value);

        expect(error).toBeInstanceOf(RequestError);
        expect((error as RequestError).message).toContain(
          "Relation type 'part_of' is already registered with different implication (existing: 'has_part', new: 'other_part')",
        );
        const cause = (error as RequestError).cause;
        expect(cause).toBeInstanceOf(RelationTypeConflictError);
        expect(cause).toMatchObject({ field: 'implication', type: 'part_of' });

        await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
          implication: 'has_part',
        });
        expect(registry.getRelationType('part_of')?.implication).toBe('has_part');
      });

      it('keeps type and per-entry descriptions through merge and listing', async () => {
        await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
          description: 'Source is a component of target',
          endpoints: [
            { sourceKinds: ['capability'], targetKinds: ['capability'], description: 'Capability hierarchy' },
          ],
        });
        await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
          endpoints: [{ sourceKinds: ['knowledge-document'], targetKinds: ['knowledge-document'] }],
        });

        const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'part_of' });

        expect(listed.relationTypes).toEqual([
          {
            type: 'part_of',
            symmetry: 'asymmetric',
            description: 'Source is a component of target',
            endpoints: [
              { sourceKinds: ['capability'], targetKinds: ['capability'], description: 'Capability hierarchy' },
              { sourceKinds: ['knowledge-document'], targetKinds: ['knowledge-document'] },
            ],
          },
        ]);
        expect(registry.getRelationType('part_of')?.description).toBe('Source is a component of target');
      });

      it('rejects differing type descriptions', async () => {
        await bus.request(ArtifactSubjects['relation-type'].register, {
          type: 'part_of',
          symmetry: 'asymmetric',
          description: 'one',
        });

        const error = await bus
          .request(ArtifactSubjects['relation-type'].register, {
            type: 'part_of',
            symmetry: 'asymmetric',
            description: 'two',
          })
          .catch((value: unknown) => value);

        expect(error).toBeInstanceOf(RequestError);
        expect((error as RequestError).cause).toBeInstanceOf(RelationTypeConflictError);
        expect((error as RequestError).cause).toMatchObject({ field: 'description', type: 'part_of' });
        expect(registry.getRelationType('part_of')?.description).toBe('one');
      });

      it('lists core relation types in normal form without endpoints', async () => {
        const listed = await bus.request(ArtifactSubjects['relation-type'].list, {});

        expect(listed.relationTypes.length).toBeGreaterThan(0);
        for (const entry of listed.relationTypes) {
          expect(entry).not.toHaveProperty('endpoints');
          expect(entry).not.toHaveProperty('sourceKinds');
          expect(entry).not.toHaveProperty('targetKinds');
        }
      });

      it('getRelationType returns the merged normal form as a detached clone', async () => {
        await registerPartOfContributions();

        const first = registry.getRelationType('part_of');
        expect(first).toEqual({ type: 'part_of', symmetry: 'asymmetric', endpoints: [caps, docs] });

        first?.endpoints?.[0]?.sourceKinds?.push('x');

        expect(registry.getRelationType('part_of')?.endpoints).toEqual([caps, docs]);
        expect(registry.getRelationType('part_of')?.endpoints?.[0]?.sourceKinds).toEqual(['capability']);
      });

      it('relation-type.list returns detached clones', async () => {
        await registerPartOfContributions();

        const listed = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'part_of' });
        listed.relationTypes[0]?.endpoints?.[1]?.sourceKinds?.push('x');

        const again = await bus.request(ArtifactSubjects['relation-type'].list, { type: 'part_of' });
        expect(again.relationTypes[0]?.endpoints).toEqual([caps, docs]);
        expect(registry.getRelationType('part_of')?.endpoints).toEqual([caps, docs]);
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
        description: 'Minimal plan fixture for getKind direct API test.',
        schemaVersion: 1,
        dataSchema: titleSchema(),
        category: 'knowledge' as const,
        titlePath: 'title',
      };
      await bus.request(ArtifactSubjects.kind.register, planKind);

      expect(registry.getKind('plan', 1)).toEqual(planKind);
    });

    it('getKind returns undefined for an unknown kind', () => {
      expect(registry.getKind('unknown', 1)).toBeUndefined();
    });

    it('getRelationType returns a core relation type', () => {
      expect(registry.getRelationType('supersedes')).toEqual({ type: 'supersedes', symmetry: 'asymmetric' });
    });

    it('getRelationType returns undefined for an unknown type', () => {
      expect(registry.getRelationType('unknown-type')).toBeUndefined();
    });

    it('clears kind and relation state on destroy', async () => {
      registry.registerKind(makeKind('plan', 1), { source: 'factory-repo', ownerKey: 'factory:acme/factory' });

      await registry.destroy();

      expect(registry.getKind('plan', 1)).toBeUndefined();
      expect(registry.getRelationType('supersedes')).toBeUndefined();
    });

    it('drops merged contributions on destroy and re-seeds a clean vocabulary on init', async () => {
      const partOf = { type: 'part_of', symmetry: 'asymmetric' } as const;
      await bus.request(ArtifactSubjects['relation-type'].register, {
        ...partOf,
        sourceKinds: ['knowledge-document'],
        targetKinds: ['knowledge-document'],
      });
      await bus.request(ArtifactSubjects['relation-type'].register, {
        ...partOf,
        endpoints: [{ sourceKinds: ['capability'], targetKinds: ['capability'] }],
      });
      await bus.request(ArtifactSubjects['relation-type'].register, {
        type: 'contains',
        symmetry: 'asymmetric',
        implication: 'x',
      });
      expect(registry.getRelationType('contains')?.implication).toBe('x');

      await registry.destroy();
      await registry.init();

      expect(registry.getRelationType('part_of')).toBeUndefined();
      expect(registry.getRelationType('contains')).toEqual({ type: 'contains', symmetry: 'asymmetric' });

      const result = await bus.request(ArtifactSubjects['relation-type'].register, {
        type: 'contains',
        symmetry: 'asymmetric',
        implication: 'y',
      });
      expect(result.registered).toBe(true);
      expect(registry.getRelationType('contains')?.implication).toBe('y');
    });
  });
});
