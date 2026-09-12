/**
 * Part-id invariants enforced by patchArtifact for kinds declaring addressableParts.
 *
 * patchArtifact checks, after applying patch instructions and before persisting,
 * that every part id in every declared addressable area is non-blank and unique
 * across all declared areas of the same revision. These tests exercise that gate:
 *   - a blank or whitespace-only id in any area is rejected
 *   - a duplicate id within one area is rejected
 *   - a duplicate id that spans two declared areas is rejected
 *   - the check runs on dry-run requests and suppresses persistence there too
 *   - a valid patch (all ids present, distinct) succeeds and is not over-blocked
 *   - on a schema-version migration the TARGET registration's addressableParts
 *     govern the check, not the base revision's registration
 */
import { describe, expect, it } from 'vitest';
import {
  ArtifactKindRegistrationSchema,
  ArtifactRevisionSchema,
  type ArtifactKindRegistration,
  type ArtifactRevision,
} from '@makaio/contracts';
import { host, patch, type ArtifactPatchHost } from './patch-artifact.test-support.js';

// ─── kind fixtures ────────────────────────────────────────────────────────────

/** One addressable area: `items` with `id` as the part identifier. */
const singleAreaKind = ArtifactKindRegistrationSchema.parse({
  kind: 'part-bearer',
  description: 'Kind with one addressable area used by part-id patch tests.',
  schemaVersion: 1,
  category: 'commitment',
  titlePath: 'title',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
          },
        },
      },
    },
    required: ['title'],
  },
  addressableParts: [{ path: 'items', idPath: 'id' }],
});

/**
 * Two addressable areas: `items` and `extras`, both sharing the global id
 * namespace (duplicate detection spans both areas).
 */
const twoAreaKind = ArtifactKindRegistrationSchema.parse({
  kind: 'two-area-bearer',
  description: 'Kind with two addressable areas for cross-area duplicate tests.',
  schemaVersion: 1,
  category: 'commitment',
  titlePath: 'title',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
          },
        },
      },
      extras: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
    },
    required: ['title'],
  },
  addressableParts: [
    { path: 'items', idPath: 'id' },
    { path: 'extras', idPath: 'id' },
  ],
});

// ─── data fixtures ────────────────────────────────────────────────────────────

const SINGLE_AREA_DATA = {
  title: 'Part-id tests',
  items: [
    { id: 'alpha', label: 'First item' },
    { id: 'beta', label: 'Second item' },
  ],
} as const;

const TWO_AREA_DATA = {
  title: 'Two-area tests',
  items: [{ id: 'alpha', label: 'Item one' }],
  extras: [{ id: 'gamma', note: 'Extra one' }],
} as const;

// ─── revision builder ─────────────────────────────────────────────────────────

function makeRevision(
  reg: ArtifactKindRegistration,
  id: string,
  revision: string,
  data: Record<string, unknown>,
): ArtifactRevision {
  return ArtifactRevisionSchema.parse({
    kind: reg.kind,
    id,
    revision,
    schemaVersion: reg.schemaVersion,
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'agent', id: 'test' },
    timestamp: 0,
  });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('addressable-parts: blank part id', () => {
  it('rejects a patch whose result carries a blank part id; persistence NOT called', async () => {
    const current = makeRevision(singleAreaKind, 'art-1', 'rev-1', structuredClone(SINGLE_AREA_DATA));
    const target = host({ registrations: [singleAreaKind], current });

    const response = await patch(
      {
        ref: { kind: 'part-bearer', id: 'art-1' },
        baseRevision: 'rev-1',
        // Setting to whitespace-only triggers the blank-id invariant.
        patch: { $set: { 'items.0.id': '   ' } },
      },
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        // The concrete path identifies which element's id is blank.
        issues: [{ path: 'items.0.id' }],
        repair: expect.any(String),
      },
    });
    expect(response.ok ? undefined : response.error.issues?.length).toBeGreaterThan(0);
    expect(target.stored).toStrictEqual([]);
  });
});

describe('addressable-parts: duplicate part ids', () => {
  it('rejects a patch that duplicates an id within one area; persistence NOT called', async () => {
    const current = makeRevision(singleAreaKind, 'art-1', 'rev-1', structuredClone(SINGLE_AREA_DATA));
    const target = host({ registrations: [singleAreaKind], current });

    const response = await patch(
      {
        ref: { kind: 'part-bearer', id: 'art-1' },
        baseRevision: 'rev-1',
        // items[1] already has 'beta'; overwriting to 'alpha' duplicates items[0].
        patch: { $set: { 'items.1.id': 'alpha' } },
      },
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        // The second occurrence is the duplicate; its path is the reported issue.
        issues: [{ path: 'items.1.id' }],
        repair: expect.any(String),
      },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects a patch that duplicates an id across two declared areas; persistence NOT called', async () => {
    const current = makeRevision(twoAreaKind, 'art-2', 'rev-1', structuredClone(TWO_AREA_DATA));
    const target = host({ registrations: [twoAreaKind], current });

    const response = await patch(
      {
        ref: { kind: 'two-area-bearer', id: 'art-2' },
        baseRevision: 'rev-1',
        // extras[0].id is set to 'alpha' which already exists in items[0].
        patch: { $set: { 'extras.0.id': 'alpha' } },
      },
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        // The duplicate is detected at the extras area's element.
        issues: [{ path: 'extras.0.id' }],
        repair: expect.any(String),
      },
    });
    expect(target.stored).toStrictEqual([]);
  });
});

