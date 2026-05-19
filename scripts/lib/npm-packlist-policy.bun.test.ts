import { describe, expect, it } from 'bun:test';
import {
  checkDescriptorEntrypointFiles,
  checkManifestExportTargets,
  checkPacklist,
  checkRuntimeWorkspaceDependencies,
} from './npm-packlist-policy.js';

describe('npm packlist policy', () => {
  it('accepts dist files plus package metadata', () => {
    const result = checkPacklist('@makaio/adapter-openai-node', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'descriptor.json',
    ]);
    expect(result.missingRequired).toEqual([]);
    expect(result.forbidden).toEqual([]);
  });

  it('rejects sourcemaps and source directories', () => {
    const result = checkPacklist('@makaio/adapter-openai-node', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.js.map',
      'src/index.ts',
    ]);
    expect(result.forbidden).toContain('dist/index.js.map');
    expect(result.forbidden).toContain('src/index.ts');
  });

  it('rejects tests, fixtures, build config, lockfiles, env files, and logs', () => {
    const result = checkPacklist('@makaio/test', [
      'package.json',
      'README.md',
      'LICENSE',
      '__tests__/foo.test.ts',
      'fixtures/data.json',
      'build.ts',
      'vite.config.ts',
      'tsconfig.json',
      'yarn.lock',
      '.env.local',
      'npm-debug.log',
    ]);
    expect(result.forbidden).toContain('__tests__/foo.test.ts');
    expect(result.forbidden).toContain('fixtures/data.json');
    expect(result.forbidden).toContain('build.ts');
    expect(result.forbidden).toContain('vite.config.ts');
    expect(result.forbidden).toContain('tsconfig.json');
    expect(result.forbidden).toContain('yarn.lock');
    expect(result.forbidden).toContain('.env.local');
    expect(result.forbidden).toContain('npm-debug.log');
  });

  it('reports missing README and LICENSE', () => {
    const result = checkPacklist('@makaio/test', ['package.json', 'dist/index.js']);
    expect(result.missingRequired).toContain('README.md');
    expect(result.missingRequired).toContain('LICENSE');
  });

  it('checks the packed manifest exports instead of publishConfig exports', () => {
    const issues = checkManifestExportTargets(
      {
        name: '@makaio/extension-test',
        exports: {
          '.': './src/index.ts',
          './package.json': './package.json',
        },
        publishConfig: {
          exports: {
            '.': './dist/index.mjs',
            './package.json': './package.json',
          },
        },
      },
      ['package.json', 'README.md', 'LICENSE', 'dist/index.mjs'],
    );

    expect(issues).toEqual(['@makaio/extension-test: manifest entrypoint missing from packlist: src/index.ts']);
  });

  it('checks packed manifest main and types targets', () => {
    const issues = checkManifestExportTargets(
      {
        name: '@makaio/extension-test',
        main: 'dist/index.mjs',
        types: 'dist/index.d.mts',
      },
      ['package.json', 'README.md', 'LICENSE', 'dist/index.mjs'],
    );

    expect(issues).toEqual(['@makaio/extension-test: manifest entrypoint missing from packlist: dist/index.d.mts']);
  });

  it('rejects workspace protocol runtime dependencies in packed manifests', () => {
    const issues = checkRuntimeWorkspaceDependencies({
      name: '@makaio/extension-test',
      dependencies: {
        '@makaio/kernel': 'workspace:*',
      },
      devDependencies: {
        '@makaio/build-tooling': 'workspace:*',
      },
    });

    expect(issues).toEqual([
      '@makaio/extension-test: runtime dependency uses workspace protocol: dependencies.@makaio/kernel',
    ]);
  });

  it('requires descriptor entrypoint stems to exist as dist files in the packlist', () => {
    const issues = checkDescriptorEntrypointFiles(
      '@makaio/extension-client-hooks',
      {
        entrypoints: {
          cli: 'cli/index',
        },
      },
      ['package.json', 'README.md', 'LICENSE', 'descriptor.json', 'dist/cli.mjs'],
    );

    expect(issues).toEqual([
      '@makaio/extension-client-hooks: descriptor entrypoint missing from packlist: dist/cli/index.mjs',
    ]);
  });
});
