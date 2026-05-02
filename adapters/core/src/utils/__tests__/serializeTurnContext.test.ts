import { describe, it, expect } from 'vitest';
import { serializeTurnContext, formatContextBlocksAsText } from '../serializeTurnContext.js';
import { safeJsonStringify } from '../safeJsonStringify.js';

describe('safeJsonStringify', () => {
  it('serializes plain objects', () => {
    expect(safeJsonStringify({ foo: 'bar', count: 42 })).toBe(JSON.stringify({ foo: 'bar', count: 42 }, null, 2));
  });

  it('serializes strings', () => {
    expect(safeJsonStringify('hello')).toBe('"hello"');
  });

  it('replaces circular references with [Circular] instead of aborting', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    const result = safeJsonStringify(obj);
    expect(result).toContain('[Circular]');
    // The surrounding object is still serialized — only the cycle node is replaced.
    expect(result).toContain('"a"');
  });

  it('serializes shared references without marking them circular', () => {
    const shared = { value: 'same-object' };
    const result = safeJsonStringify({ a: shared, b: shared });
    expect(result).not.toContain('[Circular]');
    expect(result).toBe(
      JSON.stringify(
        {
          a: shared,
          b: shared,
        },
        null,
        2,
      ),
    );
  });

  it('serializes BigInt values as strings', () => {
    const result = safeJsonStringify({ n: 9007199254740993n });
    expect(result).toContain('"n": "9007199254740993"');
  });

  it('returns fallback string for undefined input', () => {
    // JSON.stringify(undefined) returns undefined (not a string), no throw occurs.
    // The ?? operator falls back to the sentinel rather than returning undefined.
    expect(safeJsonStringify(undefined)).toBe('[Non-serializable value]');
  });

  it('returns fallback string when JSON and string coercion both fail', () => {
    const value = {
      toJSON() {
        throw new Error('json failed');
      },
      toString() {
        throw new Error('string coercion failed');
      },
    };

    expect(safeJsonStringify(value)).toBe('[Non-serializable value]');
  });
});

