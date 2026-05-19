/// <reference types="bun-types" />
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  buildDevHostRuntimeOptions,
  buildDevHostRuntimeOptionsCore,
  HOST_WORKSPACE_ROOT_ENV,
  normalizeNodeHostCapabilities,
  resolveDevHostOptions,
} from '../src/dev-host-options.js';

describe('resolveDevHostOptions', () => {
  /** A stable absolute path used as the workspace root in tests. */
  const WORKSPACE_ROOT = '/workspace/test-root';

  it('returns undefined when the env var is unset', () => {
    expect(resolveDevHostOptions({})).toBeUndefined();
  });

  it('returns undefined when the env var is an empty string', () => {
    expect(resolveDevHostOptions({ [HOST_WORKSPACE_ROOT_ENV]: '' })).toBeUndefined();
  });

  it('returns shared dev-host options for a valid absolute path', () => {
    expect(
      resolveDevHostOptions({
        [HOST_WORKSPACE_ROOT_ENV]: WORKSPACE_ROOT,
      }),
    ).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
    });
  });

  it('throws when the workspace root value is relative without a base directory', () => {
    expect(() =>
      resolveDevHostOptions({
        [HOST_WORKSPACE_ROOT_ENV]: './foo',
      }),
    ).toThrow('MAKAIO_HOST_WORKSPACE_ROOT must be an absolute path, got: ./foo');
  });
});

describe('buildDevHostRuntimeOptionsCore', () => {
  it('throws when the workspace root is relative', () => {
    expect(() =>
      buildDevHostRuntimeOptionsCore({ workspaceRoot: 'relative-root' }, '/tmp/.makaio', () => ({
        discover: mock(),
      })),
    ).toThrow('MAKAIO_HOST_WORKSPACE_ROOT must be an absolute path, got: relative-root');
  });

  it('forwards discovery without runtime host capability tokens', () => {
    const discovery = { discover: mock() };

    expect(
      buildDevHostRuntimeOptionsCore(
        {
          workspaceRoot: '/workspace/test-root',
        },
        '/tmp/.makaio',
        ({ workspaceRoot, makaioHome }) => {
          expect(workspaceRoot).toBe('/workspace/test-root');
          expect(makaioHome).toBe('/tmp/.makaio');
          return discovery;
        },
      ),
    ).toEqual({
      discovery,
    });
  });
});

describe('buildDevHostRuntimeOptions', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when no extension descriptors are discovered', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'makaio-host-dev-'));
    tempDirs.push(dir);

    const options = buildDevHostRuntimeOptions({ workspaceRoot: dir }, path.join(dir, '.makaio'));
    await expect(options.discovery!.discover()).rejects.toThrow(
      `MAKAIO_HOST_WORKSPACE_ROOT points to '${dir}' but no extension descriptors were discovered.`,
    );
  });

  it('discovers workspace node_modules descriptors', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'makaio-host-dev-'));
    tempDirs.push(dir);

    const extensionDir = path.join(dir, 'node_modules', 'test-extension');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      path.join(extensionDir, 'descriptor.json'),
      JSON.stringify({
        name: 'test-extension',
        displayName: 'Test Extension',
        version: '0.1.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { server: true },
      }),
      'utf-8',
    );

    const options = buildDevHostRuntimeOptions({ workspaceRoot: dir }, path.join(dir, '.makaio'));
    const discovered = await options.discovery!.discover();

    expect(options).not.toHaveProperty('hostCapabilities');
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      descriptor: { name: 'test-extension' },
      extensionPath: extensionDir,
      source: 'local',
    });
  });
});

describe('normalizeNodeHostCapabilities', () => {
  it('adds the node capability exactly once', () => {
    expect(normalizeNodeHostCapabilities(['native-pty'])).toEqual(['node', 'native-pty']);
    expect(normalizeNodeHostCapabilities(['node', 'native-pty'])).toEqual(['node', 'native-pty']);
  });
});
