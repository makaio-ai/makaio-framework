import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyDevManifestStamp,
  buildAnnotatedTag,
  buildDevVersion,
  buildPublishArgs,
  buildChangedFilesArgs,
  buildChangedSinceTagArgs,
  buildMergeBaseArgs,
  groupDevPublishFilesByPackage,
  buildRemoteTagCheckArgs,
  parsePackageNames,
  renderDevPublishInfo,
  renderSummary,
  resolveDevPublishPlan,
  selectLatestDevTag,
  stripPrerelease,
  type DevStampManifest,
} from './dev-publish.js';
import { discoverWorkspacePackagesAtRef } from './lib/dev-publish-info.js';

const REPOSITORY_URL = 'git+https://github.com/makaio-ai/makaio-framework.git';
const SKIPPED_DIRS = new Set(['.git', '.yarn', 'build', 'dist', 'lib', 'node_modules', 'release', '__tests__']);
const FRAMEWORK_ROOT = fileURLToPath(new URL('..', import.meta.url));

function findPackageJsonDirs(rootDir: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;

    const dir = join(rootDir, entry.name);
    if (existsSync(join(dir, 'package.json'))) {
      dirs.push(dir);
    }
    dirs.push(...findPackageJsonDirs(dir));
  }
  return dirs;
}

function toRepositoryDirectory(packageDir: string): string {
  return relative(FRAMEWORK_ROOT, packageDir).split(sep).join('/');
}

interface PackageJson {
  name?: string;
  private?: boolean;
  version?: string;
  dependencies?: Record<string, string>;
  repository?: {
    type?: string;
    url?: string;
    directory?: string;
  };
}

function readPackageJson(packageDir: string): PackageJson {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageJson;
}

describe('parsePackageNames', () => {
  it('accepts explicit Makaio package names and removes duplicates', () => {
    expect(parsePackageNames('@makaio/framework @makaio/contracts\n@makaio/framework')).toEqual([
      '@makaio/framework',
      '@makaio/contracts',
    ]);
  });

  it('rejects selector aliases for dev publishes', () => {
    expect(() => parsePackageNames('changed')).toThrow(/explicit package names/u);
  });
});

describe('dev snapshot versions', () => {
  it('builds a timestamped dev version from a stable source version', () => {
    expect(buildDevVersion('1.0.0', '1780000000000')).toBe('1.0.0-dev-1780000000000');
  });

  it('replaces an existing prerelease suffix before applying the dev timestamp', () => {
    expect(stripPrerelease('1.0.0-dev-1779051654000')).toBe('1.0.0');
  });
});

describe('applyDevManifestStamp', () => {
  it('stamps the snapshot version and widens the framework peer to a prerelease-inclusive range', () => {
    const manifest: DevStampManifest = {
      version: '0.1.0',
      peerDependencies: { '@makaio/framework': '^1.0.0', react: '^19.0.0' },
    };
    applyDevManifestStamp(manifest, '0.1.0-dev-1780000000000', '1.0.0-dev-1780000000000');
    expect(manifest.version).toBe('0.1.0-dev-1780000000000');
    expect(manifest.peerDependencies?.['@makaio/framework']).toBe('>=1.0.0-0 <2.0.0');
    expect(manifest.peerDependencies?.react).toBe('^19.0.0');
  });

  it('leaves manifests without a framework peer untouched apart from the version', () => {
    const manifest: DevStampManifest = { version: '1.0.0' };
    applyDevManifestStamp(manifest, '1.0.0-dev-1780000000000', '1.0.0-dev-1780000000000');
    expect(manifest.version).toBe('1.0.0-dev-1780000000000');
    expect(manifest.peerDependencies).toBeUndefined();
  });
});