describe('addressable-parts: dry-run propagates the part-id error', () => {
  it('returns PAYLOAD_INVARIANT_FAILED on a dry run and does not write', async () => {
    const current = makeRevision(singleAreaKind, 'art-1', 'rev-1', structuredClone(SINGLE_AREA_DATA));
    const target = host({ registrations: [singleAreaKind], current });

    const response = await patch(
      {
        ref: { kind: 'part-bearer', id: 'art-1' },
        baseRevision: 'rev-1',
        patch: { $set: { 'items.0.id': '   ' } },
        dryRun: true,
      },
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        issues: [{ path: 'items.0.id' }],
      },
    });
    expect(target.stored).toStrictEqual([]);
  });
});

describe('addressable-parts: valid patch succeeds (regression)', () => {
  it('does not reject a patch whose result carries only valid, distinct part ids', async () => {
    const current = makeRevision(singleAreaKind, 'art-1', 'rev-1', structuredClone(SINGLE_AREA_DATA));
    const target = host({ registrations: [singleAreaKind], current });

    const response = await patch(
      {
        ref: { kind: 'part-bearer', id: 'art-1' },
        baseRevision: 'rev-1',
        // Changing a label leaves ids untouched; the check must not over-fire.
        patch: { $set: { 'items.0.label': 'Updated label' } },
      },
      target,
    );

    expect(response).toMatchObject({ ok: true });
    expect(target.stored).toHaveLength(1);
    expect(target.stored[0]).toMatchObject({ items: [{ id: 'alpha', label: 'Updated label' }, { id: 'beta' }] });
  });
});

describe('addressable-parts: migration uses TARGET registration areas', () => {
  /**
   * Verifies that checkPartIds is bound to the TARGET registration, not the
   * base one. Setup:
   *   - v1 registration declares NO addressableParts (pre-constraint era).
   *   - v2 registration adds addressableParts.
   *   - The base revision carries data with two items that share the same id —
   *     permitted before validation existed.
   *   - A migration patch (schemaVersion: 2) must fail with PAYLOAD_INVARIANT_FAILED
   *     because the TARGET enforces the id invariant.
   */
  it('enforces the TARGET registration addressableParts on a migration, not the base', async () => {
    const baseReg = ArtifactKindRegistrationSchema.parse({
      kind: 'migrating-bearer',
      description: 'v1 — no addressable areas.',
      schemaVersion: 1,
      category: 'commitment',
      titlePath: 'title',
      dataSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' } },
            },
          },
        },
        required: ['title'],
      },
      // No addressableParts at v1.
    });

    const targetReg = ArtifactKindRegistrationSchema.parse({
      ...baseReg,
      description: 'v2 — adds addressableParts.',
      schemaVersion: 2,
      addressableParts: [{ path: 'items', idPath: 'id' }],
    });

    // Current revision at v1 — items with duplicate ids were allowed before
    // the constraint was introduced.
    const duplicateData = {
      title: 'Pre-constraint artifact',
      items: [{ id: 'dup' }, { id: 'dup' }],
    };
    const current = ArtifactRevisionSchema.parse({
      kind: 'migrating-bearer',
      id: 'mig-1',
      revision: 'rev-1',
      schemaVersion: 1,
      scope: { level: 'global' },
      data: duplicateData,
      relations: [],
      actor: { kind: 'agent', id: 'test' },
      timestamp: 0,
    });

    const stored: Record<string, unknown>[] = [];
    // The host serves ONLY the target registration (v2); the engine resolves
    // that as the migration target (same pattern as 'migrating between schema
    // versions' in the main suite).
    const migratingHost: ArtifactPatchHost = {
      listKinds: async (requested) => (requested === 'migrating-bearer' ? [targetReg] : []),
      resolveCurrent: async () => current,
      store: async (request) => {
        stored.push(request.data);
        return { ...current, revision: 'rev-2', schemaVersion: 2, data: request.data };
      },
    };

    const response = await patch(
      {
        ref: { kind: 'migrating-bearer', id: 'mig-1' },
        baseRevision: 'rev-1',
        // A no-op instruction is enough; the payload already has duplicate ids.
        patch: { $set: { title: 'Migrated' } },
        schemaVersion: 2,
      },
      migratingHost,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        // items[1].id is the duplicate; the TARGET (v2) detected it.
        issues: [{ path: 'items.1.id' }],
      },
    });
    expect(stored).toStrictEqual([]);
  });
});
