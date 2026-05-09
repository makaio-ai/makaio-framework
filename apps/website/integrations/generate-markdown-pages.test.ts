import { describe, expect, it } from 'vitest';
import { buildRemarkPipeline, processMarkdownBody, stripFrontmatter } from './generate-markdown-pages';

const PACKAGE_OPTIONS = {
  packageSpecifierPattern: /^@makaio\/[a-z0-9][a-z0-9-]*(?:\/[A-Za-z0-9._/-]+)?$/u,
  sourceOnlyLinks: {},
};

describe('stripFrontmatter', () => {
  it('strips YAML frontmatter from markdown', () => {
    const raw = '---\ntitle: Test\ndescription: Hello\n---\n\n# Hello World\n\nBody text.';
    expect(stripFrontmatter(raw)).toBe('# Hello World\n\nBody text.');
  });

  it('returns body unchanged when no frontmatter present', () => {
    const raw = '# No Frontmatter\n\nJust body.';
    expect(stripFrontmatter(raw)).toBe('# No Frontmatter\n\nJust body.');
  });

  it('handles frontmatter with no trailing body', () => {
    const raw = '---\ntitle: Empty\n---\n';
    expect(stripFrontmatter(raw)).toBe('');
  });
});

describe('processMarkdownBody', () => {
  const pipeline = buildRemarkPipeline(PACKAGE_OPTIONS);

  it('passes plain markdown through unchanged', async () => {
    const body = '# Hello\n\nSome paragraph text.';
    const result = await processMarkdownBody(body, pipeline);
    expect(result).toBe('# Hello\n\nSome paragraph text.');
  });

  it('strips .md extensions from relative links', async () => {
    const body = 'See [Patterns](./patterns.md) for details.';
    const result = await processMarkdownBody(body, pipeline);
    expect(result).toContain('[Patterns](./patterns)');
  });

  it('removes web:hide blocks', async () => {
    const body = [
      'Visible before.',
      '<!-- web:hide -->',
      'This should be hidden.',
      '<!-- /web:hide -->',
      'Visible after.',
    ].join('\n\n');
    const result = await processMarkdownBody(body, pipeline);
    expect(result).toContain('Visible before.');
    expect(result).toContain('Visible after.');
    expect(result).not.toContain('hidden');
  });

  it('preserves code blocks', async () => {
    const body = '```typescript\nconst x = 1;\n```';
    const result = await processMarkdownBody(body, pipeline);
    expect(result).toContain('```typescript\nconst x = 1;\n```');
  });

  it('preserves GFM tables', async () => {
    const body = '| Col A | Col B |\n| --- | --- |\n| 1 | 2 |';
    const result = await processMarkdownBody(body, pipeline);
    expect(result).toContain('Col A');
    expect(result).toContain('Col B');
  });

  it('strips JSX import statements', async () => {
    const body = "import { LinkCard } from '@astrojs/starlight/components';\n\n# Hello";
    const result = await processMarkdownBody(body, pipeline);
    expect(result).not.toContain('import');
    expect(result).toContain('# Hello');
  });

  it('converts LinkCard JSX to markdown links', async () => {
    const body = '# Hello\n\n<LinkCard title="Test" href="/test/" description="A page." />';
    const result = await processMarkdownBody(body, pipeline);
    expect(result).not.toContain('LinkCard');
    expect(result).toContain('[Test](/test/) — A page.');
  });
});
