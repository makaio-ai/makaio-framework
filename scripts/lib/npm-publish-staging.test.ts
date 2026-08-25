import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStorageEngine } from '@makaio/storage-drizzle';
import { storageEngine as postgresStorageEngine } from '@makaio/storage-pg';
import { readMigrations } from '@makaio/storage-migrations';
import { buildFrameworkPeerRange, createStagedPackageJson, stagePackageForNpmPublish } from './npm-publish-staging.js';

registerStorageEngine(postgresStorageEngine);

const tempDirs: string[] = [];

/**
 * Create a temporary package root tracked for cleanup.
 * @returns Absolute path to the temporary directory.
 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'makaio-publish-staging-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write a fixture file, creating parent directories first.
 * @param root - Fixture root.
 * @param relativePath - Root-relative file path.
 * @param content - File content.
 */
function writeFixture(root: string, relativePath: string, content = ''): void {
  const filePath = join(root, relativePath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildFrameworkPeerRange', () => {
  it('returns a caret range for stable versions', () => {
    expect(buildFrameworkPeerRange('1.0.0')).toBe('^1.0.0');
    expect(buildFrameworkPeerRange('2.3.4')).toBe('^2.3.4');
  });

  it('returns a prerelease-inclusive range for prerelease versions', () => {
    expect(buildFrameworkPeerRange('1.0.0-dev-1781260968078')).toBe('>=1.0.0-0 <2.0.0');
    expect(buildFrameworkPeerRange('2.0.0-alpha.1')).toBe('>=2.0.0-0 <3.0.0');
    expect(buildFrameworkPeerRange('1.2.3-rc.0')).toBe('>=1.0.0-0 <2.0.0');
  });

  it('advances the upper bound by one major for each distinct major', () => {
    expect(buildFrameworkPeerRange('3.0.0-dev-123')).toBe('>=3.0.0-0 <4.0.0');
  });

  it('throws for malformed version strings', () => {
    expect(() => buildFrameworkPeerRange('not-a-version')).toThrow(/unsupported version format/u);
    expect(() => buildFrameworkPeerRange('1.0')).toThrow(/unsupported version format/u);
  });
});