describe('resolveDevPublishPlan', () => {
  it('selects only requested packages and applies one shared timestamp', () => {
    const plan = resolveDevPublishPlan(
      [
        {
          name: '@makaio/contracts',
          location: 'core/contracts',
          version: '1.0.0',
          dependencies: {},
        },
        {
          name: '@makaio/framework',
          location: 'packages/framework',
          version: '1.0.0',
          dependencies: {
            '@makaio/contracts': 'workspace:*',
          },
        },
      ],
      ['@makaio/framework', '@makaio/contracts'],
      '1780000000000',
    );

    expect(plan.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      '@makaio/contracts@1.0.0-dev-1780000000000',
      '@makaio/framework@1.0.0-dev-1780000000000',
    ]);
  });

  it('adds retained public workspace dependencies in dependency-first order', () => {
    const plan = resolveDevPublishPlan(
      [
        { name: '@makaio/framework', location: 'packages/framework', version: '1.0.0', dependencies: {} },
        { name: '@makaio/client-claude-code', location: 'clients/claude-code', version: '1.1.0', dependencies: {} },
        {
          name: '@makaio/ai-adapters-claude-shared',
          location: 'adapters/shared/claude-shared',
          version: '1.2.0',
          dependencies: { '@makaio/framework': '^1.0.0' },
          publishWorkspaceDependencies: ['@makaio/client-claude-code'],
        },
        {
          name: '@makaio/adapter-claude-code-cli',
          location: 'adapters/implementations/claude-code-cli',
          version: '1.3.0',
          dependencies: { '@makaio/framework': '^1.0.0' },
          publishWorkspaceDependencies: ['@makaio/ai-adapters-claude-shared', '@makaio/client-claude-code'],
        },
      ],
      ['@makaio/adapter-claude-code-cli'],
      '1780000000000',
    );

    expect(plan.map((pkg) => pkg.name)).toEqual([
      '@makaio/framework',
      '@makaio/client-claude-code',
      '@makaio/ai-adapters-claude-shared',
      '@makaio/adapter-claude-code-cli',
    ]);
  });
});

describe('buildAnnotatedTag', () => {
  it('builds package-scoped dev tags with audit metadata', () => {
    expect(
      buildAnnotatedTag({
        packageName: '@makaio/framework',
        version: '1.0.0-dev-1780000000000',
        sourceSha: 'abc123',
        workflowUrl: 'https://github.com/makaio-ai/makaio-framework/actions/runs/1',
      }),
    ).toEqual({
      name: 'dev/@makaio/framework/v1.0.0-dev-1780000000000',
      message: [
        '@makaio/framework@1.0.0-dev-1780000000000',
        '',
        'npm dist-tag: dev',
        'source: abc123',
        'workflow: https://github.com/makaio-ai/makaio-framework/actions/runs/1',
      ].join('\n'),
    });
  });
});

describe('selectLatestDevTag', () => {
  it('selects the newest package-scoped dev tag by timestamp', () => {
    expect(
      selectLatestDevTag('@makaio/contracts', [
        'dev/@makaio/framework/v1.0.0-dev-1780000000200',
        'dev/@makaio/contracts/v1.0.0-dev-1780000000100',
        'dev/@makaio/contracts/v1.0.0-dev-1780000000300',
      ]),
    ).toBe('dev/@makaio/contracts/v1.0.0-dev-1780000000300');
  });
});

