import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { remarkStripMdLinks } from './strip-md-links';

async function transform(md: string): Promise<string> {
  const result = await unified().use(remarkParse).use(remarkStripMdLinks).use(remarkStringify).process(md);
  return String(result).trim();
}

describe('remarkStripMdLinks', () => {
  it('strips .md from relative links', async () => {
    const result = await transform('[Patterns](./patterns.md)');
    expect(result).toBe('[Patterns](./patterns)');
  });

  it('strips .mdx from relative links', async () => {
    const result = await transform('[Page](./page.mdx)');
    expect(result).toBe('[Page](./page)');
  });

  it('strips index.md to directory path', async () => {
    const result = await transform('[Bus](./bus/index.md)');
    expect(result).toBe('[Bus](./bus/)');
  });

  it('preserves fragment identifiers', async () => {
    const result = await transform('[Namespaces](./bus/index.md#namespaces)');
    expect(result).toBe('[Namespaces](./bus/#namespaces)');
  });

  it('handles parent-relative links', async () => {
    const result = await transform('[Transport](../transport.md)');
    expect(result).toBe('[Transport](../transport)');
  });

  it('does not touch absolute URLs', async () => {
    const result = await transform('[GitHub](https://github.com/foo/bar.md)');
    expect(result).toBe('[GitHub](https://github.com/foo/bar.md)');
  });

  it('does not touch anchor-only links', async () => {
    const result = await transform('[Section](#section)');
    expect(result).toBe('[Section](#section)');
  });

  it('does not touch non-md relative links', async () => {
    const result = await transform('[Image](./diagram.png)');
    expect(result).toBe('[Image](./diagram.png)');
  });

  it('handles links to README.md (non-docs paths)', async () => {
    const result = await transform('[Readme](../core/bus-core/README.md)');
    expect(result).toBe('[Readme](../core/bus-core/README)');
  });
});
