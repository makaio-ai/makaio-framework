import { describe, expect, it } from 'vitest';
import {
  ArtifactViewLevelSchema,
  ArtifactViewLinkSchema,
  ArtifactViewIdentitySchema,
  ArtifactViewModelSchema,
  ArtifactViewNavigationSchema,
  ArtifactViewSurfaceLinksSchema,
  ArtifactViewSummarySectionSchema,
  ArtifactViewPropertiesSectionSchema,
  ArtifactViewTableSectionSchema,
  ArtifactViewRelationsSectionSchema,
  ArtifactViewEvidenceSectionSchema,
  ArtifactViewRawSectionSchema,
  ArtifactViewCodeSectionSchema,
  ArtifactViewDiagramSectionSchema,
  ArtifactViewSectionSchema,
} from '../index.js';
import { parsed, rejected } from './helpers.js';

const REQUIRED_VIEW_FIELDS = {
  artifact: { id: 'artifact-1', kind: 'test-kind', revision: 'rev-1' },
  navigation: { breadcrumbs: [], related: [] },
  links: {},
} as const;

/* -------------------------------------------------------------------------- */
/*  ArtifactViewLevelSchema                                                   */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewLevelSchema', () => {
  it('accepts the three closed levels', () => {
    expect(parsed(ArtifactViewLevelSchema, 'link')).toBe('link');
    expect(parsed(ArtifactViewLevelSchema, 'summary')).toBe('summary');
    expect(parsed(ArtifactViewLevelSchema, 'full')).toBe('full');
  });

  it('rejects values outside the closed set', () => {
    rejected(ArtifactViewLevelSchema, 'detail');
    rejected(ArtifactViewLevelSchema, '');
    rejected(ArtifactViewLevelSchema, 42);
  });
});

/* -------------------------------------------------------------------------- */
/*  ArtifactViewLinkSchema                                                    */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewLinkSchema', () => {
  it('accepts an artifact-ref based link', () => {
    const link = parsed(ArtifactViewLinkSchema, {
      artifactId: 'plan-42',
      label: 'Implementation Plan',
    });
    expect(link.artifactId).toBe('plan-42');
    expect(link.label).toBe('Implementation Plan');
  });

  it('accepts a URL-only link', () => {
    const link = parsed(ArtifactViewLinkSchema, {
      url: 'https://example.com/doc',
      label: 'External Doc',
    });
    expect(link.url).toBe('https://example.com/doc');
    expect(link.artifactId).toBeUndefined();
  });

  it('accepts a link with both artifactId and url', () => {
    const link = parsed(ArtifactViewLinkSchema, {
      artifactId: 'plan-42',
      url: 'https://example.com/plan/42',
      label: 'Plan 42',
    });
    expect(link.artifactId).toBe('plan-42');
    expect(link.url).toBe('https://example.com/plan/42');
  });

  it('rejects a link with empty artifactId', () => {
    rejected(ArtifactViewLinkSchema, { artifactId: '', label: 'Bad' });
  });
});

