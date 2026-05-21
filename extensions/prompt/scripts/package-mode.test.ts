import * as path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createPortablePackageJson,
  createRepoDevAliases,
  readFrameworkPackageVersions,
  type ExtensionPackageJson,
} from './package-mode.js';

const FRAMEWORK_VERSIONS = {
  '@makaio/build-tooling': '0.1.0',
  '@makaio/bus-core': '0.1.0',
  '@makaio/contracts': '0.1.0',
  '@makaio/core': '0.1.0',
  '@makaio/kernel': '0.1.0',
  '@makaio/test-utils': '0.1.0',
} as const;

describe('createRepoDevAliases', () => {
  it('resolves absolute local source aliases from the extension root', () => {
    const extensionRoot = '/repo/framework/extensions/prompt';
    const aliases = createRepoDevAliases(extensionRoot);

    expect(aliases).toEqual({
      '@makaio/bus-core': path.join('/repo', 'framework/core/bus-core/src'),
      '@makaio/contracts': path.join('/repo', 'framework/core/contracts/src'),
      '@makaio/kernel': path.join('/repo', 'framework/packages/kernel/src'),
      '@makaio/kernel/cli': path.join('/repo', 'framework/packages/kernel/src/cli/index.ts'),
    });
  });
});

describe('createPortablePackageJson', () => {
  it('rewrites local framework links into versioned portable dev dependencies', () => {
    const packageJson = {
      name: '@makaio/extension-prompt',
      version: '0.1.0',
      type: 'module',
      scripts: {
        build: 'tsx ./scripts/run-with-mode.ts repo-dev tsdown --config-loader unrun',
        test: 'tsx ./scripts/run-with-mode.ts repo-dev vitest run --config vitest.config.ts',
      },
      peerDependencies: {
        '@makaio/bus-core': 'workspace:*',
      },
      devDependencies: {
        '@makaio/build-tooling': 'workspace:*',
        '@makaio/contracts': 'link:../../framework/core/contracts',
        '@makaio/core': 'file:../../framework/core/makaio-core',
        '@makaio/kernel': 'workspace:^',
        '@makaio/test-utils': '^0.9.0',
        tsx: '^4.20.4',
      },
    } satisfies ExtensionPackageJson;

    const portablePackageJson = createPortablePackageJson(packageJson, FRAMEWORK_VERSIONS);

    expect(portablePackageJson.scripts).toEqual({
      build: 'tsdown',
      test: 'vitest run --config vitest.config.ts',
      verify: 'vitest run test/verify.test.ts --config vitest.config.ts',
    });
    expect(portablePackageJson.peerDependencies).toEqual({
      '@makaio/bus-core': '^0.1.0',
    });
    expect(portablePackageJson.devDependencies).toMatchObject({
      '@makaio/build-tooling': '^0.1.0',
      '@makaio/contracts': '^0.1.0',
      '@makaio/core': '^0.1.0',
      '@makaio/kernel': '^0.1.0',
      '@makaio/test-utils': '^0.9.0',
      tsx: '^4.20.4',
    });
  });

  it('adds the bus-core peer dependency when the source manifest does not declare it', () => {
    const portablePackageJson = createPortablePackageJson(
      {
        name: '@makaio/extension-prompt',
        version: '0.1.0',
        type: 'module',
      },
      FRAMEWORK_VERSIONS,
    );

    expect(portablePackageJson.peerDependencies).toEqual({
      '@makaio/bus-core': '^0.1.0',
    });
  });
});

describe('readFrameworkPackageVersions', () => {
  it('reads framework package versions from package manifests', async () => {
    const repoRoot = await createPackageFixture(FRAMEWORK_VERSIONS);

    try {
      await expect(readFrameworkPackageVersions(repoRoot)).resolves.toEqual(FRAMEWORK_VERSIONS);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('throws when a configured package manifest has no version', async () => {
    const repoRoot = await createPackageFixture({
      ...FRAMEWORK_VERSIONS,
      '@makaio/kernel': undefined,
    });

    try {
      await expect(readFrameworkPackageVersions(repoRoot)).rejects.toThrow('Missing package version');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('throws when a configured package manifest has the wrong name', async () => {
    const repoRoot = await createPackageFixture(FRAMEWORK_VERSIONS);

    try {
      await writeFile(
        path.join(repoRoot, 'packages/kernel/package.json'),
        JSON.stringify({ name: '@makaio/not-kernel', version: FRAMEWORK_VERSIONS['@makaio/kernel'] }),
        'utf8',
      );
      await expect(readFrameworkPackageVersions(repoRoot)).rejects.toThrow('Expected package @makaio/kernel');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Create package.json files for the prompt extension package-mode map.
 * @param versions - Package versions keyed by framework package name.
 * @returns Temporary repository root.
 */
async function createPackageFixture(
  versions: Partial<Record<keyof typeof FRAMEWORK_VERSIONS, string | undefined>>,
): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'makaio-prompt-package-mode-'));
  const packagePaths = {
    '@makaio/build-tooling': 'build-tooling',
    '@makaio/bus-core': 'core/bus-core',
    '@makaio/contracts': 'core/contracts',
    '@makaio/core': 'core/makaio-core',
    '@makaio/kernel': 'packages/kernel',
    '@makaio/test-utils': 'packages/test-utils',
  } as const;

  try {
    await Promise.all(
      Object.entries(packagePaths).map(async ([packageName, packagePath]) => {
        const directory = path.join(repoRoot, packagePath);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, 'package.json'),
          JSON.stringify({ name: packageName, version: versions[packageName as keyof typeof FRAMEWORK_VERSIONS] }),
          'utf8',
        );
      }),
    );
  } catch (error) {
    await rm(repoRoot, { recursive: true, force: true });
    throw error;
  }

  return repoRoot;
}
