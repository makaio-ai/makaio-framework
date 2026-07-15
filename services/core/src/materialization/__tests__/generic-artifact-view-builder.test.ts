import { describe, expect, it } from 'vitest';

import type { ArtifactViewModel } from '@makaio/contracts';
import { ArtifactViewModelSchema } from '@makaio/contracts';

import { buildGenericArtifactView, GENERIC_ARTIFACT_VIEW_BUILDER_VERSION } from '../generic-artifact-view-builder.js';
import { makeRegistration, makeRevision } from './helpers.js';

/**
 * Assert that a built view validates against the contract schema.
 *
 * Uses `safeParse` so the test error includes Zod issue details instead
 * of a generic "parse failed" message.
 * @param view - View model returned by `buildGenericArtifactView`.
 */
function expectValidViewModel(view: ArtifactViewModel): void {
  const result = ArtifactViewModelSchema.safeParse(view);
  if (!result.success) {
    expect.unreachable(`ArtifactViewModelSchema validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Version constant                                                          */
/* -------------------------------------------------------------------------- */

describe('GENERIC_ARTIFACT_VIEW_BUILDER_VERSION', () => {
  it('is a positive integer', () => {
    expect(GENERIC_ARTIFACT_VIEW_BUILDER_VERSION).toBe(1);
    expect(Number.isInteger(GENERIC_ARTIFACT_VIEW_BUILDER_VERSION)).toBe(true);
    expect(GENERIC_ARTIFACT_VIEW_BUILDER_VERSION).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Dot-path lookup                                                           */
/* -------------------------------------------------------------------------- */

describe('dot-path lookup relative to artifact.data', () => {
  it('resolves a top-level path', () => {
    const revision = makeRevision({ data: { status: 'open' } });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props).toBeDefined();
    expect(props!.type === 'properties' && props!.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Status', value: 'open' })]),
    );
  });

  it('resolves a nested dot path', () => {
    const revision = makeRevision({
      data: { metadata: { priority: 'high' } },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'metadata.priority' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props).toBeDefined();
    expect(props!.type === 'properties' && props!.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Priority', value: 'high' })]),
    );
  });

  it('resolves a deeply nested dot path', () => {
    const revision = makeRevision({
      data: { a: { b: { c: 'deep' } } },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'a.b.c' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props!.type === 'properties' && props!.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'C', value: 'deep' })]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Declaration-order preservation                                            */
/* -------------------------------------------------------------------------- */

describe('declaration-order preservation', () => {
  it('emits properties in the order declared by projectedFields', () => {
    const revision = makeRevision({
      data: { zulu: 'z-val', alpha: 'a-val', mike: 'm-val' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'zulu' }, { path: 'alpha' }, { path: 'mike' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props).toBeDefined();
    if (props!.type === 'properties') {
      expect(props!.rows.map((r) => r.label)).toEqual(['Zulu', 'Alpha', 'Mike']);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Title and summary roles with fallbacks                                    */
/* -------------------------------------------------------------------------- */

describe('title and summary roles', () => {
  it('uses the declared title role field', () => {
    const revision = makeRevision({
      data: { name: 'My Feature' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.title).toBe('My Feature');
  });

  it('falls back to [<kind>] <id> when no title role is declared', () => {
    const revision = makeRevision({
      kind: 'implementation-plan',
      id: 'plan-42',
      data: { status: 'draft' },
    });
    const registration = makeRegistration({
      kind: 'implementation-plan',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.title).toBe('[implementation-plan] plan-42');
  });

  it('keeps representations.summary out of the generic title fallback', () => {
    const revision = makeRevision({
      kind: 'implementation-plan',
      id: 'plan-42',
      data: { status: 'draft' },
      representations: { summary: 'Backend API' },
    });
    const registration = makeRegistration({
      kind: 'implementation-plan',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.title).toBe('[implementation-plan] plan-42');
    expect(view.summary).toBe('Backend API');
  });

  it('falls back to [<kind>] <id> when title role path is missing in data', () => {
    const revision = makeRevision({
      kind: 'bug-report',
      id: 'bug-7',
      data: { description: 'Something is broken' },
    });
    const registration = makeRegistration({
      kind: 'bug-report',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }, { path: 'description' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.title).toBe('[bug-report] bug-7');
  });

  it('falls back to [<kind>] <id> when title role path resolves to a non-scalar', () => {
    const revision = makeRevision({
      data: { name: { first: 'A', last: 'B' } },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.title).toBe('[test-kind] artifact-1');
  });

  it('uses the declared summary role field', () => {
    const revision = makeRevision({
      data: { description: 'A brief description' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'description', viewRole: 'summary' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.summary).toBe('A brief description');
  });

  it('falls back to representations.summary when no summary role is declared', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      representations: { summary: 'This is the artifact summary' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.summary).toBe('This is the artifact summary');
  });

  it('omits summary when no summary role and no representations.summary', () => {
    const revision = makeRevision({
      data: { status: 'open' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.summary).toBeUndefined();
  });

  it('does not duplicate title role field as a property row', () => {
    const revision = makeRevision({
      data: { name: 'My Feature', status: 'open' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }, { path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      const labels = props.rows.map((r) => r.label);
      expect(labels).not.toContain('Name');
      expect(labels).toContain('Status');
    }
  });

  it('does not duplicate summary role field as a property row', () => {
    const revision = makeRevision({
      data: { description: 'Brief', status: 'open' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'description', viewRole: 'summary' }, { path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      const labels = props.rows.map((r) => r.label);
      expect(labels).not.toContain('Description');
      expect(labels).toContain('Status');
    }
  });

  it('uses null scalar as title text', () => {
    const revision = makeRevision({
      data: { name: null },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // null is a valid scalar but not a usable title string
    expect(view.title).toBe('[test-kind] artifact-1');
  });
});

/* -------------------------------------------------------------------------- */
/*  Title and summary level filtering                                         */
/* -------------------------------------------------------------------------- */

describe('title and summary level filtering', () => {
  it('title declared at full level falls back at link level', () => {
    const revision = makeRevision({
      kind: 'feature',
      id: 'feat-1',
      data: { name: 'My Feature' },
    });
    const registration = makeRegistration({
      kind: 'feature',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title', fromLevel: 'full' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'link');

    expect(view.title).toBe('[feature] feat-1');
  });

  it('title declared at full level falls back at summary level', () => {
    const revision = makeRevision({
      kind: 'feature',
      id: 'feat-1',
      data: { name: 'My Feature' },
    });
    const registration = makeRegistration({
      kind: 'feature',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title', fromLevel: 'full' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'summary');

    expect(view.title).toBe('[feature] feat-1');
  });

  it('title declared at full level resolves at full level', () => {
    const revision = makeRevision({
      kind: 'feature',
      id: 'feat-1',
      data: { name: 'My Feature' },
    });
    const registration = makeRegistration({
      kind: 'feature',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title', fromLevel: 'full' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.title).toBe('My Feature');
  });

  it('title with omitted fromLevel (defaults to full) falls back at link level', () => {
    const revision = makeRevision({
      kind: 'feature',
      id: 'feat-1',
      data: { name: 'My Feature' },
    });
    const registration = makeRegistration({
      kind: 'feature',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'link');

    expect(view.title).toBe('[feature] feat-1');
  });

  it('title declared at link level resolves at all levels', () => {
    const revision = makeRevision({
      data: { name: 'My Feature' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title', fromLevel: 'link' }],
      },
    });

    expect(buildGenericArtifactView(revision, registration, 'link').title).toBe('My Feature');
    expect(buildGenericArtifactView(revision, registration, 'summary').title).toBe('My Feature');
    expect(buildGenericArtifactView(revision, registration, 'full').title).toBe('My Feature');
  });

  it('summary declared at full level falls back at link level', () => {
    const revision = makeRevision({
      data: { description: 'Detailed desc' },
      representations: { summary: 'Rep summary' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'description', viewRole: 'summary', fromLevel: 'full' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'link');

    // Falls back to representations.summary since role field is below threshold
    expect(view.summary).toBe('Rep summary');
  });

  it('summary declared at full level resolves at full level', () => {
    const revision = makeRevision({
      data: { description: 'Detailed desc' },
      representations: { summary: 'Rep summary' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'description', viewRole: 'summary', fromLevel: 'full' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.summary).toBe('Detailed desc');
  });

  it('summary declared at link level resolves at all levels', () => {
    const revision = makeRevision({
      data: { description: 'Brief desc' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'description', viewRole: 'summary', fromLevel: 'link' }],
      },
    });

    expect(buildGenericArtifactView(revision, registration, 'link').summary).toBe('Brief desc');
    expect(buildGenericArtifactView(revision, registration, 'summary').summary).toBe('Brief desc');
    expect(buildGenericArtifactView(revision, registration, 'full').summary).toBe('Brief desc');
  });

  it('summary declared at summary level falls back at link level', () => {
    const revision = makeRevision({
      data: { description: 'Summary desc' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'description', viewRole: 'summary', fromLevel: 'summary' }],
      },
    });

    const linkView = buildGenericArtifactView(revision, registration, 'link');
    const summaryView = buildGenericArtifactView(revision, registration, 'summary');

    expect(linkView.summary).toBeUndefined();
    expect(summaryView.summary).toBe('Summary desc');
  });
});

/* -------------------------------------------------------------------------- */
/*  Level filtering                                                           */
/* -------------------------------------------------------------------------- */

describe('level filtering (link < summary < full)', () => {
  const revision = makeRevision({
    data: {
      linkField: 'link-val',
      summaryField: 'summary-val',
      fullField: 'full-val',
      defaultField: 'default-val',
    },
  });
  const registration = makeRegistration({
    projection: {
      mode: 'surface',
      projectedFields: [
        { path: 'linkField', fromLevel: 'link' },
        { path: 'summaryField', fromLevel: 'summary' },
        { path: 'fullField', fromLevel: 'full' },
        { path: 'defaultField' }, // omitted fromLevel => full
      ],
    },
  });

  it('includes only link-level fields at link level', () => {
    const view = buildGenericArtifactView(revision, registration, 'link');
    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      const labels = props.rows.map((r) => r.label);
      expect(labels).toContain('Link Field');
      expect(labels).not.toContain('Summary Field');
      expect(labels).not.toContain('Full Field');
      expect(labels).not.toContain('Default Field');
    }
  });

  it('includes link and summary-level fields at summary level', () => {
    const view = buildGenericArtifactView(revision, registration, 'summary');
    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      const labels = props.rows.map((r) => r.label);
      expect(labels).toContain('Link Field');
      expect(labels).toContain('Summary Field');
      expect(labels).not.toContain('Full Field');
      expect(labels).not.toContain('Default Field');
    }
  });

  it('includes all fields at full level', () => {
    const view = buildGenericArtifactView(revision, registration, 'full');
    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      const labels = props.rows.map((r) => r.label);
      expect(labels).toContain('Link Field');
      expect(labels).toContain('Summary Field');
      expect(labels).toContain('Full Field');
      expect(labels).toContain('Default Field');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Missing paths skipped without fabricating values                          */
/* -------------------------------------------------------------------------- */

describe('missing paths', () => {
  it('skips missing paths without fabricating values', () => {
    const revision = makeRevision({
      data: { exists: 'yes' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'exists' }, { path: 'doesNotExist' }, { path: 'nested.missing' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props).toBeDefined();
    if (props!.type === 'properties') {
      expect(props!.rows).toHaveLength(1);
      expect(props!.rows[0]!.label).toBe('Exists');
    }
  });

  it('produces no section at all when all paths are missing', () => {
    const revision = makeRevision({ data: {} });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'missingA' }, { path: 'missingB' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.sections.filter((s) => s.type === 'properties')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Scalar and scalar-array consolidation into properties                     */
/* -------------------------------------------------------------------------- */

describe('scalar and scalar-array consolidation', () => {
  it('consolidates scalar values into a single properties section', () => {
    const revision = makeRevision({
      data: { status: 'open', priority: 3, active: true },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }, { path: 'priority' }, { path: 'active' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const propSections = view.sections.filter((s) => s.type === 'properties');
    expect(propSections).toHaveLength(1);
    if (propSections[0]!.type === 'properties') {
      expect(propSections[0]!.rows).toHaveLength(3);
    }
  });

  it('consolidates scalar arrays into the properties section', () => {
    const revision = makeRevision({
      data: { tags: ['bug', 'urgent'], status: 'open' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'tags' }, { path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props).toBeDefined();
    if (props!.type === 'properties') {
      const tagsRow = props!.rows.find((r) => r.label === 'Tags');
      expect(tagsRow).toBeDefined();
      expect(tagsRow!.value).toBe('bug, urgent');
    }
  });

  it('treats null as a scalar value', () => {
    const revision = makeRevision({
      data: { nullableField: null },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'nullableField' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props).toBeDefined();
    if (props!.type === 'properties') {
      const row = props!.rows.find((r) => r.label === 'Nullable Field');
      expect(row).toBeDefined();
      expect(row!.value).toBe('null');
    }
  });

  it('treats empty arrays as scalar-array properties', () => {
    const revision = makeRevision({
      data: { emptyTags: [], status: 'open' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'emptyTags' }, { path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    expect(props).toBeDefined();
    if (props!.type === 'properties') {
      const row = props!.rows.find((r) => r.label === 'Empty Tags');
      expect(row).toBeDefined();
      expect(row!.value).toBe('');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Table sections — array-of-records                                         */
/* -------------------------------------------------------------------------- */

describe('table sections for array-of-records', () => {
  it('creates a table section for an array of records', () => {
    const revision = makeRevision({
      data: {
        tasks: [
          { name: 'Task A', status: 'done' },
          { name: 'Task B', status: 'pending' },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'tasks' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const table = view.sections.find((s) => s.type === 'table');
    expect(table).toBeDefined();
    if (table!.type === 'table') {
      expect(table!.title).toBe('Tasks');
      expect(table!.columns).toEqual(['Name', 'Status']);
      expect(table!.rows).toHaveLength(2);
      expect(table!.rows[0]!.cells).toEqual(['Task A', 'done']);
      expect(table!.rows[1]!.cells).toEqual(['Task B', 'pending']);
    }
  });

  it('preserves stable row order', () => {
    const revision = makeRevision({
      data: {
        items: [{ id: 'c' }, { id: 'a' }, { id: 'b' }],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'items' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const table = view.sections.find((s) => s.type === 'table');
    expect(table).toBeDefined();
    if (table!.type === 'table') {
      expect(table!.rows.map((r) => r.cells[0])).toEqual(['c', 'a', 'b']);
    }
  });

  it('uses first-seen union columns (not alphabetical) when first-seen and alphabetical differ', () => {
    const revision = makeRevision({
      data: {
        entries: [
          { zebra: 'z1', alpha: 'a1' },
          { alpha: 'a2', mike: 'm2' },
          { mike: 'm3', zebra: 'z3', bravo: 'b3' },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'entries' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const table = view.sections.find((s) => s.type === 'table');
    expect(table).toBeDefined();
    if (table!.type === 'table') {
      // First-seen order: zebra (row 0), alpha (row 0), mike (row 1), bravo (row 2)
      expect(table!.columns).toEqual(['Zebra', 'Alpha', 'Mike', 'Bravo']);
      // Row 0: zebra=z1, alpha=a1, mike=missing, bravo=missing
      expect(table!.rows[0]!.cells).toEqual(['z1', 'a1', '', '']);
      // Row 1: zebra=missing, alpha=a2, mike=m2, bravo=missing
      expect(table!.rows[1]!.cells).toEqual(['', 'a2', 'm2', '']);
      // Row 2: mike=m3, zebra=z3, bravo=b3
      expect(table!.rows[2]!.cells).toEqual(['z3', '', 'm3', 'b3']);
    }
  });

  it('fills missing cells with empty string', () => {
    const revision = makeRevision({
      data: {
        items: [{ a: '1', b: '2' }, { a: '3' }],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'items' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const table = view.sections.find((s) => s.type === 'table');
    if (table!.type === 'table') {
      expect(table!.rows[1]!.cells).toEqual(['3', '']);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Table classification — scalar-only cell values                            */
/* -------------------------------------------------------------------------- */

describe('table classification requires scalar cell values', () => {
  it('classifies records with nested objects as heterogeneous (raw section)', () => {
    const revision = makeRevision({
      data: {
        items: [
          { name: 'A', config: { timeout: 30 } },
          { name: 'B', config: { timeout: 60 } },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'items' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // Nested objects in values disqualify from table classification
    expect(view.sections.filter((s) => s.type === 'table')).toHaveLength(0);
    const raw = view.sections.find((s) => s.type === 'raw');
    expect(raw).toBeDefined();
    if (raw && raw.type === 'raw') {
      expect(raw.title).toBe('Items');
    }
  });

  it('classifies records with nested arrays as heterogeneous (raw section)', () => {
    const revision = makeRevision({
      data: {
        items: [
          { name: 'A', tags: ['x', 'y'] },
          { name: 'B', tags: ['z'] },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'items' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.sections.filter((s) => s.type === 'table')).toHaveLength(0);
    expect(view.sections.find((s) => s.type === 'raw')).toBeDefined();
  });

  it('allows null values in records as table cells', () => {
    const revision = makeRevision({
      data: {
        items: [
          { name: 'A', status: null },
          { name: 'B', status: 'active' },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'items' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const table = view.sections.find((s) => s.type === 'table');
    expect(table).toBeDefined();
    if (table && table.type === 'table') {
      expect(table.columns).toEqual(['Name', 'Status']);
      // null renders as empty cell
      expect(table.rows[0]!.cells).toEqual(['A', '']);
      expect(table.rows[1]!.cells).toEqual(['B', 'active']);
    }
  });

  it('allows records with only scalar values as table', () => {
    const revision = makeRevision({
      data: {
        items: [
          { name: 'A', count: 1, active: true },
          { name: 'B', count: 2, active: false },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'items' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const table = view.sections.find((s) => s.type === 'table');
    expect(table).toBeDefined();
    if (table && table.type === 'table') {
      expect(table.columns).toEqual(['Name', 'Count', 'Active']);
      expect(table.rows).toHaveLength(2);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Raw sections — objects and heterogeneous arrays                           */
/* -------------------------------------------------------------------------- */

describe('raw sections for objects and heterogeneous arrays', () => {
  it('creates a raw section for an object field', () => {
    const revision = makeRevision({
      data: { config: { timeout: 30, retries: 3 } },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'config' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const raw = view.sections.find((s) => s.type === 'raw');
    expect(raw).toBeDefined();
    if (raw!.type === 'raw') {
      expect(raw!.title).toBe('Config');
      expect(raw!.json).toEqual({ timeout: 30, retries: 3 });
    }
  });

  it('creates a raw section for a heterogeneous array (records mixed with scalars)', () => {
    const revision = makeRevision({
      data: { mixed: [{ a: 1 }, 'string-val', null] },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'mixed' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const raw = view.sections.find((s) => s.type === 'raw');
    expect(raw).toBeDefined();
    if (raw!.type === 'raw') {
      expect(raw!.title).toBe('Mixed');
      expect(raw!.json).toEqual([{ a: 1 }, 'string-val', null]);
    }
  });

  it('creates a raw section for an array mixing records with null', () => {
    const revision = makeRevision({
      data: { nullMixed: [{ x: 1 }, null] },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'nullMixed' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const raw = view.sections.find((s) => s.type === 'raw');
    expect(raw).toBeDefined();
    if (raw!.type === 'raw') {
      expect(raw!.title).toBe('Null Mixed');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Raw section mutation isolation                                            */
/* -------------------------------------------------------------------------- */

describe('raw section mutation isolation', () => {
  it('mutating a raw section does not affect the source revision', () => {
    const revision = makeRevision({
      data: { config: { timeout: 30, retries: 3 } },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'config' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const raw = view.sections.find((s) => s.type === 'raw');
    expect(raw).toBeDefined();
    if (raw && raw.type === 'raw') {
      // Mutate the view's raw section
      (raw.json as Record<string, unknown>).timeout = 999;
      (raw.json as Record<string, unknown>).injected = 'evil';
    }

    // The original revision data must be untouched
    expect(revision.data.config).toEqual({ timeout: 30, retries: 3 });
  });

  it('mutating the source revision does not affect the built view', () => {
    const revision = makeRevision({
      data: { config: { timeout: 30, retries: 3 } },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'config' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // Mutate the original revision data
    (revision.data.config as Record<string, unknown>).timeout = 999;

    // The built view must be unaffected
    const raw = view.sections.find((s) => s.type === 'raw');
    expect(raw).toBeDefined();
    if (raw && raw.type === 'raw') {
      expect((raw.json as Record<string, unknown>).timeout).toBe(30);
    }
  });

  it('heterogeneous array raw sections are also detached', () => {
    const revision = makeRevision({
      data: { mixed: [{ a: 1 }, 'string-val', null] },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'mixed' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const raw = view.sections.find((s) => s.type === 'raw');
    expect(raw).toBeDefined();
    if (raw && raw.type === 'raw') {
      // Mutate the view's raw section
      (raw.json as unknown[])[0] = 'replaced';
    }

    // Original array must be untouched
    expect(revision.data.mixed).toEqual([{ a: 1 }, 'string-val', null]);
  });
});

/* -------------------------------------------------------------------------- */
/*  No whole-data raw fallback                                                */
/* -------------------------------------------------------------------------- */

describe('no whole-data raw fallback', () => {
  it('does not leak all of artifact.data into any raw section', () => {
    const revision = makeRevision({
      data: { secret: 'hidden', visible: 'shown' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'visible' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    for (const section of view.sections) {
      if (section.type === 'raw') {
        expect(section.json).not.toEqual(revision.data);
      }
    }
  });

  it('returns empty sections when no projected fields are declared', () => {
    const revision = makeRevision({
      data: { anything: 'should not appear' },
    });
    const registration = makeRegistration({
      projection: { mode: 'surface' },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // No properties, no tables, no raw
    expect(view.sections.filter((s) => s.type === 'properties' || s.type === 'table' || s.type === 'raw')).toHaveLength(
      0,
    );
  });

  it('returns empty sections when no projection policy exists', () => {
    const revision = makeRevision({
      data: { anything: 'should not appear' },
    });
    const registration = makeRegistration();

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.sections.filter((s) => s.type === 'properties' || s.type === 'table' || s.type === 'raw')).toHaveLength(
      0,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Undeclared fields must never appear                                        */
/* -------------------------------------------------------------------------- */

describe('undeclared field exclusion', () => {
  it('undeclared data fields never appear in any section', () => {
    const revision = makeRevision({
      data: {
        declaredField: 'visible',
        secretApiKey: 'sk-12345',
        internalState: { nested: 'value' },
        hiddenList: [1, 2, 3],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'declaredField' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // Collect all text content from all sections
    const allText = JSON.stringify(view.sections);
    expect(allText).not.toContain('sk-12345');
    expect(allText).not.toContain('internalState');
    expect(allText).not.toContain('hiddenList');

    // Verify only the declared field appears
    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      expect(props.rows).toHaveLength(1);
      expect(props.rows[0]!.label).toBe('Declared Field');
    }
  });

  it('does not project inherited values from declared paths', () => {
    const data = Object.create({ secret: 'inherited' }) as Record<string, unknown>;
    const revision = makeRevision({ data });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'secret' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.sections).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Direct relation sections                                                  */
/* -------------------------------------------------------------------------- */

describe('direct relation sections', () => {
  it('includes direct artifact relations in a relations section at full level', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      relations: [
        {
          type: 'depends-on',
          target: {
            refClass: 'artifact',
            kind: 'task',
            id: 'task-99',
            revision: 'rev-1',
          },
        },
        {
          type: 'blocks',
          target: {
            refClass: 'artifact',
            kind: 'feature',
            id: 'feat-7',
            revision: 'rev-2',
          },
        },
      ],
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const relationSections = view.sections.filter((s) => s.type === 'relations');
    expect(relationSections).toHaveLength(1);
    if (relationSections[0]!.type === 'relations') {
      expect(relationSections[0]!.groups).toHaveLength(2);
      const dependsGroup = relationSections[0]!.groups.find((g) => g.type === 'depends-on');
      expect(dependsGroup).toBeDefined();
      expect(dependsGroup!.items).toHaveLength(1);
      expect(dependsGroup!.items[0]!.artifactId).toBe('task-99');
    }
  });

  it('excludes relation and evidence sections at link level', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      relations: [
        {
          type: 'depends-on',
          target: {
            refClass: 'artifact',
            kind: 'task',
            id: 'task-99',
            revision: 'rev-1',
          },
        },
      ],
      confidence: {
        level: 'confirmed',
        basis: [
          {
            kind: 'human-review',
            actor: { kind: 'user', id: 'u-1' },
            timestamp: Date.now(),
            evidenceRef: {
              refClass: 'evidence',
              kind: 'commit',
              id: 'abc123',
            },
          },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status', fromLevel: 'link' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'link');

    expect(view.sections.filter((s) => s.type === 'relations')).toHaveLength(0);
    expect(view.sections.filter((s) => s.type === 'evidence')).toHaveLength(0);
  });

  it('excludes relation and evidence sections at summary level', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      relations: [
        {
          type: 'depends-on',
          target: {
            refClass: 'artifact',
            kind: 'task',
            id: 'task-99',
            revision: 'rev-1',
          },
        },
      ],
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status', fromLevel: 'summary' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'summary');

    expect(view.sections.filter((s) => s.type === 'relations')).toHaveLength(0);
  });

  it('includes evidence section at full level when confidence basis has evidence refs', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      confidence: {
        level: 'confirmed',
        basis: [
          {
            kind: 'human-review',
            actor: { kind: 'user', id: 'u-1' },
            timestamp: Date.now(),
            evidenceRef: {
              refClass: 'evidence',
              kind: 'commit',
              id: 'abc123',
              locator: 'src/main.ts:42',
            },
          },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const evidence = view.sections.find((s) => s.type === 'evidence');
    expect(evidence).toBeDefined();
    if (evidence!.type === 'evidence') {
      expect(evidence!.items).toHaveLength(1);
      expect(evidence!.items[0]!.kind).toBe('commit');
      expect(evidence!.items[0]!.id).toBe('abc123');
      expect(evidence!.items[0]!.locator).toBe('src/main.ts:42');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Generic breadcrumbs are always empty                                      */
/* -------------------------------------------------------------------------- */

describe('generic breadcrumbs', () => {
  it('produces no breadcrumb-style navigation from context graphs', () => {
    const revision = makeRevision({
      data: { status: 'open' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
      defaultContext: {
        parent: { hint: 'breadcrumb', depth: 1 },
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // Navigation should not contain any breadcrumb-derived entries.
    // The generic builder never interprets defaultContext to generate
    // navigation entries.
    expect(view.navigation ?? []).toEqual([]);
  });

  it('returns empty navigation even when relations are present', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      relations: [
        {
          type: 'parent',
          target: {
            refClass: 'artifact',
            kind: 'project',
            id: 'proj-1',
            revision: 'rev-1',
          },
        },
      ],
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // Direct relations appear in the relations section, not as navigation breadcrumbs
    expect(view.navigation ?? []).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Output is a valid ArtifactViewModel                                       */
/* -------------------------------------------------------------------------- */

describe('output validity', () => {
  it('produces a structurally valid ArtifactViewModel', () => {
    const revision = makeRevision({
      data: {
        name: 'Test',
        tags: ['a', 'b'],
        config: { debug: true },
        items: [{ id: '1' }, { id: '2' }],
      },
      representations: { summary: 'A test artifact' },
      relations: [
        {
          type: 'refs',
          target: {
            refClass: 'artifact',
            kind: 'doc',
            id: 'doc-1',
            revision: 'rev-1',
          },
        },
      ],
      confidence: {
        level: 'stated',
        basis: [
          {
            kind: 'source-reference',
            actor: { kind: 'agent', id: 'a-1' },
            timestamp: Date.now(),
            evidenceRef: {
              refClass: 'evidence',
              kind: 'url',
              id: 'https://example.com',
            },
          },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }, { path: 'tags' }, { path: 'config' }, { path: 'items' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // Contract-level schema validation — exercises .min(1) and section
    // discriminated-union constraints against a representative fixture.
    expectValidViewModel(view);

    // Structural checks against ArtifactViewModel shape
    expect(typeof view.title).toBe('string');
    expect(view.title.length).toBeGreaterThan(0);
    expect(view.summary).toBe('A test artifact');
    expect(Array.isArray(view.sections)).toBe(true);

    // Should have: properties (tags), table (items), raw (config),
    // relations, evidence
    const sectionTypes = view.sections.map((s) => s.type);
    expect(sectionTypes).toContain('properties');
    expect(sectionTypes).toContain('table');
    expect(sectionTypes).toContain('raw');
    expect(sectionTypes).toContain('relations');
    expect(sectionTypes).toContain('evidence');
  });

  it('is deterministic for the same inputs', () => {
    const revision = makeRevision({
      data: {
        name: 'Determinism Test',
        status: 'open',
        items: [{ a: '1' }, { a: '2' }],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }, { path: 'status' }, { path: 'items' }],
      },
    });

    const view1 = buildGenericArtifactView(revision, registration, 'full');
    const view2 = buildGenericArtifactView(revision, registration, 'full');

    expectValidViewModel(view1);
    expect(view1).toEqual(view2);
  });

  it('validates title-fallback output against the contract schema', () => {
    const revision = makeRevision({
      kind: 'implementation-plan',
      id: 'plan-42',
      data: { status: 'draft' },
    });
    const registration = makeRegistration({
      kind: 'implementation-plan',
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expectValidViewModel(view);
    expect(view.title).toBe('[implementation-plan] plan-42');
  });

  it('validates empty-sections output against the contract schema', () => {
    const revision = makeRevision({
      data: { anything: 'should not appear' },
    });
    const registration = makeRegistration({
      projection: { mode: 'surface' },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expectValidViewModel(view);
    expect(view.sections).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Label humanization                                                        */
/* -------------------------------------------------------------------------- */

describe('label humanization', () => {
  it('humanizes camelCase paths', () => {
    const revision = makeRevision({
      data: { firstName: 'Alice' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'firstName' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      expect(props.rows[0]!.label).toBe('First Name');
    }
  });

  it('humanizes kebab-case paths', () => {
    const revision = makeRevision({
      data: { 'last-name': 'Smith' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'last-name' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      expect(props.rows[0]!.label).toBe('Last Name');
    }
  });

  it('humanizes snake_case paths', () => {
    const revision = makeRevision({
      data: { api_key: 'value' },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'api_key' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      expect(props.rows[0]!.label).toBe('Api Key');
    }
  });

  it('uses the last segment of a dot path for the label', () => {
    const revision = makeRevision({
      data: { metadata: { createdBy: 'system' } },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'metadata.createdBy' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      expect(props.rows[0]!.label).toBe('Created By');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Reordered-object fixture                                                  */
/* -------------------------------------------------------------------------- */

describe('reordered-object determinism', () => {
  it('produces the same view regardless of object key insertion order', () => {
    const data1 = { status: 'open', priority: 'high', name: 'Test' };
    const data2 = { name: 'Test', status: 'open', priority: 'high' };
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'name', viewRole: 'title' }, { path: 'status' }, { path: 'priority' }],
      },
    });

    const view1 = buildGenericArtifactView(makeRevision({ data: data1 }), registration, 'full');
    const view2 = buildGenericArtifactView(makeRevision({ data: data2 }), registration, 'full');

    expect(view1).toEqual(view2);
  });
});

/* -------------------------------------------------------------------------- */
/*  Edge cases                                                                */
/* -------------------------------------------------------------------------- */

describe('edge cases', () => {
  it('handles evidence refs without locator', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      confidence: {
        level: 'stated',
        basis: [
          {
            kind: 'automated-test',
            actor: { kind: 'system', id: 'ci' },
            timestamp: Date.now(),
            evidenceRef: {
              refClass: 'evidence',
              kind: 'test-run',
              id: 'run-42',
            },
          },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const evidence = view.sections.find((s) => s.type === 'evidence');
    expect(evidence).toBeDefined();
    if (evidence!.type === 'evidence') {
      expect(evidence!.items[0]!.locator).toBeUndefined();
    }
  });

  it('skips evidence section when no confidence or no evidence refs', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      confidence: {
        level: 'stated',
        basis: [
          {
            kind: 'manual',
            actor: { kind: 'user', id: 'u-1' },
            timestamp: Date.now(),
            // No evidenceRef
          },
        ],
      },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    expect(view.sections.filter((s) => s.type === 'evidence')).toHaveLength(0);
  });

  it('skips relations section when revision has no artifact relations', () => {
    const revision = makeRevision({
      data: { status: 'open' },
      relations: [
        {
          type: 'ref',
          target: {
            refClass: 'evidence',
            kind: 'commit',
            id: 'abc123',
          },
        },
      ],
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'status' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    // Evidence refs in relations are not artifact relations
    expect(view.sections.filter((s) => s.type === 'relations')).toHaveLength(0);
  });

  it('handles boolean and number scalars', () => {
    const revision = makeRevision({
      data: { count: 42, active: false },
    });
    const registration = makeRegistration({
      projection: {
        mode: 'surface',
        projectedFields: [{ path: 'count' }, { path: 'active' }],
      },
    });

    const view = buildGenericArtifactView(revision, registration, 'full');

    const props = view.sections.find((s) => s.type === 'properties');
    if (props && props.type === 'properties') {
      expect(props.rows).toEqual(
        expect.arrayContaining([
          { label: 'Count', value: '42' },
          { label: 'Active', value: 'false' },
        ]),
      );
    }
  });
});
