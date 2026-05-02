import { describe, expect, it, vi, beforeEach } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import fs from 'node:fs';

vi.mock('node:fs');

const SAMPLE_MANIFEST: Record<string, string> = {
  AIAdapter: '/reference/api/ai-adapters-core/classes/aiadapter/',
  AIAgent: '/reference/api/ai-adapters-core/classes/aiagent/',
  IMakaioBus: '/reference/api/bus-core/interfaces/imakaiobusinterface/',
};

beforeEach(() => {
  vi.resetModules();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_MANIFEST));
});

async function transform(md: string): Promise<string> {
  const { remarkAutoLinkApi } = await import('./auto-link-api');
  const result = await unified().use(remarkParse).use(remarkAutoLinkApi).use(remarkStringify).process(md);
  return String(result).trim();
}

describe('remarkAutoLinkApi', () => {
  it('links a known symbol', async () => {
    const result = await transform('Use `AIAdapter` to manage adapters.');
    expect(result).toBe('Use [`AIAdapter`](/reference/api/ai-adapters-core/classes/aiadapter/) to manage adapters.');
  });

  it('does not link unknown symbols', async () => {
    const result = await transform('Use `SomeUnknownClass` for things.');
    expect(result).toBe('Use `SomeUnknownClass` for things.');
  });

  it('only links the first occurrence per symbol', async () => {
    const result = await transform('`AIAdapter` is great. Use `AIAdapter` again.');
    expect(result).toContain('[`AIAdapter`](/reference/api/ai-adapters-core/classes/aiadapter/)');
    const linkCount = (result.match(/\[`AIAdapter`\]/g) ?? []).length;
    expect(linkCount).toBe(1);
  });

  it('does not link code spans already inside a link', async () => {
    const result = await transform('[`AIAdapter`](./custom-link)');
    expect(result).toBe('[`AIAdapter`](./custom-link)');
  });

  it('links multiple different symbols', async () => {
    const result = await transform('`AIAdapter` and `AIAgent` are both important.');
    expect(result).toContain('[`AIAdapter`](/reference/api/ai-adapters-core/classes/aiadapter/)');
    expect(result).toContain('[`AIAgent`](/reference/api/ai-adapters-core/classes/aiagent/)');
  });

  it('normalizes manifest route casing to match generated Starlight routes', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        AIAdapter: '/reference/api/ai-adapters-core/classes/AIAdapter/',
      }),
    );

    const result = await transform('Use `AIAdapter` to manage adapters.');
    expect(result).toBe('Use [`AIAdapter`](/reference/api/ai-adapters-core/classes/aiadapter/) to manage adapters.');
  });

  it('handles missing manifest gracefully', async () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await transform('`AIAdapter` stays plain.');
    expect(result).toBe('`AIAdapter` stays plain.');
  });

  it('retries manifest loading after malformed JSON', async () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce('{broken').mockReturnValue(JSON.stringify(SAMPLE_MANIFEST));
    const result = await transform('`AIAdapter` stays plain.');
    expect(result).toBe('`AIAdapter` stays plain.');

    const retried = await transform('Use `AIAdapter` to manage adapters.');
    expect(retried).toBe('Use [`AIAdapter`](/reference/api/ai-adapters-core/classes/aiadapter/) to manage adapters.');
  });
});
