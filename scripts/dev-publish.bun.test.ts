import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import {
  buildAnnotatedTag,
  buildDevVersion,
  buildPublishArgs,
  buildRemoteTagCheckArgs,
  parsePackageNames,
  renderSummary,
  resolveDevPublishPlan,
  stripPrerelease,
} from './dev-publish.js';

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

describe('resolveDevPublishPlan', () => {
  it('selects only requested packages and applies one shared timestamp', () => {
    const plan = resolveDevPublishPlan(
      [
        {
          name: '@makaio/contracts',
          location: 'packages/contracts',
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
    expect(buildPublishArgs('@makaio/contracts')).toEqual([
      'workspace',
      '@makaio/contracts',
      'npm',
      'publish',
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