/* -------------------------------------------------------------------------- */
/*  Section discriminants                                                     */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewSectionSchema — eight discriminants', () => {
  it('parses a summary section', () => {
    const section = parsed(ArtifactViewSummarySectionSchema, {
      type: 'summary',
      title: 'Overview',
      text: 'This artifact represents a completed plan.',
    });
    expect(section.type).toBe('summary');
    expect(section.text).toBe('This artifact represents a completed plan.');
  });

  it('parses a properties section', () => {
    const section = parsed(ArtifactViewPropertiesSectionSchema, {
      type: 'properties',
      title: 'Details',
      rows: [
        { label: 'Status', value: 'Active' },
        { label: 'Priority', value: 'High' },
      ],
    });
    expect(section.type).toBe('properties');
    expect(section.rows).toHaveLength(2);
    expect(section.rows[0].label).toBe('Status');
  });

  it('parses a table section', () => {
    const section = parsed(ArtifactViewTableSectionSchema, {
      type: 'table',
      title: 'Tasks',
      columns: ['Task', 'Status', 'Owner'],
      rows: [
        { cells: ['Fix login', 'Done', 'Alice'] },
        { cells: ['Add auth', 'In Progress', 'Bob'], link: { label: 'View', url: 'https://example.com' } },
      ],
    });
    expect(section.type).toBe('table');
    expect(section.columns).toHaveLength(3);
    expect(section.rows[1].link?.url).toBe('https://example.com');
  });

  it('table row link may reference an artifact', () => {
    const section = parsed(ArtifactViewTableSectionSchema, {
      type: 'table',
      title: 'Issues',
      columns: ['Issue'],
      rows: [{ cells: ['Issue 1'], link: { label: 'View', artifactId: 'issue-1' } }],
    });
    expect(section.rows[0].link?.artifactId).toBe('issue-1');
  });

  it('parses a relations section with open type strings', () => {
    const section = parsed(ArtifactViewRelationsSectionSchema, {
      type: 'relations',
      title: 'Related',
      groups: [
        {
          type: 'depends-on',
          items: [
            { label: 'Plan Alpha', artifactId: 'plan-alpha' },
            { label: 'External Spec', url: 'https://spec.example.com' },
          ],
        },
        {
          type: 'custom-product-relation',
          items: [{ label: 'Custom Item' }],
        },
      ],
    });
    expect(section.type).toBe('relations');
    expect(section.groups).toHaveLength(2);
    // Relation type strings are open — any non-empty string accepted
    expect(section.groups[0].type).toBe('depends-on');
    expect(section.groups[1].type).toBe('custom-product-relation');
  });

  it('parses an evidence section', () => {
    const section = parsed(ArtifactViewEvidenceSectionSchema, {
      type: 'evidence',
      title: 'Evidence',
      items: [
        { kind: 'commit', id: 'abc123' },
        { kind: 'file', id: 'README.md', locator: 'L10-L20' },
      ],
    });
    expect(section.type).toBe('evidence');
    expect(section.items).toHaveLength(2);
    expect(section.items[1].locator).toBe('L10-L20');
  });

  it('parses a raw section with JSON-safe values', () => {
    const section = parsed(ArtifactViewRawSectionSchema, {
      type: 'raw',
      title: 'Raw Data',
      json: { nested: { array: [1, 'two', true, null] } },
    });
    expect(section.type).toBe('raw');
    expect(section.json).toEqual({ nested: { array: [1, 'two', true, null] } });
  });

  it('rejects non-JSON-safe values in raw section', () => {
    // Functions are not JSON-safe
    rejected(ArtifactViewRawSectionSchema, {
      type: 'raw',
      title: 'Bad Data',
      json: { fn: () => 42 },
    });
  });

  it('parses a code section', () => {
    const section = parsed(ArtifactViewCodeSectionSchema, {
      type: 'code',
      title: 'Implementation',
      language: 'typescript',
      content: 'const x = 42;',
    });
    expect(section.type).toBe('code');
    expect(section.language).toBe('typescript');
    expect(section.content).toBe('const x = 42;');
  });

  it('parses a diagram section (mermaid)', () => {
    const section = parsed(ArtifactViewDiagramSectionSchema, {
      type: 'diagram',
      title: 'Architecture',
      notation: 'mermaid',
      source: 'graph TD; A-->B;',
    });
    expect(section.type).toBe('diagram');
    expect(section.notation).toBe('mermaid');
    expect(section.source).toBe('graph TD; A-->B;');
  });

  it('rejects an unknown section type through the union', () => {
    rejected(ArtifactViewSectionSchema, {
      type: 'unknown-section',
      title: 'Bad',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  ArtifactViewModelSchema                                                   */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewModelSchema', () => {
  it('validates artifact identity, structured navigation, and downstream-decorated links', () => {
    expect(
      parsed(ArtifactViewIdentitySchema, {
        id: 'artifact-1',
        kind: 'implementation-plan',
        revision: 'rev-7',
        status: 'approved',
      }),
    ).toEqual({ id: 'artifact-1', kind: 'implementation-plan', revision: 'rev-7', status: 'approved' });

    expect(
      parsed(ArtifactViewNavigationSchema, {
        breadcrumbs: [{ artifactId: 'parent-1', label: 'Parent' }],
        related: [{ url: 'https://example.com/spec', label: 'Specification' }],
      }),
    ).toEqual({
      breadcrumbs: [{ artifactId: 'parent-1', label: 'Parent' }],
      related: [{ url: 'https://example.com/spec', label: 'Specification' }],
    });

    expect(
      parsed(ArtifactViewSurfaceLinksSchema, {
        dashboard: 'https://factory.example/artifacts/artifact-1',
        materialized: 'https://github.com/org/repo/issues/1',
      }),
    ).toEqual({
      dashboard: 'https://factory.example/artifacts/artifact-1',
      materialized: 'https://github.com/org/repo/issues/1',
    });
  });

  it('parses a complete view model', () => {
    const vm = parsed(ArtifactViewModelSchema, {
      title: 'Implementation Plan #42',
      artifact: { id: 'plan-42', kind: 'implementation-plan', revision: 'rev-2', status: 'active' },
      navigation: {
        breadcrumbs: [{ artifactId: 'program-1', label: 'Program' }],
        related: [{ url: 'https://github.com/org/repo/issues/42', label: 'GitHub Issue' }],
      },
      sections: [
        { type: 'summary', title: 'Overview', text: 'Plan overview text.' },
        {
          type: 'properties',
          title: 'Metadata',
          rows: [{ label: 'Status', value: 'Active' }],
        },
      ],
      links: { dashboard: 'https://factory.example/artifacts/plan-42' },
    });
    expect(vm.title).toBe('Implementation Plan #42');
    expect(vm.navigation.breadcrumbs).toHaveLength(1);
    expect(vm.navigation.related).toHaveLength(1);
    expect(vm.sections).toHaveLength(2);
  });

  it('title is required and non-empty', () => {
    rejected(ArtifactViewModelSchema, {
      ...REQUIRED_VIEW_FIELDS,
      title: '',
      sections: [],
    });
    rejected(ArtifactViewModelSchema, {
      ...REQUIRED_VIEW_FIELDS,
      sections: [],
    });
  });

  it('artifact, navigation, and links are required', () => {
    const vm = parsed(ArtifactViewModelSchema, {
      ...REQUIRED_VIEW_FIELDS,
      title: 'Minimal View',
      sections: [],
    });
    expect(vm.navigation).toEqual({ breadcrumbs: [], related: [] });

    rejected(ArtifactViewModelSchema, {
      title: 'Missing artifact',
      navigation: REQUIRED_VIEW_FIELDS.navigation,
      links: REQUIRED_VIEW_FIELDS.links,
      sections: [],
    });
    rejected(ArtifactViewModelSchema, {
      title: 'Missing navigation',
      artifact: REQUIRED_VIEW_FIELDS.artifact,
      links: REQUIRED_VIEW_FIELDS.links,
      sections: [],
    });
    rejected(ArtifactViewModelSchema, {
      title: 'Missing links',
      artifact: REQUIRED_VIEW_FIELDS.artifact,
      navigation: REQUIRED_VIEW_FIELDS.navigation,
      sections: [],
    });
  });

  it('sections array may be empty', () => {
    const vm = parsed(ArtifactViewModelSchema, {
      ...REQUIRED_VIEW_FIELDS,
      title: 'Empty Sections',
      sections: [],
    });
    expect(vm.sections).toHaveLength(0);
  });

  it('sections preserve insertion order', () => {
    const vm = parsed(ArtifactViewModelSchema, {
      ...REQUIRED_VIEW_FIELDS,
      title: 'Ordered',
      sections: [
        { type: 'code', title: 'Code', language: 'go', content: 'package main' },
        { type: 'diagram', title: 'Diagram', notation: 'mermaid', source: 'graph LR; A-->B;' },
        { type: 'summary', title: 'Summary', text: 'Wrap-up.' },
      ],
    });
    expect(vm.sections[0].type).toBe('code');
    expect(vm.sections[1].type).toBe('diagram');
    expect(vm.sections[2].type).toBe('summary');
  });

  it('is JSON-safe: no functions, symbols, or undefined values in raw sections', () => {
    // Verify the model itself is JSON-roundtrippable
    const input = {
      ...REQUIRED_VIEW_FIELDS,
      title: 'JSON-safe test',
      sections: [
        {
          type: 'raw',
          title: 'Data',
          json: { key: 'value', number: 42, bool: true, nil: null, nested: { arr: [1, 2, 3] } },
        },
      ],
    };
    const vm = parsed(ArtifactViewModelSchema, input);
    const roundTripped = JSON.parse(JSON.stringify(vm));
    expect(roundTripped).toEqual(vm);
  });
});
