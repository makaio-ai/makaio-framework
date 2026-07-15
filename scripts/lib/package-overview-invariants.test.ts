import { describe, expect, it } from 'vitest';
import {
  checkPackageOverview,
  filterDeclaredWorkspaces,
  parsePackageOverviewEntries,
  parseYarnWorkspacesList,
  scopeWorkspacesToRoot,
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

  it('ignores an unnamed Yarn project root', () => {
    expect(
      parseYarnWorkspacesList(
        ['{"location":".","name":null}', '{"location":"packages/utils","name":"@makaio/utils"}'].join('\n'),
      ),
    ).toEqual([{ location: 'packages/utils', name: '@makaio/utils' }]);
  });

  it('scopes an enclosing Yarn inventory to the logical package root', () => {
    expect(
      scopeWorkspacesToRoot(
        [
          { location: 'framework/packages/utils', name: '@makaio/utils' },
          { location: 'framework/core/contracts', name: '@makaio/contracts' },
          { location: 'host/services', name: '@host/services' },
        ],
        'framework',
      ),
    ).toEqual([
      { location: 'packages/utils', name: '@makaio/utils' },
      { location: 'core/contracts', name: '@makaio/contracts' },
    ]);
  });

  it('preserves an inventory already rooted at the logical package root', () => {
    const workspaces = [{ location: 'packages/utils', name: '@makaio/utils' }];
    expect(scopeWorkspacesToRoot(workspaces, '.')).toEqual(workspaces);
  });

  it('keeps only workspaces declared by the logical root manifest', () => {
    expect(
      filterDeclaredWorkspaces(
        [
          { location: 'packages/utils', name: '@makaio/utils' },
          { location: 'packages/framework/dist', name: '@makaio/generated-dist' },
          { location: 'scripts/tooling', name: '@makaio/internal-tooling' },
        ],
        ['packages/**/*', '!packages/framework/dist', '!packages/framework/dist/**'],
      ),
    ).toEqual([{ location: 'packages/utils', name: '@makaio/utils' }]);
  });

  it('ignores unnamed inventory entries outside the logical root manifest', () => {
    expect(
      filterDeclaredWorkspaces(
        [
          { location: 'scripts', name: null },
          { location: 'packages/utils', name: '@makaio/utils' },
        ],
        ['packages/**/*'],
      ),
    ).toEqual([{ location: 'packages/utils', name: '@makaio/utils' }]);
  });

  it('fails closed when a declared workspace has no package name', () => {
    expect(() => filterDeclaredWorkspaces([{ location: 'packages/unnamed', name: null }], ['packages/**/*'])).toThrow(
      'Declared Yarn workspace "packages/unnamed" has no package name',
    );
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
