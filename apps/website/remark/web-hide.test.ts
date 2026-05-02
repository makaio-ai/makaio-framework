import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { remarkWebHide } from './web-hide';

async function transform(md: string): Promise<string> {
  const result = await unified().use(remarkParse).use(remarkWebHide).use(remarkStringify).process(md);
  return String(result).trim();
}

describe('remarkWebHide', () => {
  it('removes content between markers', async () => {
    const input = [
      'Before',
      '',
      '<!-- web:hide -->',
      '',
      '| File | Purpose |',
      '|------|---------|',
      '| `foo.ts` | The foo |',
      '',
      '<!-- /web:hide -->',
      '',
      'After',
    ].join('\n');

    const result = await transform(input);
    expect(result).toBe('Before\n\nAfter');
  });

  it('preserves content outside markers', async () => {
    const input = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '<!-- web:hide -->',
      '',
      'Hidden section.',
      '',
      '<!-- /web:hide -->',
      '',
      '## Next Section',
      '',
      'Visible content.',
    ].join('\n');

    const result = await transform(input);
    expect(result).toContain('# Title');
    expect(result).toContain('Intro paragraph.');
    expect(result).toContain('## Next Section');
    expect(result).toContain('Visible content.');
    expect(result).not.toContain('Hidden section.');
  });

  it('handles multiple hide regions', async () => {
    const input = [
      'A',
      '',
      '<!-- web:hide -->',
      '',
      'Hidden 1',
      '',
      '<!-- /web:hide -->',
      '',
      'B',
      '',
      '<!-- web:hide -->',
      '',
      'Hidden 2',
      '',
      '<!-- /web:hide -->',
      '',
      'C',
    ].join('\n');

    const result = await transform(input);
    expect(result).toBe('A\n\nB\n\nC');
  });

  it('leaves content unchanged when no markers present', async () => {
    const input = '# Just a heading\n\nSome content.';
    const result = await transform(input);
    expect(result).toContain('# Just a heading');
    expect(result).toContain('Some content.');
  });

  it('ignores unmatched open marker without close', async () => {
    const input = ['Before', '', '<!-- web:hide -->', '', 'Still visible because no close marker.'].join('\n');

    const result = await transform(input);
    expect(result).toContain('Still visible because no close marker.');
  });

  it('handles markers at end of file', async () => {
    const input = ['Content', '', '<!-- web:hide -->', '', 'Hidden at end.', '', '<!-- /web:hide -->'].join('\n');

    const result = await transform(input);
    expect(result).toBe('Content');
  });
});