describe('serializeTurnContext', () => {
  it('returns [] when turnContext is undefined', () => {
    expect(serializeTurnContext(undefined)).toEqual([]);
  });

  it('returns [] when turnContext is {}', () => {
    expect(serializeTurnContext({})).toEqual([]);
  });

  it('handles skillCatalog key with valid entries — produces compact markdown', () => {
    const blocks = serializeTurnContext({
      skillCatalog: [
        { name: 'code-review', description: 'Review for correctness.', compatibility: 'Needs git access.' },
        { name: 'security-checklist', description: 'Review for security.' },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('skillCatalog');
    expect(blocks[0].content).toBe(
      '- code-review: Review for correctness. Compatibility: Needs git access.\n- security-checklist: Review for security.',
    );
  });

  it('handles skills key with valid entries — produces markdown sections', () => {
    const blocks = serializeTurnContext({
      skills: [
        { name: 'pr-review-context', compatibility: 'Needs PR binding.', content: 'Review PR #42.' },
        { name: 'code-review', content: 'Focus on regressions.' },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('skills');
    expect(blocks[0].content).toBe(
      '## code-review\nFocus on regressions.\n\n## pr-review-context\nCompatibility: Needs PR binding.\nReview PR #42.',
    );
  });

  it('filters out invalid skillCatalog entries', () => {
    const blocks = serializeTurnContext({
      skillCatalog: [
        { name: 'valid-skill', description: 'OK' },
        { name: 'missing-description' },
        { description: 'missing name' },
        null,
        'bad',
      ],
    });
    expect(blocks).toEqual([{ tag: 'skillCatalog', content: '- valid-skill: OK' }]);
  });

  it('filters out invalid skill entries', () => {
    const blocks = serializeTurnContext({
      skills: [
        { name: 'valid-skill', content: 'Body' },
        { name: 'missing-content' },
        { content: 'missing name' },
        null,
        'bad',
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('skills');
    expect(blocks[0].content).toBe('## valid-skill\nBody');
  });

  it('falls back to JSON when a non-empty skillCatalog array has no valid entries', () => {
    const blocks = serializeTurnContext({
      skillCatalog: [{ invalid: 'entry' }],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('skillCatalog');
    expect(blocks[0].content).toContain('"invalid"');
  });

  it('falls back to JSON when a non-empty skills array has no valid entries', () => {
    const blocks = serializeTurnContext({
      skills: [{ invalid: 'entry' }],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('skills');
    expect(blocks[0].content).toContain('"invalid"');
  });

  it('keeps malformed special keys ahead of generic keys', () => {
    const blocks = serializeTurnContext({
      zebra: 'last',
      skillCatalog: [{ invalid: 'entry' }],
      skills: [{ invalid: 'entry' }],
      alpha: 'first-generic',
    });

    expect(blocks.map((block) => block.tag)).toEqual(['skillCatalog', 'skills', 'alpha', 'zebra']);
  });

  it('serializes skillCatalog as JSON when skillCatalog is non-array', () => {
    const blocks = serializeTurnContext({
      skillCatalog: { note: 'not-an-array' },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('skillCatalog');
    expect(blocks[0].content).toContain('"note"');
  });

  it('serializes skills as JSON when skills is non-array', () => {
    const blocks = serializeTurnContext({
      skills: { note: 'not-an-array' },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('skills');
    expect(blocks[0].content).toContain('"note"');
  });

  it('skips empty special arrays instead of serializing them as JSON', () => {
    const blocks = serializeTurnContext({
      skillCatalog: [],
      skills: [],
      other: 'value',
    });

    expect(blocks).toEqual([{ tag: 'other', content: JSON.stringify('value', null, 2) }]);
  });

  it('serializes non-special keys as JSON via safeJsonStringify', () => {
    const payload = { path: '/workspace', depth: 3 };
    const blocks = serializeTurnContext({ cwdChange: payload });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('cwdChange');
    expect(blocks[0].content).toBe(JSON.stringify(payload, null, 2));
  });

  it('orders skillCatalog first, skills second, then remaining keys alphabetically', () => {
    const blocks = serializeTurnContext({
      zebra: 'last',
      alpha: 'first-non-guide',
      skills: [{ name: 'a-skill', content: 'C' }],
      skillCatalog: [{ name: 'catalog-entry', description: 'D' }],
      middle: 'between',
    });
    const tags = blocks.map((b) => b.tag);
    expect(tags).toEqual(['skillCatalog', 'skills', 'alpha', 'middle', 'zebra']);
  });

  it('renders skills using markdown sections from current active skill entries', () => {
    const blocks = serializeTurnContext({
      skills: [
        {
          name: 'repository-rules',
          compatibility: 'Workspace access required.',
          content: 'Follow AGENTS.md exactly.',
        },
        {
          name: 'session-rules',
          content: 'Prefer surgical edits.',
        },
      ],
    });

    expect(blocks).toEqual([
      {
        tag: 'skills',
        content:
          '## repository-rules\nCompatibility: Workspace access required.\nFollow AGENTS.md exactly.\n\n## session-rules\nPrefer surgical edits.',
      },
    ]);
  });

  it('preserves skill names verbatim in markdown section headings', () => {
    const blocks = serializeTurnContext({
      skills: [{ name: 'Skill\nNested\r\nHeading', content: 'Skill content' }],
    });

    expect(blocks).toEqual([{ tag: 'skills', content: '## Skill\nNested\r\nHeading\nSkill content' }]);
  });

  it('filters out invalid skills entries safely', () => {
    const blocks = serializeTurnContext({
      skills: [
        {
          name: 'valid',
          content: 'Resolved output',
        },
        { name: 'Missing content' },
        { content: 'Missing name' },
        null,
        42,
        'string-entry',
        { name: 123, content: 'bad name type' },
      ],
    });

    expect(blocks).toEqual([{ tag: 'skills', content: '## valid\nResolved output' }]);
  });

  it('falls back to JSON when no valid skills entries remain after filtering', () => {
    const blocks = serializeTurnContext({
      skills: [{ name: 'Missing content' }, null, 'bad'],
    });

    expect(blocks).toEqual([
      {
        tag: 'skills',
        content: JSON.stringify([{ name: 'Missing content' }, null, 'bad'], null, 2),
      },
    ]);
  });

  it('handles contextRules key with valid entries — produces canonical markdown sections', () => {
    const blocks = serializeTurnContext({
      contextRules: [
        {
          id: 'rule-1',
          name: 'project-conventions',
          priority: 0,
          action: { channel: 'turnContext', content: 'Always run yarn validate...' },
          renderedContent: 'Always run yarn validate before committing.',
        },
        {
          id: 'rule-2',
          name: 'payments-context',
          priority: 1,
          action: { channel: 'turnContext', content: 'Stripe webhooks...' },
          renderedContent: 'The payments service uses Stripe webhooks.',
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('contextRules');
    expect(blocks[0].content).toBe(
      '## project-conventions\nAlways run yarn validate before committing.\n\n## payments-context\nThe payments service uses Stripe webhooks.',
    );
  });

  it('filters out invalid contextRules entries', () => {
    const blocks = serializeTurnContext({
      contextRules: [
        {
          id: 'valid-rule',
          name: 'valid-rule',
          priority: 0,
          action: { channel: 'turnContext', content: 'Body' },
          renderedContent: 'Rendered body.',
        },
        { name: 'missing-id', priority: 0, renderedContent: 'x' },
        { id: 'missing-name', priority: 0, renderedContent: 'x' },
        { id: 'r', name: 'missing-renderedContent', priority: 0 },
        null,
        'bad',
        42,
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('contextRules');
    expect(blocks[0].content).toBe('## valid-rule\nRendered body.');
  });

  it('falls back to JSON when a non-empty contextRules array has no valid entries', () => {
    const blocks = serializeTurnContext({
      contextRules: [{ invalid: 'entry' }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('contextRules');
    expect(blocks[0].content).toContain('"invalid"');
  });

  it('serializes contextRules as JSON when contextRules is non-array', () => {
    const blocks = serializeTurnContext({
      contextRules: { note: 'not-an-array' },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('contextRules');
    expect(blocks[0].content).toContain('"note"');
  });

  it('skips empty contextRules array instead of serializing as JSON', () => {
    const blocks = serializeTurnContext({
      contextRules: [],
      other: 'value',
    });
    expect(blocks).toEqual([{ tag: 'other', content: JSON.stringify('value', null, 2) }]);
  });

  // Intra-contextRules entry ordering is the responsibility of the rules
  // engine (priority sort), not serializeTurnContext. This test covers the
  // inter-block ordering contract (skillCatalog → skills → contextRules → rest).
  it('orders contextRules after skills and before other keys', () => {
    const blocks = serializeTurnContext({
      zebra: 'last',
      contextRules: [
        {
          id: 'r1',
          name: 'rule-a',
          priority: 0,
          action: { channel: 'turnContext', content: 'x' },
          renderedContent: 'Rule A content.',
        },
      ],
      skills: [{ name: 'a-skill', content: 'C' }],
      skillCatalog: [{ name: 'catalog-entry', description: 'D' }],
      alpha: 'first-generic',
    });
    expect(blocks.map((b) => b.tag)).toEqual(['skillCatalog', 'skills', 'contextRules', 'alpha', 'zebra']);
  });

  it('filters out keys with null values', () => {
    const blocks = serializeTurnContext({ present: 'yes', absent: null });
    expect(blocks.map((b) => b.tag)).toEqual(['present']);
  });

  it('filters out keys with undefined values', () => {
    // Cast needed: undefined is not JsonValue, but the runtime guard handles it.
    const ctx = { present: 'yes', absent: undefined } as Record<string, string | undefined>;
    const blocks = serializeTurnContext(ctx as Parameters<typeof serializeTurnContext>[0]);
    expect(blocks.map((b) => b.tag)).toEqual(['present']);
  });

  it('handles mixed: skillCatalog + skills + multiple other keys', () => {
    const blocks = serializeTurnContext({
      skillCatalog: [{ name: 'catalog-entry', description: 'Catalog description' }],
      skills: [{ name: 'active-skill', content: 'Active content' }],
      sessionId: 'abc-123',
      cwd: '/home/user',
    });
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ tag: 'skillCatalog', content: '- catalog-entry: Catalog description' });
    expect(blocks[1]).toEqual({ tag: 'skills', content: '## active-skill\nActive content' });
    expect(blocks[2].tag).toBe('cwd');
    expect(blocks[2].content).toBe(JSON.stringify('/home/user', null, 2));
    expect(blocks[3].tag).toBe('sessionId');
    expect(blocks[3].content).toBe(JSON.stringify('abc-123', null, 2));
  });

  it('orders skills after skillCatalog and before other keys', () => {
    const blocks = serializeTurnContext({
      zebra: 'last',
      skillCatalog: [{ name: 'catalog-entry', description: 'Catalog content' }],
      skills: [{ name: 'skill-entry', content: 'Skill content' }],
      alpha: 'first-non-special',
    });

    expect(blocks.map((block) => block.tag)).toEqual(['skillCatalog', 'skills', 'alpha', 'zebra']);
  });

  it('preserves other turn-context keys alongside rendered skills', () => {
    const blocks = serializeTurnContext({
      skills: [{ name: 'skill-entry', content: 'Skill content' }],
      cwdChange: { from: '/a', to: '/b' },
    });

    expect(blocks).toEqual([
      { tag: 'skills', content: '## skill-entry\nSkill content' },
      { tag: 'cwdChange', content: JSON.stringify({ from: '/a', to: '/b' }, null, 2) },
    ]);
  });
});

describe('formatContextBlocksAsText', () => {
  it('returns empty string for empty block array', () => {
    expect(formatContextBlocksAsText([])).toBe('');
  });

  it('formats a single block as <tag>\\ncontent\\n</tag>', () => {
    const result = formatContextBlocksAsText([{ tag: 'skills', content: '## Intro\nHello' }]);
    expect(result).toBe('<skills>\n## Intro\nHello\n</skills>');
  });

  it('formats multiple blocks separated by \\n\\n', () => {
    const result = formatContextBlocksAsText([
      { tag: 'skills', content: '## G\nContent' },
      { tag: 'cwd', content: '"/workspace"' },
    ]);
    expect(result).toBe('<skills>\n## G\nContent\n</skills>\n\n<cwd>\n"/workspace"\n</cwd>');
  });

  it('escapes XML special characters in block content', () => {
    const result = formatContextBlocksAsText([{ tag: 'test', content: `a & b < c > d "e" 'f'` }]);
    expect(result).toBe('<test>\na &amp; b &lt; c &gt; d "e" &apos;f&apos;\n</test>');
  });

  it('sanitizes invalid tag characters', () => {
    const result = formatContextBlocksAsText([{ tag: 'bad<tag>&name', content: 'x' }]);
    expect(result).toBe('<bad_tag__name>\nx\n</bad_tag__name>');
  });

  it('falls back to context tag when sanitized tag is empty', () => {
    const result = formatContextBlocksAsText([{ tag: '', content: 'x' }]);
    expect(result).toBe('<context>\nx\n</context>');
  });

  it('prefixes tags that start with invalid XML name characters', () => {
    const result = formatContextBlocksAsText([{ tag: '123abc', content: 'x' }]);
    expect(result).toBe('<context_123abc>\nx\n</context_123abc>');
  });
});
