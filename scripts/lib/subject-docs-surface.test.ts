import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toMarkdownOptions } from './namespace-analyzer/cli.js';
import {
  findSubjectDocDrift,
  formatSubjectDocDriftMessage,
  SUBJECT_DOCS_CONFIG,
  SUBJECT_DOCS_DIR_RELATIVE,
  type GeneratedSubjectDoc,
} from './subject-docs-surface.js';

const PAGES: GeneratedSubjectDoc[] = [
  { path: 'index.md', content: '# index\n' },
  { path: 'kernel.md', content: '# kernel\n' },
  { path: 'extensions/index.md', content: '# extensions\n' },
];

describe('subject docs surface', () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = mkdtempSync(join(tmpdir(), 'subject-docs-'));
    for (const page of PAGES) {
      const target = join(docsDir, page.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, page.content, 'utf-8');
    }
  });

  afterEach(() => {
    rmSync(docsDir, { recursive: true, force: true });
  });

  it('reports no drift when every committed page matches', () => {
    expect(findSubjectDocDrift(PAGES, docsDir)).toEqual({ stale: [], orphaned: [] });
  });

  it('reports edited pages as stale', () => {
    writeFileSync(join(docsDir, 'kernel.md'), '# kernel (hand edited)\n', 'utf-8');

    expect(findSubjectDocDrift(PAGES, docsDir)).toEqual({
      stale: ['kernel.md'],
      orphaned: [],
    });
  });

  it('reports missing pages as stale', () => {
    rmSync(join(docsDir, 'extensions/index.md'));

    expect(findSubjectDocDrift(PAGES, docsDir)).toEqual({
      stale: ['extensions/index.md'],
      orphaned: [],
    });
  });

  it('reports committed pages that are no longer generated as orphaned', () => {
    writeFileSync(join(docsDir, 'removed-namespace.md'), '# removed\n', 'utf-8');

    expect(findSubjectDocDrift(PAGES, docsDir)).toEqual({
      stale: [],
      orphaned: ['removed-namespace.md'],
    });
  });

  it('reports every generated page as stale, not ENOENT, when the docs root is absent', () => {
    rmSync(docsDir, { recursive: true, force: true });

    expect(findSubjectDocDrift(PAGES, docsDir)).toEqual({
      stale: ['extensions/index.md', 'index.md', 'kernel.md'],
      orphaned: [],
    });
  });

  it('still throws on an I/O error other than an absent docs root', () => {
    rmSync(docsDir, { recursive: true, force: true });
    writeFileSync(docsDir, 'not a directory', 'utf-8');

    expect(() => findSubjectDocDrift(PAGES, docsDir)).toThrow();
  });

  it('ignores the gitignored analysis data directory even when it holds a tracked-looking .md file', () => {
    mkdirSync(join(docsDir, 'data'), { recursive: true });
    writeFileSync(join(docsDir, 'data/namespaces.json'), '{}', 'utf-8');
    writeFileSync(join(docsDir, 'data/inventory.md'), '# inventory\n', 'utf-8');

    expect(findSubjectDocDrift(PAGES, docsDir)).toEqual({ stale: [], orphaned: [] });
  });

  it('names the regeneration command and prefixes every affected page with the report root', () => {
    const message = formatSubjectDocDriftMessage(
      { stale: ['kernel.md'], orphaned: ['removed.md'] },
      'yarn docs:bus',
      'docs/subjects',
    );

    expect(message).toBe(
      [
        'Bus subject docs are stale. Run `yarn docs:bus` and commit the regenerated pages:',
        '- outdated: docs/subjects/kernel.md',
        '- no longer generated: docs/subjects/removed.md',
      ].join('\n'),
    );
  });

  it('prefixes reported pages with a host-supplied report root instead of the framework default', () => {
    const message = formatSubjectDocDriftMessage(
      { stale: ['kernel.md'], orphaned: [] },
      'yarn docs:bus:framework',
      'framework/docs/subjects',
    );

    expect(message).toContain('- outdated: framework/docs/subjects/kernel.md');
  });

  it('never references {commit} in its source base URL, so the surface stays reproducible from any commit', () => {
    // The freshness gate renders this surface without ever computing a source commit
    // (see `generateSubjectDocs`), so a `{commit}` placeholder could never resolve to
    // anything but the commit that happened to regenerate the committed pages.
    expect(SUBJECT_DOCS_CONFIG.sourceBaseUrl).not.toContain('{commit}');
  });

  it('pins generated source links to the requested branch', () => {
    const options = toMarkdownOptions(SUBJECT_DOCS_CONFIG, {
      docsRoot: SUBJECT_DOCS_DIR_RELATIVE,
      sourceCommit: 'deadbeef',
      branch: 'main',
    });

    expect(options.sourceBaseUrl).toBe('https://github.com/makaio-ai/makaio-framework/blob/main');
    expect(options.indexFileName).toBe('index.md');
  });
});
