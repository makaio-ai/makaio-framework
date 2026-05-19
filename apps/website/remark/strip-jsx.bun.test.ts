import { describe, expect, it } from 'bun:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { remarkStripJsx, extractLinkCards } from './strip-jsx';

async function transform(md: string): Promise<string> {
  const result = await unified().use(remarkParse).use(remarkStripJsx).use(remarkStringify).process(md);
  return String(result).trim();
}

describe('extractLinkCards', () => {
  it('extracts title, href, and description', () => {
    const html = '<LinkCard title="Bus" href="/guides/bus/" description="Typed event system." />';
    expect(extractLinkCards(html)).toEqual([
      { title: 'Bus', href: '/guides/bus/', description: 'Typed event system.' },
    ]);
  });

  it('extracts multiple cards from a CardGrid', () => {
    const html = [
      '<CardGrid>',
      '  <LinkCard title="A" href="/a/" description="First" />',
      '  <LinkCard title="B" href="/b/" />',
      '</CardGrid>',
    ].join('\n');
    const cards = extractLinkCards(html);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({ title: 'A', href: '/a/', description: 'First' });
    expect(cards[1]).toEqual({ title: 'B', href: '/b/', description: undefined });
  });

  it('returns empty array for unknown JSX', () => {
    expect(extractLinkCards('<SomeComponent prop="val" />')).toEqual([]);
  });
});

describe('remarkStripJsx', () => {
  it('removes import statements', async () => {
    const result = await transform("import { LinkCard } from '@astrojs/starlight/components';");
    expect(result).toBe('');
  });

  it('converts a LinkCard to a markdown link list', async () => {
    const result = await transform(
      '<LinkCard title="Getting Started" href="/guides/getting-started/" description="Install and run." />',
    );
    expect(result).toBe('* [Getting Started](/guides/getting-started/) — Install and run.');
  });

  it('converts a LinkCard without description', async () => {
    const result = await transform('<LinkCard title="Test" href="/test/" />');
    expect(result).toBe('* [Test](/test/)');
  });

  it('converts a CardGrid with multiple LinkCards to a list', async () => {
    const md = [
      '<CardGrid>',
      '  <LinkCard title="A" href="/a/" description="First" />',
      '  <LinkCard title="B" href="/b/" description="Second" />',
      '</CardGrid>',
    ].join('\n');
    const result = await transform(md);
    expect(result).toBe('* [A](/a/) — First\n* [B](/b/) — Second');
  });

  it('removes unknown JSX elements', async () => {
    const result = await transform('<SomeUnknown prop="val" />');
    expect(result).toBe('');
  });

  it('preserves regular HTML tags', async () => {
    const result = await transform('<div>Some content</div>');
    expect(result).toBe('<div>Some content</div>');
  });

  it('preserves regular paragraphs', async () => {
    const result = await transform('Just a paragraph.');
    expect(result).toBe('Just a paragraph.');
  });

  it('converts JSX while preserving surrounding content', async () => {
    const md = [
      'Text before.',
      '',
      "import { LinkCard } from '@astrojs/starlight/components';",
      '',
      '<LinkCard title="Test" href="/test/" description="A page." />',
      '',
      'Text after.',
    ].join('\n');
    const result = await transform(md);
    expect(result).toBe('Text before.\n\n* [Test](/test/) — A page.\n\nText after.');
  });
});
