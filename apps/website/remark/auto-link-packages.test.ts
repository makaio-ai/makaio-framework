import { describe, expect, it, vi, beforeEach } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import fs from 'node:fs';
import type { RemarkAutoLinkPackagesOptions } from './auto-link-packages';

vi.mock('node:fs');

const SOURCE_URL_BASE = 'https://github.com/makaio-ai/makaio-framework/blob/main';
const OPTIONS: RemarkAutoLinkPackagesOptions = {
  packageSpecifierPattern: /^@makaio\/[a-z0-9][a-z0-9-]*(?:\/[A-Za-z0-9._/-]+)?$/u,
  sourceOnlyLinks: {
    '@makaio/build-tooling/browser-shared-externals': `${SOURCE_URL_BASE}/build-tooling/browser-shared-externals.ts`,
    '@makaio/build-tooling/tsdown-extension-preset': `${SOURCE_URL_BASE}/build-tooling/tsdown-extension-preset.ts`,
  },
};

const SAMPLE_MANIFEST: Record<string, string> = {
  '@makaio/ui-hooks': '/packages/ui-hooks/',
  '@makaio/kernel': '/packages/kernel/',
};

beforeEach(() => {
  vi.resetModules();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_MANIFEST));
});

async function transform(md: string): Promise<string> {
  const { remarkAutoLinkPackages } = await import('./auto-link-packages');
  const result = await unified().use(remarkParse).use(remarkAutoLinkPackages, OPTIONS).use(remarkStringify).process(md);
  return String(result).trim();
}

describe('remarkAutoLinkPackages', () => {
  it('links known package code spans to generated package routes', async () => {
    const result = await transform('Use `@makaio/ui-hooks` for bus-aware React code.');
    expect(result).toBe('Use [`@makaio/ui-hooks`](/packages/ui-hooks/) for bus-aware React code.');
  });

  it('links package subpaths to their package route', async () => {
    const result = await transform('Import CLI helpers from `@makaio/kernel/cli`.');
    expect(result).toBe('Import CLI helpers from [`@makaio/kernel/cli`](/packages/kernel/).');
  });

  it('rewrites existing Markdown links with package labels to website routes', async () => {
    const result = await transform('[`@makaio/ui-hooks`](../../ui/hooks/README.md)');
    expect(result).toBe('[`@makaio/ui-hooks`](/packages/ui-hooks/)');
  });

  it('links source-only build-tooling subpaths to repository source', async () => {
    const result = await transform('See `@makaio/build-tooling/browser-shared-externals`.');
    expect(result).toBe(
      'See [`@makaio/build-tooling/browser-shared-externals`](https://github.com/makaio-ai/makaio-framework/blob/main/build-tooling/browser-shared-externals.ts).',
    );
  });

  it('does not link unknown package specifiers', async () => {
    const result = await transform('The old `@makaio/web-core` package is gone.');
    expect(result).toBe('The old `@makaio/web-core` package is gone.');
  });

  it('retries manifest loading after malformed JSON', async () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce('{broken').mockReturnValue(JSON.stringify(SAMPLE_MANIFEST));
    const result = await transform('Use `@makaio/ui-hooks` for bus-aware React code.');
    expect(result).toBe('Use `@makaio/ui-hooks` for bus-aware React code.');

    const retried = await transform('Use `@makaio/ui-hooks` for bus-aware React code.');
    expect(retried).toBe('Use [`@makaio/ui-hooks`](/packages/ui-hooks/) for bus-aware React code.');
  });
});
