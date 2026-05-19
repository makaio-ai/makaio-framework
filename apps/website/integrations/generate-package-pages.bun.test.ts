import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  type PackageEntry,
  frontmatterFor,
  generatePackagePageFiles,
  normalizeReadmeLinks,
  parseReadme,
  readmeToSlugPath,
  resolvePackageDescription,
  sidebarDescription,
} from './generate-package-pages';
import { convertGitHubCallouts } from './readme-utils';

describe('parseReadme', () => {
  it('preserves existing frontmatter metadata while deriving title and description', () => {
    const parsed = parseReadme(
      [
        '---',
        'category: Core',
        'title: Ignored',
        '---',
        '# Bus Core',
        '',
        'Typed bus primitives for the framework.',
        '',
      ].join('\n'),
    );

    expect(parsed.metadata).toEqual({ category: 'Core' });
    expect(parsed.title).toBe('Bus Core');
    expect(parsed.description).toBe('Typed bus primitives for the framework.');
  });

  it('escapes preserved frontmatter metadata values', () => {
    expect(
      frontmatterFor(
        {
          title: 'Package',
          description: 'Generated page',
          metadata: { category: 'Core: Runtime' },
          body: '',
        },
        'package',
      ),
    ).toContain('category: "Core: Runtime"');
  });

  it('escapes YAML scalars that cannot be emitted as plain values', () => {
    const frontmatter = frontmatterFor(
      {
        title: '- Package',
        description: 'Generated\npage',
        metadata: { category: ' Core' },
        body: '',
      },
      'package',
    );

    expect(frontmatter).toContain('category: " Core"');
    expect(frontmatter).toContain('title: "- Package"');
    expect(frontmatter).toContain('description: "Generated\\npage"');
  });

  it('emits sidebar label and description attribute for two-line items', () => {
    const frontmatter = frontmatterFor(
      {
        title: 'Bus Core',
        description: 'Typed bus primitives for the framework. Extra context after the first sentence.',
        metadata: {},
        body: '',
      },
      'bus-core',
    );

    expect(frontmatter).toContain('sidebar:');
    expect(frontmatter).toContain('label: bus-core');
    expect(frontmatter).toContain('data-description: Typed bus primitives for the framework');
  });

  it('skips leading GitHub callouts when deriving the README description', () => {
    const parsed = parseReadme(
      ['# Package', '', '> [!IMPORTANT]', '> Use this carefully.', '', 'Public API docs.'].join('\n'),
    );

    expect(parsed.description).toBe('Public API docs.');
  });
});

describe('convertGitHubCallouts', () => {
  it('converts CRLF GitHub callouts to Starlight admonitions', () => {
    expect(convertGitHubCallouts('> [!WARNING]\r\n> First line.\r\n> Second line.\r\n')).toBe(
      ':::caution\nFirst line.\nSecond line.\n:::\n',
    );
  });
});

describe('readmeToSlugPath', () => {
  it('strips leading "packages/" segment so URLs do not nest under /packages/packages/', () => {
    expect(readmeToSlugPath('packages/bus-core/README.md')).toBe('bus-core');
    expect(readmeToSlugPath('packages/services/base/README.md')).toBe('services/base');
  });

  it('keeps non-packages framework subtrees intact for nested sidebar groups', () => {
    expect(readmeToSlugPath('ui/components/README.md')).toBe('ui/components');
    expect(readmeToSlugPath('adapters/implementations/anthropic-sdk/README.md')).toBe(
      'adapters/implementations/anthropic-sdk',
    );
    expect(readmeToSlugPath('transports/ws/README.md')).toBe('transports/ws');
  });
});

