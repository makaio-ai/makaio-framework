import { describe, expect, it } from 'vitest';
import { buildFrameworkPeerRange, createStagedPackageJson } from './npm-publish-staging.js';

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
  it('stamps a caret peer range for stable framework versions', () => {
    const staged = createStagedPackageJson({ name: '@makaio/storage-pg', version: '1.0.0' }, '1.0.0');
    expect(staged.peerDependencies?.['@makaio/framework']).toBe('^1.0.0');
  });

  it('stamps a prerelease-inclusive peer range for prerelease framework versions', () => {
    const staged = createStagedPackageJson(
      { name: '@makaio/storage-pg', version: '1.0.0-dev-1781260968078' },
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
