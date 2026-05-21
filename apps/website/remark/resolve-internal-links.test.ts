import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { remarkResolveInternalLinks, normalizeRoute, mapToRoute } from './resolve-internal-links';

// ---------------------------------------------------------------------------
// Unit tests for pure helpers
// ---------------------------------------------------------------------------

describe('normalizeRoute', () => {
  it('lowercases and strips /index', () => {
    expect(normalizeRoute('extensions/index')).toBe('extensions');
    expect(normalizeRoute('Extensions/Foo')).toBe('extensions/foo');
  });

  it('returns "index" for empty route', () => {
    expect(normalizeRoute('')).toBe('index');
    expect(normalizeRoute('index')).toBe('index');
  });

  it('removes non-slug characters per segment', () => {
    expect(normalizeRoute('guides/models-and-providers')).toBe('guides/models-and-providers');
    expect(normalizeRoute('guides/Models & Providers')).toBe('guides/modelsproviders');
  });
});

describe('mapToRoute', () => {
  it('maps docs/architecture/* to architecture/*', () => {
    expect(mapToRoute('docs/architecture/bus/index')).toBe('architecture/bus');
  });

  it('maps docs/* to guides/*', () => {
    expect(mapToRoute('docs/connect')).toBe('guides/connect');
  });

  it('maps extensions directory to extensions route', () => {
    expect(mapToRoute('extensions')).toBe('extensions');
  });

  it('maps extensions/* to extensions/*', () => {
    expect(mapToRoute('extensions/account-manager')).toBe('extensions/account-manager');
  });

  it('maps content docs directly', () => {
    expect(mapToRoute('apps/website/src/content/docs/why')).toBe('why');
  });

  it('maps packages, adapters, clients, providers, sdks', () => {
    expect(mapToRoute('core/bus-core')).toBe('packages/bus-core');
    expect(mapToRoute('adapters/openai-node')).toBe('adapters/openai-node');
    expect(mapToRoute('clients/claude-code')).toBe('clients/claude-code');
    expect(mapToRoute('providers/anthropic')).toBe('providers/anthropic');
    expect(mapToRoute('sdks/python')).toBe('sdks/python');
  });

  it('returns undefined for source-code paths', () => {
    expect(mapToRoute('apps/electron/src/main/main.ts')).toBeUndefined();
    expect(mapToRoute('runtimes/node/src/boot.ts')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests with a mock filesystem
// ---------------------------------------------------------------------------

describe('remarkResolveInternalLinks', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remark-resolve-'));

    const dirs = [
      'docs',
      'docs/architecture/bus',
      'apps/website/src/content/docs/extensions',
      'apps/website/src/content/docs/packages',
      'extensions/account-manager',
      'extensions/client-hooks',
      'apps/electron/src/main',
    ];
    for (const d of dirs) fs.mkdirSync(path.join(tmpRoot, d), { recursive: true });

    const files: Record<string, string> = {
      'docs/connect.md': '---\ntitle: Connect\n---\n',
      'docs/getting-started.md': '---\ntitle: GS\n---\n',
      'docs/creating-extensions.md': '---\ntitle: CE\n---\n',
      'docs/architecture/bus/index.md': '---\ntitle: Bus\n---\n',
      'apps/website/src/content/docs/extensions/account-manager.md': '---\ntitle: AM\n---\n',
      'apps/website/src/content/docs/extensions/index.md': '---\ntitle: Ext\n---\n',
      'apps/website/src/content/docs/packages/bus-core.md': '---\ntitle: BC\n---\n',
      'apps/electron/src/main/main.ts': 'export {};',
    };
    for (const [rel, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmpRoot, rel), body);
    }
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function transform(md: string, sourceFile: string): Promise<string> {
    const result = unified()
      .use(remarkParse)
      .use(remarkResolveInternalLinks, {
        frameworkRoot: tmpRoot,
        sourceUrlBase: 'https://github.com/example/repo/blob/main',
      })
      .use(remarkStringify)
      .process({ value: md, path: sourceFile });
    return result.then((r) => String(r).trim());
  }

  it('rewrites a valid cross-tree link to an absolute URL', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[Getting Started](./getting-started.md)', src);
    expect(result).toBe('[Getting Started](/guides/getting-started/)');
  });

  it('rewrites a valid extension link from docs', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[AM](../extensions/account-manager/)', src);
    expect(result).toBe('[AM](/extensions/account-manager/)');
  });

  it('strips dead links to private extensions', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[client-hooks](../extensions/client-hooks/)', src);
    expect(result).toBe('client-hooks');
  });

  it('resolves architecture links correctly from docs/', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[Bus](./architecture/bus/index.md#ns)', src);
    expect(result).toBe('[Bus](/architecture/bus/#ns)');
  });

  it('rewrites source-code links to GitHub URLs', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[main](../apps/electron/src/main/main.ts)', src);
    expect(result).toBe('[main](https://github.com/example/repo/blob/main/apps/electron/src/main/main.ts)');
  });

  it('preserves external URLs', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[GH](https://github.com)', src);
    expect(result).toBe('[GH](https://github.com)');
  });

  it('preserves anchor-only links', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[Section](#foo)', src);
    expect(result).toBe('[Section](#foo)');
  });

  it('strips .md extension in fallback mode (no VFile path)', async () => {
    const result = await unified()
      .use(remarkParse)
      .use(remarkResolveInternalLinks, { frameworkRoot: tmpRoot })
      .use(remarkStringify)
      .process({ value: '[Link](./foo.md)' })
      .then((r) => String(r).trim());
    expect(result).toBe('[Link](./foo)');
  });

  it('resolves links from content docs correctly', async () => {
    const src = path.join(tmpRoot, 'apps/website/src/content/docs/extensions/index.md');
    const result = await transform('[AM](./account-manager)', src);
    expect(result).toBe('[AM](/extensions/account-manager/)');
  });

  it('resolves directory links (trailing slash) to index routes', async () => {
    const src = path.join(tmpRoot, 'docs/connect.md');
    const result = await transform('[All](../extensions/)', src);
    expect(result).toBe('[All](/extensions/)');
  });
});