describe('createStagedPackageJson', () => {
  it('preserves the umbrella framework export map without retaining a self peer', () => {
    const sourceFrameworkManifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../packages/framework/package.json'), 'utf8'),
    ) as Parameters<typeof createStagedPackageJson>[0];
    const frameworkManifest = {
      ...sourceFrameworkManifest,
      peerDependencies: {
        ...sourceFrameworkManifest.peerDependencies,
        '@makaio/framework': 'workspace:*',
        '@makaio/ordinary-peer': '^1.0.0',
      },
    };

    const staged = createStagedPackageJson(frameworkManifest, '1.0.0-dev-1780000000000', {
      '@makaio/framework': '1.0.0-dev-1780000000000',
    });
    const exports = staged.exports as Record<string, unknown>;
    const sourceExports = frameworkManifest.exports as Record<string, unknown>;

    expect(staged.version).toBe('1.0.0-dev-1780000000000');
    expect(staged.engines).toEqual({ node: '>=22.15.0' });
    expect(exports['./bus']).toEqual(sourceExports['./bus']);
    expect(exports['./workflow-engine']).toEqual(sourceExports['./workflow-engine']);
    expect(exports['./contracts/native-session-supervisor']).toEqual(
      sourceExports['./contracts/native-session-supervisor'],
    );
    expect(exports['./runtime-node/code-execution/worker-entry']).toBeUndefined();
    expect(staged.peerDependencies?.['@makaio/framework']).toBeUndefined();
    expect(staged.peerDependencies?.['@makaio/ordinary-peer']).toBe('^1.0.0');
  });

  it('stamps a caret peer range for declared stable framework peers', () => {
    const staged = createStagedPackageJson(
      {
        name: '@makaio/storage-pg',
        version: '1.0.0',
        peerDependencies: { '@makaio/framework': 'workspace:*' },
      },
      '1.0.0',
    );
    expect(staged.peerDependencies?.['@makaio/framework']).toBe('^1.0.0');
  });

  it('stamps a prerelease-inclusive range for declared framework peers', () => {
    const staged = createStagedPackageJson(
      {
        name: '@makaio/storage-pg',
        version: '1.0.0-dev-1781260968078',
        peerDependencies: { '@makaio/framework': 'workspace:*' },
      },
      '1.0.0-dev-1781260968078',
    );
    expect(staged.peerDependencies?.['@makaio/framework']).toBe('>=1.0.0-0 <2.0.0');
  });

  it('omits devDependencies entirely from the staged manifest', () => {
    const staged = createStagedPackageJson(
      {
        name: '@makaio/storage-pg',
        version: '1.0.0',
        dependencies: { pg: '^8.21.0' },
        devDependencies: {
          '@makaio/build-tooling': 'workspace:*',
          '@makaio/storage-drizzle': 'workspace:*',
        },
      },
      '1.0.0',
    );
    expect(staged.devDependencies).toBeUndefined();
  });

  it('contains no workspace: protocol in any dependency field of the staged manifest', () => {
    const staged = createStagedPackageJson(
      {
        name: '@makaio/storage-pg',
        version: '1.0.0',
        dependencies: {
          '@makaio/bus-core': 'workspace:*',
          pg: '^8.21.0',
        },
        devDependencies: {
          '@makaio/build-tooling': 'workspace:*',
          '@makaio/storage-drizzle': 'workspace:*',
        },
      },
      '1.0.0',
    );

    const allVersions = [
      ...Object.values(staged.dependencies ?? {}),
      ...Object.values(staged.peerDependencies ?? {}),
      ...Object.values(staged.devDependencies ?? {}),
    ];
    const workspaceEntries = allVersions.filter((v) => v.startsWith('workspace:'));
    expect(workspaceEntries).toEqual([]);
  });

  it('retains explicitly published workspace dependencies at the release version', () => {
    const staged = createStagedPackageJson(
      {
        name: '@makaio/adapter-claude-code-cli',
        version: '1.0.0',
        dependencies: {
          '@makaio/ai-adapters-claude-shared': 'workspace:*',
          '@makaio/bus-core': 'workspace:*',
        },
        publishWorkspaceDependencies: ['@makaio/ai-adapters-claude-shared'],
      },
      '1.2.3',
      { '@makaio/ai-adapters-claude-shared': '4.5.6' },
    );

    expect(staged.dependencies).toEqual({ '@makaio/ai-adapters-claude-shared': '4.5.6' });
    expect(staged.publishWorkspaceDependencies).toBeUndefined();
  });

  it('refuses unsupported workspace protocols before staging a manifest', () => {
    expect(() =>
      createStagedPackageJson(
        {
          name: '@makaio/adapter-test',
          version: '1.0.0',
          optionalDependencies: { '@makaio/client-test': 'workspace:*' },
        },
        '1.0.0',
      ),
    ).toThrow(/Optional workspace dependency/u);
    expect(() =>
      createStagedPackageJson(
        {
          name: '@makaio/adapter-test',
          version: '1.0.0',
          peerDependencies: { '@makaio/client-test': 'workspace:*' },
        },
        '1.0.0',
      ),
    ).toThrow(/Peer workspace dependency/u);
  });

  it('removes the publishConfig.directory staging key from the output', () => {
    const staged = createStagedPackageJson(
      {
        name: '@makaio/storage-pg',
        version: '1.0.0',
        publishConfig: { access: 'public', directory: 'node_modules/.makaio-publish' },
      },
      '1.0.0',
    );
    expect((staged.publishConfig as Record<string, unknown> | undefined)?.['directory']).toBeUndefined();
    expect((staged.publishConfig as Record<string, unknown> | undefined)?.['access']).toBe('public');
  });
});

