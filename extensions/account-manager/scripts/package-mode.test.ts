import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPortablePackageJson, createRepoDevAliases, type ExtensionPackageJson } from './package-mode.js';

const FRAMEWORK_VERSIONS = {
  '@makaio/build-tooling': '0.1.0',
  '@makaio/bus-core': '0.1.0',
  '@makaio/contracts': '0.1.0',
  '@makaio/core': '0.1.0',
  '@makaio/runtime-node': '0.1.0',
  '@makaio/service-base': '0.1.0',
  '@makaio/test-utils': '0.1.0',
  '@makaio/ui-hooks': '0.1.0',
  '@makaio/ui-kernel': '0.1.0',
  '@makaio/ui-theme': '0.1.0',
  '@makaio/ui-views': '0.1.0',
} as const;

/** UI framework packages whose workspace specifiers are rewritten by createPortablePackageJson. */
const UI_PACKAGE_REFERENCES = [
  ['@makaio/ui-hooks', 'workspace:*'],
  ['@makaio/ui-kernel', 'workspace:*'],
  ['@makaio/ui-theme', 'workspace:^'],
  ['@makaio/ui-views', 'workspace:^'],
] as const satisfies ReadonlyArray<readonly [keyof typeof FRAMEWORK_VERSIONS, string]>;

describe('createRepoDevAliases', () => {
  it('resolves absolute local source aliases from the extension root', () => {
    const extensionRoot = '/repo/framework/extensions/account-manager';
    const aliases = createRepoDevAliases(extensionRoot);

    expect(aliases).toEqual({
      '@makaio/bus-core': path.join('/repo', 'framework/packages/bus-core/src'),
      '@makaio/contracts': path.join('/repo', 'framework/packages/contracts/src'),
      '@makaio/runtime-node': path.join('/repo', 'framework/runtimes/node/src'),
      '@makaio/service-base': path.join('/repo', 'framework/packages/services/base/src'),
    });
  });
});

describe('createPortablePackageJson', () => {
  it('rewrites local framework links into versioned portable dev dependencies', () => {
    const packageJson = {
      name: '@makaio/extension-account-manager',
      version: '0.1.0',
      type: 'module',
      scripts: {
        build: 'tsx ./scripts/run-with-mode.ts repo-dev tsdown --config-loader unrun',
        test: 'vitest run --config vitest.config.ts',
        'prepare:portable-package': 'tsx ./scripts/prepare-portable-package.ts',
      },
      peerDependencies: {
        '@makaio/bus-core': 'link:../../framework/packages/bus-core',
        ink: '^6.3.1',
      },
      devDependencies: {
        '@makaio/build-tooling': 'link:../../framework/build-tooling',
        '@makaio/contracts': 'link:../../framework/packages/contracts',
        '@makaio/runtime-node': '^0.9.0',
        '@makaio/service-base': 'file:../../framework/packages/services/base',
        ...Object.fromEntries(UI_PACKAGE_REFERENCES),
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
      ink: '^6.3.1',
    });
    const uiExpected = Object.fromEntries(
      UI_PACKAGE_REFERENCES.map(([name]) => [name, `^${FRAMEWORK_VERSIONS[name]}`]),
    );
    expect(portablePackageJson.devDependencies).toMatchObject({
      '@makaio/build-tooling': '^0.1.0',
      '@makaio/contracts': '^0.1.0',
      '@makaio/runtime-node': '^0.9.0',
      '@makaio/service-base': '^0.1.0',
      ...uiExpected,
      tsx: '^4.20.4',
    });
  });

  it('adds the bus-core peer dependency when the source manifest does not declare it', () => {
    const portablePackageJson = createPortablePackageJson(
      {
        name: '@makaio/extension-account-manager',
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