describe('dev publish info file mapping', () => {
  // At-ref discovery materializes the real workspace and can contend with distribution builds in the full suite.
  it('retains public workspace dependency metadata during at-ref discovery', { timeout: 60_000 }, () => {
    const packages = discoverWorkspacePackagesAtRef('HEAD');
    const claudeCli = packages.find((pkg) => pkg.name === '@makaio/adapter-claude-code-cli');

    expect(claudeCli?.publishWorkspaceDependencies).toEqual(['@makaio/client-claude-code']);
  });

  it('groups publish-relevant files by package and ignores tests', () => {
    const grouped = groupDevPublishFilesByPackage(
      [
        'core/contracts/src/index.ts',
        'core/contracts/src/provider/definition.test.ts',
        'services/core/src/settings/storage/providers-namespace.ts',
        '.changeset/provider-capabilities-json-safe.md',
        'sdks/manifest/makaio-bus-protocol.json',
        'adapters/implementations/openai-node/__tests__/connector-session.test.ts',
      ],
      [
        {
          name: '@makaio/contracts',
          location: 'core/contracts',
          version: '1.0.0',
          dependencies: {},
        },
        {
          name: '@makaio/framework',
          location: 'packages/framework',
          version: '1.0.0',
          dependencies: {},
        },
      ],
    );

    expect([...grouped.entries()]).toEqual([
      ['@makaio/contracts', ['core/contracts/src/index.ts']],
      [
        '@makaio/framework',
        ['core/contracts/src/index.ts', 'services/core/src/settings/storage/providers-namespace.ts'],
      ],
    ]);
  });

  it('maps direct publishable packages without mapping test-only changes', () => {
    const grouped = groupDevPublishFilesByPackage(
      [
        'adapters/implementations/openai-node/src/connector.ts',
        'adapters/implementations/openai-node/__tests__/connector-session.test.ts',
      ],
      [
        {
          name: '@makaio/adapter-openai-node',
          location: 'adapters/implementations/openai-node',
          version: '1.0.0',
          dependencies: {},
        },
        {
          name: '@makaio/framework',
          location: 'packages/framework',
          version: '1.0.0',
          dependencies: {},
        },
      ],
    );

    expect([...grouped.entries()]).toEqual([
      ['@makaio/adapter-openai-node', ['adapters/implementations/openai-node/src/connector.ts']],
    ]);
  });

  it('maps framework umbrella build inputs to the framework package', () => {
    const grouped = groupDevPublishFilesByPackage(
      [
        'build-tooling/framework-import-map.ts',
        'build-tooling/framework-public-surface.ts',
        'build-tooling/package-exports.ts',
        'build-tooling/tsdown-framework-preset.ts',
        'build-tooling/tsdown-scss.ts',
        'scripts/lib/framework-dist-declarations.ts',
        'scripts/lib/framework-dist-verifier.ts',
        'scripts/lib/runtime-migration-assets.ts',
        'scripts/lib/unrelated-tool.ts',
        'tsconfig.build.base.json',
        'tsconfig.build.json',
        'tsconfig.json',
        'packages/file-watcher/src/index.ts',
        'ui/theme/tokens/_colors.scss',
        'storage/migrations/drizzle/0000_bootstrap.sql',
        'storage/migrations/drizzle/meta/0000_snapshot.json',
        'storage/migrations/drizzle/meta/_journal.json',
      ],
      [
        {
          name: '@makaio/framework',
          location: 'packages/framework',
          version: '1.0.0',
          dependencies: {},
        },
      ],
      {
        frameworkBuildPackageRoots: [
          { name: '@makaio/build-tooling', location: 'build-tooling' },
          { name: '@makaio/file-watcher', location: 'packages/file-watcher' },
          { name: '@makaio/ui-theme', location: 'ui/theme' },
        ],
      },
    );

    expect([...grouped.entries()]).toEqual([
      [
        '@makaio/framework',
        [
          'build-tooling/framework-import-map.ts',
          'build-tooling/framework-public-surface.ts',
          'build-tooling/package-exports.ts',
          'build-tooling/tsdown-framework-preset.ts',
          'build-tooling/tsdown-scss.ts',
          'scripts/lib/framework-dist-declarations.ts',
          'scripts/lib/framework-dist-verifier.ts',
          'scripts/lib/runtime-migration-assets.ts',
          'tsconfig.build.base.json',
          'tsconfig.build.json',
          'tsconfig.json',
          'packages/file-watcher/src/index.ts',
          'ui/theme/tokens/_colors.scss',
          'storage/migrations/drizzle/0000_bootstrap.sql',
          'storage/migrations/drizzle/meta/_journal.json',
        ],
      ],
    ]);
  });
});

