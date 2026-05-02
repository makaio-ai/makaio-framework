import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSourceCommit, writeBusSubjectPages } from './generate-bus-subjects';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-bus-subjects-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('writeBusSubjectPages', () => {
  it('writes Starlight pages from generated bus subject Markdown', () => {
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(path.join(outputDir, 'stale'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'stale/page.md'), '# stale\n');

    writeBusSubjectPages({
      outputDir,
      sourceCommit: 'abc123',
      files: [
        {
          path: 'README.md',
          content: '# Bus Subject Namespaces (Framework)\n\n[Adapters](./adapters/README.md)\n',
        },
        {
          path: 'adapters/README.md',
          content: '# adapters\n\nAdapter subject summary.\n',
        },
        {
          path: 'adapters/anthropic-sdk.md',
          content:
            '# `adapter:anthropic-sdk`\n\n' + '[`namespace.ts`](../../../../../../../adapters/core/src/namespace.ts)\n',
        },
      ],
    });

    expect(fs.existsSync(path.join(outputDir, 'stale/page.md'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'README.md'))).toBe(false);

    expect(fs.readFileSync(path.join(outputDir, 'index.md'), 'utf8')).toBe(
      [
        '---',
        'title: "Bus Subject Namespaces (Framework)"',
        'editUrl: false',
        'prev: false',
        'next: false',
        '---',
        '',
        '# Bus Subject Namespaces (Framework)',
        '',
        '[Adapters](./adapters/)',
        '',
      ].join('\n'),
    );
    expect(fs.readFileSync(path.join(outputDir, 'adapters/index.md'), 'utf8')).toContain('title: "adapters"');
    const adapterPage = fs.readFileSync(path.join(outputDir, 'adapters/anthropic-sdk.md'), 'utf8');
    expect(adapterPage).toContain('title: "adapter:anthropic-sdk"');
    expect(adapterPage).toContain(
      '[`namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/abc123/adapters/core/src/namespace.ts)',
    );
  });
});

describe('resolveSourceCommit', () => {
  it('falls back when Git metadata is unavailable', () => {
    const nonRepository = path.join(tempDir, 'not-a-repo');
    fs.mkdirSync(nonRepository);

    expect(resolveSourceCommit(nonRepository)).toBe('unknown');
  });
});
