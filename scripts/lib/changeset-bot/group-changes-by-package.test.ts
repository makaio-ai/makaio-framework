import { describe, expect, it } from 'vitest';
import { groupChangesByPackage } from './group-changes-by-package.js';
import type { CodeRabbitChangeRow } from './parse-coderabbit-summary.js';

const ROWS: CodeRabbitChangeRow[] = [
  {
    paths: ['framework/packages/contracts/src/extension/', 'framework/packages/contracts/src/index.ts'],
    summary: 'Adds DetachedTransportSchema and descriptor types.',
  },
  {
    paths: ['framework/packages/subprocess/'],
    summary: 'New subprocess package with JSONL transport.',
  },
  {
    paths: ['framework/transports/stdio/'],
    summary: 'Adds StdioClientTransport and StdioServerTransport.',
  },
  {
    paths: ['framework/adapters/implementations/codex-app-server/'],
    summary: 'Refactors JSON-RPC client.',
  },
  {
    paths: ['host/apps/server/'],
    summary: 'Host build changes.',
  },
];

describe('groupChangesByPackage', () => {
  it('groups rows by publishable package with prefix stripped', () => {
    const result = groupChangesByPackage(ROWS, 'framework');

    expect(result).toEqual([
      {
        packageName: '@makaio/adapter-codex-app-server',
        summaries: ['Refactors JSON-RPC client.'],
      },
      {
        packageName: '@makaio/contracts',
        summaries: ['Adds DetachedTransportSchema and descriptor types.'],
      },
      {
        packageName: '@makaio/framework',
        summaries: [
          'New subprocess package with JSONL transport.',
          'Adds StdioClientTransport and StdioServerTransport.',
        ],
      },
    ]);
  });

  it('skips non-framework paths when prefix is framework', () => {
    const result = groupChangesByPackage(ROWS, 'framework');
    const summaries = result.flatMap((r) => r.summaries);
    expect(summaries).not.toContain('Host build changes.');
  });

  it('works without prefix', () => {
    const standaloneRows: CodeRabbitChangeRow[] = [
      { paths: ['packages/contracts/src/index.ts'], summary: 'Update contracts.' },
      { paths: ['packages/kernel/src/boot.ts'], summary: 'Fix boot sequence.' },
    ];

    const result = groupChangesByPackage(standaloneRows, '');

    expect(result).toEqual([
      { packageName: '@makaio/contracts', summaries: ['Update contracts.'] },
      { packageName: '@makaio/framework', summaries: ['Fix boot sequence.'] },
    ]);
  });

  it('merges multiple rows into the same package', () => {
    const rows: CodeRabbitChangeRow[] = [
      { paths: ['packages/kernel/src/a.ts'], summary: 'Change A.' },
      { paths: ['packages/bus-core/src/b.ts'], summary: 'Change B.' },
    ];

    const result = groupChangesByPackage(rows, '');

    expect(result).toEqual([{ packageName: '@makaio/framework', summaries: ['Change A.', 'Change B.'] }]);
  });

  it('deduplicates identical summaries within a package', () => {
    const rows: CodeRabbitChangeRow[] = [
      { paths: ['packages/kernel/src/a.ts'], summary: 'Same change.' },
      { paths: ['packages/kernel/src/b.ts'], summary: 'Same change.' },
    ];

    const result = groupChangesByPackage(rows, '');
    expect(result[0].summaries).toEqual(['Same change.']);
  });

  it('returns empty array for empty input', () => {
    expect(groupChangesByPackage([], 'framework')).toEqual([]);
  });

  it('handles a row whose paths span multiple packages', () => {
    const rows: CodeRabbitChangeRow[] = [
      {
        paths: ['packages/contracts/src/foo.ts', 'packages/kernel/src/bar.ts'],
        summary: 'Cross-cutting change.',
      },
    ];

    const result = groupChangesByPackage(rows, '');
    expect(result).toEqual([
      { packageName: '@makaio/contracts', summaries: ['Cross-cutting change.'] },
      { packageName: '@makaio/framework', summaries: ['Cross-cutting change.'] },
    ]);
  });
});