describe('resolvePackageDescription', () => {
  it('prefers package.json#description over the README fallback', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-pkg-desc-'));
    fs.mkdirSync(path.join(workspace, 'packages/foo'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'packages/foo/package.json'),
      JSON.stringify({ name: '@makaio/foo', description: 'Canonical npm one-liner.' }),
    );

    try {
      expect(resolvePackageDescription('packages/foo/README.md', workspace, 'README fallback')).toBe(
        'Canonical npm one-liner.',
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('falls back to the README description when package.json is missing or has no description', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-pkg-desc-'));
    fs.mkdirSync(path.join(workspace, 'packages/bar'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'packages/bar/package.json'), JSON.stringify({ name: '@makaio/bar' }));

    try {
      expect(resolvePackageDescription('packages/bar/README.md', workspace, 'README fallback')).toBe('README fallback');
      expect(resolvePackageDescription('packages/missing/README.md', workspace, 'README fallback')).toBe(
        'README fallback',
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('sidebarDescription', () => {
  it('keeps the first sentence and drops the rest', () => {
    expect(sidebarDescription('Typed bus primitives for the framework. Extra context follows.')).toBe(
      'Typed bus primitives for the framework',
    );
  });

  it('caps long single sentences with an ellipsis', () => {
    const long = 'a'.repeat(120);
    const result = sidebarDescription(long);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith('…')).toBe(true);
  });

  it('returns short descriptions unchanged when no sentence terminator is present', () => {
    expect(sidebarDescription('Short blurb without punctuation')).toBe('Short blurb without punctuation');
  });
});

describe('normalizeReadmeLinks', () => {
  it('rewrites README-relative links to source URLs', () => {
    expect(
      normalizeReadmeLinks(
        '[Types](./src/index.ts), [Usage](usage.md), and [Parent](../core/README.md#api)',
        'packages/bus/README.md',
      ),
    ).toBe(
      '[Types](https://github.com/makaio-ai/makaio-framework/blob/main/packages/bus/src/index.ts), [Usage](https://github.com/makaio-ai/makaio-framework/blob/main/packages/bus/usage.md), and [Parent](https://github.com/makaio-ai/makaio-framework/blob/main/packages/core/README.md#api)',
    );
  });

  it('keeps anchors and absolute URLs unchanged', () => {
    expect(normalizeReadmeLinks('[Local](#api) [External](https://example.com)', 'packages/bus/README.md')).toBe(
      '[Local](#api) [External](https://example.com)',
    );
  });

  it('rewrites README-relative images to raw asset URLs', () => {
    expect(normalizeReadmeLinks('![Screenshot](./assets/screen.png)', 'packages/bus/README.md')).toBe(
      '![Screenshot](https://raw.githubusercontent.com/makaio-ai/makaio-framework/main/packages/bus/assets/screen.png)',
    );
  });
});

describe('generatePackagePageFiles', () => {
  it('clears stale generated package pages before writing current pages', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-package-pages-'));
    const stalePage = path.join(workspace, 'src/content/docs/packages/removed.md');
    fs.mkdirSync(path.dirname(stalePage), { recursive: true });
    fs.writeFileSync(stalePage, '---\ntitle: Removed\n---\n');

    try {
      generatePackagePageFiles(path.join(workspace, 'src/content/docs/packages'));

      expect(fs.existsSync(stalePage)).toBe(false);
      expect(fs.existsSync(path.join(workspace, 'src/content/docs/packages/bus-core.md'))).toBe(true);
      expect(fs.existsSync(path.join(workspace, 'src/content/docs/packages/ui/kernel.md'))).toBe(true);
      expect(
        fs.existsSync(path.join(workspace, 'src/content/docs/packages/adapters/implementations/anthropic-sdk.md')),
      ).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails when a configured package README is missing', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-package-pages-'));
    const outputDir = path.join(workspace, 'output');
    const packageEntries: PackageEntry[] = [{ readme: 'packages/missing/README.md' }];

    try {
      expect(() => generatePackagePageFiles(outputDir, packageEntries)).toThrow(
        'Missing README files for generated package pages:\npackages/missing/README.md',
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
