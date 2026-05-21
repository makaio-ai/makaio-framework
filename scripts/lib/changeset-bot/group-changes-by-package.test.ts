import { describe, expect, it } from 'vitest';
import { groupChangesByPackage } from './group-changes-by-package.js';
import type { CodeRabbitChangeRow } from './parse-coderabbit-summary.js';

const ROWS: CodeRabbitChangeRow[] = [
  {
    paths: ['framework/core/contracts/src/extension/', 'framework/core/contracts/src/index.ts'],
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
      { paths: ['core/contracts/src/index.ts'], summary: 'Update contracts.' },
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
      { paths: ['core/bus-core/src/b.ts'], summary: 'Change B.' },
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
        paths: ['core/contracts/src/foo.ts', 'packages/kernel/src/bar.ts'],
        summary: 'Cross-cutting change.',
      },
    ];

    const result = groupChangesByPackage(rows, '');
    expect(result).toEqual([
      { packageName: '@makaio/contracts', summaries: ['Cross-cutting change.'] },
      { packageName: '@makaio/framework', summaries: ['Cross-cutting change.'] },
    ]);
  });

  it('groups CodeRabbit summaries under real package names and skips display placeholders', () => {
    const rows: CodeRabbitChangeRow[] = [
      {
        paths: ['framework/clients/...', 'framework/extensions/...'],
        summary: 'Retypes many packages.',
      },
      {
        paths: ['framework/extensions/reviewer-coderabbit/src/index.ts'],
        summary: 'Adds reviewer extension metadata.',
      },
      {
        paths: ['framework/providers/qwen/src/package.ts'],
        summary: 'Updates Qwen provider registration.',
      },
      {
        paths: ['framework/adapters/implementations/__tests__/shared.ts'],
        summary: 'Updates shared adapter test setup.',
      },
    ];

    const result = groupChangesByPackage(rows, 'framework');

    expect(result).toEqual([
      {
        packageName: '@makaio/framework',
        summaries: ['Updates shared adapter test setup.'],
      },
      {
        packageName: '@makaio/provider-qwen-acp',
        summaries: ['Updates Qwen provider registration.'],
      },
      {
        packageName: '@makaio/reviewer-coderabbit',
        summaries: ['Adds reviewer extension metadata.'],
      },
    ]);
  });
});
