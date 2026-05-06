import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPortablePackageJson, createRepoDevAliases, type ExtensionPackageJson } from './package-mode.js';

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
      '@makaio/bus-core': path.join('/repo', 'framework/packages/bus-core/src'),
      '@makaio/contracts': path.join('/repo', 'framework/packages/contracts/src'),
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
        '@makaio/bus-core': '*',
      },
      devDependencies: {
        '@makaio/build-tooling': 'workspace:*',
        '@makaio/contracts': 'link:../../framework/packages/contracts',
        '@makaio/core': 'file:../../framework/packages/makaio-core',
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
      '@makaio/bus-core': '*',
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
