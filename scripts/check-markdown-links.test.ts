import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkMarkdownLinks,
  collectMarkdownFiles,
  parseCliArgs,
  parseMarkdownLinkTarget,
  resolveLocalMarkdownTarget,
} from './check-markdown-links.js';

describe('check-markdown-links', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves extensionless markdown links, directory index links, and directory readmes', () => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-links-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'docs', 'guide'), { recursive: true });
    mkdirSync(join(root, 'docs', 'package'), { recursive: true });
    writeFileSync(join(root, 'docs', 'intro.md'), '# Intro\n');
    writeFileSync(join(root, 'docs', 'guide', 'index.md'), '# Guide\n');
    writeFileSync(join(root, 'docs', 'package', 'README.md'), '# Package\n');

    expect(resolveLocalMarkdownTarget(root, 'docs/readme.md', './intro')).toBe(join(root, 'docs', 'intro.md'));
    expect(resolveLocalMarkdownTarget(root, 'docs/readme.md', './guide')).toBe(join(root, 'docs', 'guide', 'index.md'));
    expect(resolveLocalMarkdownTarget(root, 'docs/readme.md', './package')).toBe(
      join(root, 'docs', 'package', 'README.md'),
    );
  });

  it('reports missing relative links while ignoring external URLs and anchors', () => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-links-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'readme.md'),
      [
        '[ok](https://example.com)',
        '[anchor](#local)',
        '[missing](./missing-page)',
        '![missing image](./missing-image.png)',
      ].join('\n'),
    );

    const result = checkMarkdownLinks(root, ['docs/readme.md']);

    expect(result.missingLinks.map((link) => link.target)).toEqual(['./missing-page', './missing-image.png']);
  });

  it('ignores site-root-relative links', () => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-links-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'readme.md'), '[reference](/reference/api)\n');

    const result = checkMarkdownLinks(root, ['docs/readme.md']);

    expect(result.missingLinks).toEqual([]);
  });

  it('collects changed markdown files from staged, unstaged, and untracked git output', () => {
    const files = collectMarkdownFiles({
      mode: 'changed',
      root: '/repo',
      listGitFiles: (args) => {
        if (args.includes('--cached')) {
          return 'docs/staged.md\nproduct/app.ts\n';
        }
        if (args.includes('--others')) {
          return 'docs/new-page.md\n';
        }
        return 'docs/unstaged.md\nREADME.md\n';
      },
      listAllFiles: () => {
        throw new Error('all-file scan should not run');
      },
    });

    expect(files).toEqual(['README.md', 'docs/new-page.md', 'docs/staged.md', 'docs/unstaged.md']);
  });

  it('limits collected markdown files to explicit scan paths', () => {
    const files = collectMarkdownFiles({
      mode: 'all',
      root: '/repo',
      scanPaths: ['framework/docs'],
      listGitFiles: () => {
        throw new Error('git file scan should not run');
      },
      listAllFiles: () => [
        'README.md',
        'framework/docs/index.md',
        'framework/docs/subjects/session.md',
        'framework/packages/contracts/README.md',
      ],
    });

    expect(files).toEqual(['framework/docs/index.md', 'framework/docs/subjects/session.md']);
  });

  it('parses scan paths from --path flags and positional paths', () => {
    expect(parseCliArgs(['--all', '--path', 'framework/docs', 'README.md'], '/repo')).toEqual({
      mode: 'all',
      root: '/repo',
      scanPaths: ['README.md', 'framework/docs'],
    });
  });

  it('parses angle-bracket targets without treating spaces as titles', () => {
    expect(parseMarkdownLinkTarget('<./docs/My File.md> "Title"')).toBe('./docs/My File.md');
    expect(parseMarkdownLinkTarget('./docs/readme.md "Title"')).toBe('./docs/readme.md');
  });

  it('resolves angle-bracketed links containing parentheses', () => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-links-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'Guide (v2).md'), '# Guide v2\n');
    writeFileSync(join(root, 'docs', 'readme.md'), '[guide](<./Guide (v2).md>)\n');

    const result = checkMarkdownLinks(root, ['docs/readme.md']);

    expect(result.missingLinks).toEqual([]);
  });

  it('does not crash on malformed percent-escapes in link targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-links-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'readme.md'), '[bad](./foo%ZZbar.md)\n');

    const result = checkMarkdownLinks(root, ['docs/readme.md']);

    expect(result.missingLinks).toHaveLength(1);
    expect(result.missingLinks[0].target).toBe('./foo%ZZbar.md');
  });
});
