import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { makeTestRepo, writeTestManifest } from './__tests__/manifest-test-helpers.js';
import {
  syncExistingProjectManifestPinsAfterUpdate,
  syncProjectManifestAfterInstall,
  syncProjectManifestAfterUninstall,
} from './project-manifest-sync.js';

describe('project manifest sync', () => {
  it('adds exact direct npm specs and preserves host namespaces', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');
    const manifestPath = await writeTestManifest(repo, {
      $schema: 'makaio/project-manifest/v1',
      extensions: ['@makaio/extension-old@0.1.0'],
      hosts: { 'example-host': { bootstrap: { import: { enabled: true } } } },
    });

    await syncProjectManifestAfterInstall(repo, [
      {
        packageName: '@makaio/extension-workflow',
        version: '0.1.4',
        spec: '@makaio/extension-workflow@0.1.4',
      },
    ]);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8'))).toEqual({
      $schema: 'makaio/project-manifest/v1',
      extensions: ['@makaio/extension-old@0.1.0', '@makaio/extension-workflow@0.1.4'],
      hosts: { 'example-host': { bootstrap: { import: { enabled: true } } } },
    });
  });

  it('uses resolved exact versions instead of caller specs on install sync', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');
    const manifestPath = await writeTestManifest(repo, { extensions: [] });

    await syncProjectManifestAfterInstall(repo, [
      {
        packageName: '@makaio/extension-workflow',
        version: '0.1.4',
        spec: '@makaio/extension-workflow',
      },
    ]);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-workflow@0.1.4']);
  });

  it('replaces an existing package pin by package name', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');
    const manifestPath = await writeTestManifest(repo, {
      extensions: ['@makaio/extension-workflow@0.1.3'],
    });

    await syncProjectManifestAfterInstall(repo, [
      {
        packageName: '@makaio/extension-workflow',
        version: '0.1.4',
        spec: '@makaio/extension-workflow@0.1.4',
      },
    ]);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-workflow@0.1.4']);
  });

  it('removes a package pin by package name', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');
    const manifestPath = await writeTestManifest(repo, {
      extensions: ['@makaio/extension-workflow@0.1.4', '@makaio/extension-prompt@0.1.0'],
    });

    await syncProjectManifestAfterUninstall(repo, '@makaio/extension-workflow');

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-prompt@0.1.0']);
  });

  it('updates only existing manifest pins after extension update', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');
    const manifestPath = await writeTestManifest(repo, {
      extensions: ['@makaio/extension-workflow@0.1.4'],
    });

    await syncExistingProjectManifestPinsAfterUpdate(repo, [
      {
        packageName: '@makaio/extension-workflow',
        version: '0.1.5',
        spec: '@makaio/extension-workflow@0.1.5',
      },
      {
        packageName: '@makaio/extension-local-only',
        version: '9.9.9',
        spec: '@makaio/extension-local-only@9.9.9',
      },
    ]);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-workflow@0.1.5']);
  });

  it('reaps stale manifest lock files left by crashed sync processes', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');
    const manifestPath = await writeTestManifest(repo, { extensions: [] });
    await writeFile(
      `${manifestPath}.lock`,
      JSON.stringify({
        pid: 999_999_999,
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );

    await syncProjectManifestAfterInstall(repo, [
      {
        packageName: '@makaio/extension-workflow',
        version: '0.1.4',
        spec: '@makaio/extension-workflow@0.1.4',
      },
    ]);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-workflow@0.1.4']);
  });

  it('reaps old manifest lock files even when the stored pid is now alive', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');
    const manifestPath = await writeTestManifest(repo, { extensions: [] });
    await writeFile(
      `${manifestPath}.lock`,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );

    await syncProjectManifestAfterInstall(repo, [
      {
        packageName: '@makaio/extension-workflow',
        version: '0.1.4',
        spec: '@makaio/extension-workflow@0.1.4',
      },
    ]);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-workflow@0.1.4']);
  });

  it('does nothing on uninstall when no project manifest exists', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');

    await expect(syncProjectManifestAfterUninstall(repo, '@makaio/extension-workflow')).resolves.toBeUndefined();
  });

  it('does nothing when no project manifest exists', async () => {
    const repo = await makeTestRepo('makaio-manifest-sync-');

    await expect(
      syncProjectManifestAfterInstall(repo, [
        {
          packageName: '@makaio/extension-workflow',
          version: '0.1.4',
          spec: '@makaio/extension-workflow@0.1.4',
        },
      ]),
    ).resolves.toBeUndefined();
  });
});
