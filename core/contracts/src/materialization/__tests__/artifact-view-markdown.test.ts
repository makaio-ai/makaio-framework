/**
 * Tests for the artifact view Markdown renderer.
 *
 * Covers all eight section variants, escaping, empty-section behavior,
 * stable table columns, grouped relations, evidence locators, JSON fencing,
 * code language fencing, Mermaid fencing, and dynamic fence length when
 * content contains backticks.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactViewSection } from '../view-model.js';
import { renderArtifactViewMarkdown, ARTIFACT_VIEW_MARKDOWN_RENDERER_VERSION } from '../artifact-view-markdown.js';
import { makeView } from './helpers.js';

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('ARTIFACT_VIEW_MARKDOWN_RENDERER_VERSION', () => {
  it('is a positive integer', () => {
    expect(ARTIFACT_VIEW_MARKDOWN_RENDERER_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(ARTIFACT_VIEW_MARKDOWN_RENDERER_VERSION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// View header
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – header', () => {
  it('renders the title as a level-2 heading', () => {
    const md = renderArtifactViewMarkdown(makeView({ title: 'My Artifact' }));
    expect(md).toContain('## My Artifact');
  });

  it('omits only the leading title block when the surface already shows it', () => {
    const view = makeView({
      title: 'My Artifact',
      navigation: {
        breadcrumbs: [{ label: 'Home', url: 'https://example.com' }],
        related: [{ label: 'Sibling', artifactId: 'sibling-1' }],
      },
      sections: [
        { type: 'summary', title: 'Summary', text: 'Body text.' },
        { type: 'properties', title: 'Details', rows: [{ label: 'Status', value: 'Active' }] },
        { type: 'code', title: 'Source', language: 'ts', content: 'const x = 1;' },
      ],
    });
    const titlePrefix = '## My Artifact\n\n';
    const withTitle = renderArtifactViewMarkdown(view);
    expect(withTitle.startsWith(titlePrefix)).toBe(true);

    expect(renderArtifactViewMarkdown(view, { includeTitle: false })).toBe(withTitle.slice(titlePrefix.length));
  });

  it('renders an empty string for an empty view without a title', () => {
    expect(renderArtifactViewMarkdown(makeView(), { includeTitle: false })).toBe('');
  });

  it('renders the exact default output for a view with navigation and two sections', () => {
    const view = makeView({
      title: 'Exact Artifact',
      navigation: {
        breadcrumbs: [
          { label: 'Home', url: 'https://example.com' },
          { label: 'Plans', artifactId: 'plans' },
        ],
        related: [{ label: 'Sibling', artifactId: 'sibling-1' }],
      },
      sections: [
        { type: 'summary', title: 'Overview', text: 'Body text.' },
        {
          type: 'properties',
          title: 'Details',
          rows: [
            { label: 'Status', value: 'Active' },
            { label: 'Owner', value: '' },
          ],
        },
      ],
    });

    const expected = [
      '## Exact Artifact',
      ['**Breadcrumbs:** [Home](https://example.com) › Plans', '', '**Related:**', '- Sibling'].join('\n'),
      ['### Overview', '', 'Body text.'].join('\n'),
      ['### Details', '', '**Status:** Active', '**Owner:**'].join('\n'),
    ].join('\n\n');

    expect(renderArtifactViewMarkdown(view)).toBe(expected);
  });

  it('renders breadcrumbs and related links as separate ordered groups', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        navigation: {
          breadcrumbs: [
            { label: 'Home', url: 'https://example.com' },
            { label: 'Plans', artifactId: 'plans' },
          ],
          related: [
            { label: 'Related', artifactId: 'art-42' },
            { label: 'External', url: 'https://example.com/external' },
          ],
        },
      }),
    );
    expect(md).toContain('**Breadcrumbs:** [Home](https://example.com) › Plans');
    expect(md).toContain('**Related:**\n- Related\n- [External](https://example.com/external)');
    expect(md.indexOf('**Breadcrumbs:**')).toBeLessThan(md.indexOf('**Related:**'));
  });

  it('renders breadcrumbs without an empty related group', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        navigation: { breadcrumbs: [{ label: 'Parent', artifactId: 'parent-1' }], related: [] },
      }),
    );

    expect(md).toContain('**Breadcrumbs:** Parent');
    expect(md).not.toContain('**Related:**');
  });

  it('renders related links without an empty breadcrumb group', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        navigation: { breadcrumbs: [], related: [{ label: 'Sibling', artifactId: 'sibling-1' }] },
      }),
    );

    expect(md).not.toContain('**Breadcrumbs:**');
    expect(md).toContain('**Related:**\n- Sibling');
  });

  it('omits navigation when both arrays are empty', () => {
    const md = renderArtifactViewMarkdown(makeView({ navigation: { breadcrumbs: [], related: [] } }));

    expect(md).not.toContain('**Breadcrumbs:**');
    expect(md).not.toContain('**Related:**');
  });
});

// ---------------------------------------------------------------------------
// Summary section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – summary section', () => {
  it('renders a summary section with heading and text', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [{ type: 'summary', title: 'Overview', text: 'This is a description.' }],
      }),
    );
    expect(md).toContain('### Overview');
    expect(md).toContain('This is a description.');
  });
});

// ---------------------------------------------------------------------------
// Properties section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – properties section', () => {
  it('renders key-value rows', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'properties',
            title: 'Details',
            rows: [
              { label: 'Status', value: 'Active' },
              { label: 'Priority', value: 'High' },
            ],
          },
        ],
      }),
    );
    expect(md).toContain('### Details');
    expect(md).toContain('**Status:** Active');
    expect(md).toContain('**Priority:** High');
  });

  it('renders empty value without trailing space', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'properties',
            title: 'Props',
            rows: [{ label: 'Empty', value: '' }],
          },
        ],
      }),
    );
    expect(md).toContain('**Empty:**');
  });
});

// ---------------------------------------------------------------------------
// Table section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – table section', () => {
  it('renders a Markdown table with stable columns', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Items',
            columns: ['Name', 'Count'],
            rows: [{ cells: ['Widget', '5'] }, { cells: ['Gadget', '12'] }],
          },
        ],
      }),
    );
    expect(md).toContain('### Items');
    expect(md).toContain('| Name | Count |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Widget | 5 |');
    expect(md).toContain('| Gadget | 12 |');
  });

  it('escapes pipe characters in cell values', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Escaped',
            columns: ['Col'],
            rows: [{ cells: ['a | b'] }],
          },
        ],
      }),
    );
    expect(md).toContain('a \\| b');
  });

  it('renders row-level links in a dedicated link column', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Linked',
            columns: ['Name'],
            rows: [{ cells: ['Item'], link: { label: 'View', url: 'https://example.com/item' } }],
          },
        ],
      }),
    );
    expect(md).toContain('| Item | [View](https://example.com/item) |');
  });

  it('renders a table with zero rows as just headers', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Empty Table',
            columns: ['A', 'B'],
            rows: [],
          },
        ],
      }),
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
  });
});

// ---------------------------------------------------------------------------
// Relations section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – relations section', () => {
  it('renders grouped relations', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'relations',
            title: 'Relations',
            groups: [
              {
                type: 'depends-on',
                items: [
                  { label: 'API Schema', artifactId: 'art-schema' },
                  { label: 'DB Migration', url: 'https://example.com/migration' },
                ],
              },
              {
                type: 'blocks',
                items: [{ label: 'Deploy', artifactId: 'art-deploy' }],
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain('### Relations');
    expect(md).toContain('**depends-on**');
    expect(md).toContain('API Schema');
    expect(md).toContain('[DB Migration](https://example.com/migration)');
    expect(md).toContain('**blocks**');
    expect(md).toContain('Deploy');
  });

  it('renders empty groups section without crashing', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [{ type: 'relations', title: 'No Relations', groups: [] }],
      }),
    );
    expect(md).toContain('### No Relations');
  });
});

// ---------------------------------------------------------------------------
// Evidence section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – evidence section', () => {
  it('renders evidence items with locators', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'evidence',
            title: 'Evidence',
            items: [
              { kind: 'commit', id: 'abc123', locator: 'src/main.ts:42' },
              { kind: 'file', id: 'readme.md' },
            ],
          },
        ],
      }),
    );
    expect(md).toContain('### Evidence');
    expect(md).toContain('commit');
    expect(md).toContain('abc123');
    expect(md).toContain('src/main.ts:42');
    expect(md).toContain('file');
    expect(md).toContain('readme.md');
  });

  it('omits locator when not present', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'evidence',
            title: 'Proof',
            items: [{ kind: 'url', id: 'https://example.com' }],
          },
        ],
      }),
    );
    // The item should not show "undefined" for the locator
    expect(md).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// Raw section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – raw section', () => {
  it('renders JSON in a fenced code block', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'raw',
            title: 'Debug Data',
            json: { key: 'value', nested: { a: 1 } },
          },
        ],
      }),
    );
    expect(md).toContain('### Debug Data');
    expect(md).toContain('```json');
    expect(md).toContain('"key": "value"');
    expect(md).toContain('```');
  });

  it('handles simple JSON values (string, number, null)', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [{ type: 'raw', title: 'Simple', json: 42 }],
      }),
    );
    expect(md).toContain('42');
  });

  it('uses longer fence when JSON content contains backticks', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'raw',
            title: 'With Backticks',
            json: { code: '```javascript\nconsole.log("hi")\n```' },
          },
        ],
      }),
    );
    // The outer fence must be longer than 3 backticks to avoid collision
    const fenceMatch = md.match(/(`{4,})json/);
    expect(fenceMatch).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Code section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – code section', () => {
  it('renders code in a language-fenced code block', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'code',
            title: 'Source',
            language: 'typescript',
            content: 'const x = 1;',
          },
        ],
      }),
    );
    expect(md).toContain('### Source');
    expect(md).toContain('```typescript');
    expect(md).toContain('const x = 1;');
  });

  it('uses longer fence when code content contains triple backticks', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'code',
            title: 'Meta',
            language: 'markdown',
            content: '```python\nprint("hi")\n```',
          },
        ],
      }),
    );
    const fenceMatch = md.match(/(`{4,})markdown/);
    expect(fenceMatch).toBeTruthy();
  });

  it('renders empty code content without error', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [{ type: 'code', title: 'Empty', language: 'text', content: '' }],
      }),
    );
    expect(md).toContain('```text');
  });
});

// ---------------------------------------------------------------------------
// Diagram (Mermaid) section
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – diagram section', () => {
  it('renders a Mermaid diagram in a fenced code block', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'diagram',
            title: 'Flow',
            notation: 'mermaid',
            source: 'graph TD;\n  A-->B;',
          },
        ],
      }),
    );
    expect(md).toContain('### Flow');
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph TD;');
    expect(md).toContain('A-->B;');
  });

  it('uses longer fence when diagram source contains backticks', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'diagram',
            title: 'Complex',
            notation: 'mermaid',
            source: 'graph TD;\n  A["```triple```"]-->B;',
          },
        ],
      }),
    );
    const fenceMatch = md.match(/(`{4,})mermaid/);
    expect(fenceMatch).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Multiple sections
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – multiple sections', () => {
  it('renders sections in order', () => {
    const sections: ArtifactViewSection[] = [
      { type: 'summary', title: 'First', text: 'Summary text' },
      {
        type: 'properties',
        title: 'Second',
        rows: [{ label: 'Key', value: 'Val' }],
      },
      { type: 'code', title: 'Third', language: 'go', content: 'package main' },
    ];
    const md = renderArtifactViewMarkdown(makeView({ sections }));
    const firstIdx = md.indexOf('### First');
    const secondIdx = md.indexOf('### Second');
    const thirdIdx = md.indexOf('### Third');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – escaping', () => {
  it('does not corrupt special Markdown characters in titles', () => {
    const md = renderArtifactViewMarkdown(makeView({ title: 'Plan #3: <script>alert("xss")</script>' }));
    // Title should appear literally — it is inside a heading, not HTML
    expect(md).toContain('Plan #3');
  });

  it('does not corrupt special characters in property values', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'properties',
            title: 'Props',
            rows: [{ label: 'Path', value: 'a/b/c & d' }],
          },
        ],
      }),
    );
    expect(md).toContain('a/b/c & d');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – determinism', () => {
  it('produces identical output for identical input', () => {
    const view = makeView({
      title: 'Deterministic',
      sections: [
        { type: 'summary', title: 'Intro', text: 'Hello' },
        {
          type: 'table',
          title: 'Data',
          columns: ['A'],
          rows: [{ cells: ['1'] }],
        },
      ],
    });
    const a = renderArtifactViewMarkdown(view);
    const b = renderArtifactViewMarkdown(view);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// B3: Table column alignment with row links
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – table column alignment (B3)', () => {
  it('link with all-non-empty cells does not break column count', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Full Cells',
            columns: ['Name', 'Status'],
            rows: [
              {
                cells: ['Widget', 'Active'],
                link: { label: 'View', url: 'https://example.com' },
              },
            ],
          },
        ],
      }),
    );
    // With link column: header has Name | Status | (empty link header)
    expect(md).toContain('| Name | Status |  |');
    // Data row has all 3 columns
    expect(md).toContain('| Widget | Active | [View](https://example.com) |');
  });

  it('mixed rows with/without links all have uniform column count', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Mixed',
            columns: ['Name'],
            rows: [
              { cells: ['No Link'] },
              { cells: ['Has Link'], link: { label: 'Go', url: 'https://example.com' } },
              { cells: ['Also No Link'] },
            ],
          },
        ],
      }),
    );
    // Header: Name + link column
    expect(md).toContain('| Name |  |');
    // Row without link has empty link column
    expect(md).toContain('| No Link |  |');
    // Row with link has link in link column
    expect(md).toContain('| Has Link | [Go](https://example.com) |');
    // Another row without link
    expect(md).toContain('| Also No Link |  |');
  });

  it('pads short rows to header width', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Ragged',
            columns: ['A', 'B', 'C'],
            rows: [{ cells: ['only-one'] }],
          },
        ],
      }),
    );
    // Row should be padded to 3 columns
    expect(md).toContain('| only-one |  |  |');
  });
});

// ---------------------------------------------------------------------------
// B4: Escaping completeness
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – escaping completeness (B4)', () => {
  it('escapes pipe characters in table headers', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Escaped Headers',
            columns: ['Col|A', 'Col|B'],
            rows: [{ cells: ['x', 'y'] }],
          },
        ],
      }),
    );
    expect(md).toContain('Col\\|A');
    expect(md).toContain('Col\\|B');
  });

  it('replaces newlines in table cells with spaces', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Newlines',
            columns: ['Content'],
            rows: [{ cells: ['line1\nline2\nline3'] }],
          },
        ],
      }),
    );
    // Newlines must be replaced, not present
    const dataLine = md.split('\n').find((l) => l.includes('line1'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('line1 line2 line3');
  });

  it('passes rendered link text through the cell escaper', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'table',
            title: 'Link Escape',
            columns: ['Name'],
            rows: [
              {
                cells: ['Item'],
                link: { label: 'pipe|label', url: 'https://example.com' },
              },
            ],
          },
        ],
      }),
    );
    // The pipe in the link label should be escaped
    expect(md).toContain('pipe\\|label');
  });

  it('escapes ] in link labels', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        navigation: {
          breadcrumbs: [{ label: 'Bracket]Link', url: 'https://example.com' }],
          related: [],
        },
      }),
    );
    expect(md).toContain('Bracket\\]Link');
  });

  it('escapes parentheses in link URLs', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        navigation: {
          breadcrumbs: [],
          related: [{ label: 'Link', url: 'https://example.com/path(1)' }],
        },
      }),
    );
    expect(md).toContain('https://example.com/path%281%29');
  });
});

// ---------------------------------------------------------------------------
// B5: Fence computation with language token
// ---------------------------------------------------------------------------

describe('renderArtifactViewMarkdown – fence language safety (B5)', () => {
  it('strips backticks from the language token in code sections', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'code',
            title: 'Dangerous Language',
            language: 'type`script',
            content: 'const x = 1;',
          },
        ],
      }),
    );
    // The language token must not contain backticks
    expect(md).toContain('```typescript');
    expect(md).not.toContain('`type`script');
  });

  it('renders diagram sections with a mermaid fence', () => {
    const md = renderArtifactViewMarkdown(
      makeView({
        sections: [
          {
            type: 'diagram',
            title: 'Diagram',
            notation: 'mermaid',
            source: 'graph TD; A-->B;',
          },
        ],
      }),
    );
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph TD; A-->B;');
  });
});
