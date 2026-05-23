import { describe, expect, it } from 'vitest';
import {
  checkPackageOverview,
  parsePackageOverviewEntries,
  parseYarnWorkspacesList,
} from './package-overview-invariants.js';

const overview = `
# Package Overview

| Path | Package | Description |
|------|---------|-------------|
| \`packages/utils\` | \`@makaio/utils\` | Utility primitives. |
| \`core/contracts\` | \`@makaio/contracts\` | Shared contracts. |

| Other | Table |
|-------|-------|
| \`not/a/package\` | \`ignored\` |
`;

describe('package overview invariants', () => {
  it('parses only package inventory tables', () => {
    expect(parsePackageOverviewEntries(overview)).toEqual([
      { location: 'packages/utils', name: '@makaio/utils' },
      { location: 'core/contracts', name: '@makaio/contracts' },
    ]);
  });

  it('parses Yarn workspace JSON lines and ignores the root workspace', () => {
    expect(
      parseYarnWorkspacesList(
        [
          '{"location":".","name":"@makaio/framework-workspace"}',
          '{"location":"packages/utils","name":"@makaio/utils"}',
        ].join('\n'),
      ),
    ).toEqual([{ location: 'packages/utils', name: '@makaio/utils' }]);
  });

  it('accepts a complete and exact package overview', () => {
    const result = checkPackageOverview({
      markdown: overview,
      workspaces: [
        { location: 'packages/utils', name: '@makaio/utils' },
        { location: 'core/contracts', name: '@makaio/contracts' },
      ],
    });

    expect(result).toEqual({ issues: [], ok: true });
  });

  it('reports missing, extra, mismatched, and duplicate package rows', () => {
    const result = checkPackageOverview({
      markdown: `
| Path | Package | Description |
|------|---------|-------------|
| \`packages/utils\` | \`@makaio/wrong-utils\` | Utility primitives. |
| \`packages/utils\` | \`@makaio/utils\` | Duplicate. |
| \`deleted/package\` | \`@makaio/deleted\` | Removed. |
`,
      workspaces: [
        { location: 'packages/utils', name: '@makaio/utils' },
        { location: 'core/contracts', name: '@makaio/contracts' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        kind: 'missing-package',
        message: 'Workspace "core/contracts" (@makaio/contracts) is missing from docs/package-overview.md',
      },
      {
        kind: 'package-name-mismatch',
        message:
          'docs/package-overview.md lists "packages/utils" as "@makaio/wrong-utils", but the workspace name is "@makaio/utils"',
      },
      {
        kind: 'extra-package',
        message:
          'docs/package-overview.md lists "deleted/package" (@makaio/deleted), but that location is not a Yarn workspace',
      },
      {
        kind: 'duplicate-package',
        message: 'docs/package-overview.md lists "packages/utils" 2 times',
      },
    ]);
  });
});