describe('stagePackageForNpmPublish', () => {
  it('stages migration chain directories as runtime-readable assets', () => {
    const packageDir = makeTempDir();
    writeFixture(
      packageDir,
      'package.json',
      JSON.stringify({
        name: '@makaio/storage-pg',
        version: '1.0.0',
        type: 'module',
        files: ['dist', 'drizzle-postgres', 'LICENSE', 'README.md'],
        publishConfig: { access: 'public', directory: 'node_modules/.makaio-publish' },
      }),
    );
    writeFixture(packageDir, 'LICENSE', 'MIT');
    writeFixture(packageDir, 'README.md', '# test');
    writeFixture(packageDir, 'dist/index.mjs', 'export {};');
    writeFixture(packageDir, 'drizzle-postgres/0000_init.sql', 'CREATE TABLE demo (id text);');
    writeFixture(
      packageDir,
      'drizzle-postgres/meta/_journal.json',
      JSON.stringify({
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1, tag: '0000_init', breakpoints: false }],
      }),
    );
    writeFixture(packageDir, 'drizzle-postgres/meta/0000_snapshot.json', '{"generator":"state"}');

    const publishDir = stagePackageForNpmPublish(packageDir, '1.0.0');

    expect(existsSync(join(publishDir, 'drizzle-postgres/0000_init.sql'))).toBe(true);
    expect(existsSync(join(publishDir, 'drizzle-postgres/meta/_journal.json'))).toBe(true);
    expect(existsSync(join(publishDir, 'drizzle-postgres/meta/0000_snapshot.json'))).toBe(false);
    expect(
      readMigrations({ migrationsDir: join(publishDir, 'drizzle-postgres'), expectedDialect: 'postgres' }),
    ).toEqual([
      expect.objectContaining({
        tag: '0000_init',
        sql: ['CREATE TABLE demo (id text);'],
      }),
    ]);
  });

  it('stages dist files without sourcemaps and points types at emitted declarations', () => {
    const packageDir = makeTempDir();
    writeFixture(
      packageDir,
      'package.json',
      JSON.stringify({
        name: '@makaio/client-test',
        version: '1.0.0',
        type: 'module',
        files: ['dist', 'LICENSE', 'README.md'],
        publishConfig: {
          access: 'public',
          exports: {
            '.': './dist/index.mjs',
            './server': './dist/server.mjs',
          },
        },
      }),
    );
    writeFixture(packageDir, 'LICENSE', 'MIT');
    writeFixture(packageDir, 'README.md', '# test');
    writeFixture(packageDir, 'dist/index.mjs', 'export {};');
    writeFixture(packageDir, 'dist/index.d.ts', 'export {};');
    writeFixture(packageDir, 'dist/index.d.ts.map', '{}');
    writeFixture(packageDir, 'dist/server.mjs', 'export {};');
    writeFixture(packageDir, 'dist/server.d.ts', 'export {};');

    const publishDir = stagePackageForNpmPublish(packageDir, '1.0.0');
    const manifest = JSON.parse(readFileSync(join(publishDir, 'package.json'), 'utf8')) as {
      readonly types?: string;
      readonly exports?: {
        readonly '.': { readonly types?: string };
        readonly './server': { readonly types?: string };
      };
    };

    expect(existsSync(join(publishDir, 'dist/index.d.ts'))).toBe(true);
    expect(existsSync(join(publishDir, 'dist/index.d.ts.map'))).toBe(false);
    expect(manifest.types).toBe('dist/index.d.ts');
    expect(manifest.exports?.['.'].types).toBe('./dist/index.d.ts');
    expect(manifest.exports?.['./server'].types).toBe('./dist/server.d.ts');
  });

  it('omits emitted test declarations without excluding runtime dist files', () => {
    const packageDir = makeTempDir();
    writeFixture(
      packageDir,
      'package.json',
      JSON.stringify({
        name: '@makaio/adapter-test',
        version: '1.0.0',
        type: 'module',
        files: ['dist', 'LICENSE', 'README.md'],
      }),
    );
    writeFixture(packageDir, 'LICENSE', 'MIT');
    writeFixture(packageDir, 'README.md', '# test');
    writeFixture(packageDir, 'dist/index.mjs', 'export {};');
    writeFixture(packageDir, 'dist/testing.d.ts', 'export {};');
    writeFixture(packageDir, 'dist/test/index.d.ts', 'export {};');
    writeFixture(packageDir, 'dist/__tests__/fixture.d.ts', 'export {};');
    writeFixture(packageDir, 'dist/helpers.spec.d.ts', 'export {};');

    const publishDir = stagePackageForNpmPublish(packageDir, '1.0.0');

    expect(existsSync(join(publishDir, 'dist/index.mjs'))).toBe(true);
    expect(existsSync(join(publishDir, 'dist/testing.d.ts'))).toBe(true);
    expect(existsSync(join(publishDir, 'dist/test'))).toBe(false);
    expect(existsSync(join(publishDir, 'dist/__tests__'))).toBe(false);
    expect(existsSync(join(publishDir, 'dist/helpers.spec.d.ts'))).toBe(false);
  });

  it('rejects publish directories outside the package root', () => {
    const packageDir = makeTempDir();
    writeFixture(
      packageDir,
      'package.json',
      JSON.stringify({
        name: '@makaio/test',
        version: '1.0.0',
        files: ['dist'],
        publishConfig: { directory: '../outside' },
      }),
    );
    writeFixture(packageDir, 'dist/index.mjs', 'export {};');

    expect(() => stagePackageForNpmPublish(packageDir, '1.0.0')).toThrow(/publish directory escapes package root/u);
  });

  it('rejects package file entries outside the package root', () => {
    const packageDir = makeTempDir();
    writeFixture(
      packageDir,
      'package.json',
      JSON.stringify({
        name: '@makaio/test',
        version: '1.0.0',
        files: ['../outside.txt'],
      }),
    );

    expect(() => stagePackageForNpmPublish(packageDir, '1.0.0')).toThrow(/publish file escapes package root/u);
  });
});