describe('dev publish info git args', () => {
  it('builds the changed-file range command', () => {
    expect(buildChangedFilesArgs('base', 'head')).toEqual(['diff', '--name-only', '--no-renames', 'base..head']);
  });

  it('builds the merge-base command', () => {
    expect(buildMergeBaseArgs('base', 'head')).toEqual(['merge-base', 'base', 'head']);
  });

  it('builds the package-scoped tag comparison command', () => {
    expect(buildChangedSinceTagArgs('tag-sha', 'head-sha', ['core/contracts/src/index.ts'])).toEqual([
      'diff',
      '--quiet',
      'tag-sha..head-sha',
      '--',
      'core/contracts/src/index.ts',
    ]);
  });
});

describe('buildRemoteTagCheckArgs', () => {
  it('checks origin for the exact annotated tag before pushing', () => {
    expect(buildRemoteTagCheckArgs('dev/@makaio/contracts/v1.0.0-dev-1780000000000')).toEqual([
      'ls-remote',
      '--tags',
      'origin',
      'dev/@makaio/contracts/v1.0.0-dev-1780000000000',
    ]);
  });
});

describe('buildPublishArgs', () => {
  it('publishes dev packages with provenance', () => {
    expect(buildPublishArgs('/tmp/contracts-publish')).toEqual([
      'publish',
      '/tmp/contracts-publish',
      '--tag',
      'dev',
      '--access',
      'public',
      '--provenance',
    ]);
  });
});

describe('publishable package metadata', () => {
  it('declares repository metadata required by npm provenance', () => {
    const failures: string[] = [];
    for (const packageDir of findPackageJsonDirs(FRAMEWORK_ROOT)) {
      const packageJson = readPackageJson(packageDir);

      if (packageJson.private || !packageJson.name?.startsWith('@makaio/') || !packageJson.version) {
        continue;
      }

      const directory = toRepositoryDirectory(packageDir);
      if (
        packageJson.repository?.type !== 'git' ||
        packageJson.repository.url !== REPOSITORY_URL ||
        packageJson.repository.directory !== directory
      ) {
        failures.push(`${packageJson.name}: expected git repository metadata for ${directory}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

describe('framework workspace package metadata', () => {
  it('keeps build tooling out of production dependencies', () => {
    const failures: string[] = [];
    for (const packageDir of findPackageJsonDirs(FRAMEWORK_ROOT)) {
      const packageJson = readPackageJson(packageDir);
      if (packageJson.dependencies?.['@makaio/build-tooling'] !== undefined) {
        failures.push(packageJson.name ?? toRepositoryDirectory(packageDir));
      }
    }

    expect(failures).toEqual([]);
  });
});

describe('renderSummary', () => {
  it('labels dry runs without claiming packages were published', () => {
    expect(
      renderSummary(
        [
          {
            name: '@makaio/framework',
            location: 'packages/framework',
            version: '1.0.0-dev-1780000000000',
            baseVersion: '1.0.0',
            tagName: 'dev/@makaio/framework/v1.0.0-dev-1780000000000',
            dependencies: {},
          },
        ],
        'abc123',
        'https://github.com/makaio-ai/makaio-framework/actions/runs/1',
        true,
      ),
    ).toContain('### Dev package dry run');
  });
});

describe('renderDevPublishInfo', () => {
  it('renders a suggested publish command and latest tag context', () => {
    expect(
      renderDevPublishInfo({
        baseSha: 'base',
        headSha: 'head',
        prChangedFiles: ['core/contracts/src/index.ts'],
        candidates: [
          {
            name: '@makaio/contracts',
            location: 'core/contracts',
            prChangedFiles: ['core/contracts/src/index.ts'],
            pendingFiles: ['core/contracts/src/index.ts'],
            latestTag: 'dev/@makaio/contracts/v1.0.0-dev-1780000000000',
            latestTagCommit: 'abcdef1234567890',
            reason: 'pr',
          },
        ],
      }),
    ).toContain('Suggested command: `/publish-dev @makaio/contracts`');
  });

  it('renders a no-candidates report without an empty details block', () => {
    const summary = renderDevPublishInfo({
      baseSha: 'base',
      headSha: 'head',
      prChangedFiles: [],
      candidates: [],
    });

    expect(summary).toContain('No pending dev-publishable package changes were found.');
    expect(summary).not.toContain('<details>');
  });
});
