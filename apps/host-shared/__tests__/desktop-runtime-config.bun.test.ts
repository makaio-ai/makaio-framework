import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { MAKAIO_CONFIG_FILE_ENV, parseMakaioConfig } from '@makaio/runtime-node';
import {
  applyDesktopRuntimeConfig,
  applySelectedDesktopRuntimeConfig,
  resolveDesktopLauncherCommand,
} from '../src/desktop-runtime-config.js';

describe('desktop-runtime-config', () => {
  it('leaves runtime options unchanged when no runtime config file was selected', () => {
    const runtimeOptions = { launcherCommand: 'runtime-makaio', hostCapabilities: ['node'] };

    expect(applyDesktopRuntimeConfig(runtimeOptions, undefined)).toBe(runtimeOptions);
  });

  it('overlays config-owned discovery and runtime defaults while preserving host metadata', async () => {
    const config = parseMakaioConfig(
      {
        extensions: { discoveryPaths: ['extensions'], include: ['account-manager'] },
        launcherCommand: 'config-makaio',
        packageConfigDefaults: { 'account-manager': { makaioCommand: 'config-makaio' } },
      },
      { baseDir: '/workspace', makaioHome: '/home/user/.makaio' },
    );
    const runtimeOptions = {
      launcherCommand: 'runtime-makaio',
      hostCapabilities: ['node'],
      frameworkVersion: '0.1.0',
      packageConfigDefaults: new Map([['account-manager', { makaioCommand: 'runtime-makaio' }]]),
    };

    const result = applyDesktopRuntimeConfig(runtimeOptions, config);

    expect(result).toMatchObject({
      launcherCommand: 'config-makaio',
      hostCapabilities: ['node'],
      frameworkVersion: '0.1.0',
    });
    expect(result.packageConfigDefaults?.get('account-manager')).toEqual({ makaioCommand: 'config-makaio' });
    await expect(result.discovery?.discover()).resolves.toEqual([]);
  });

  it('loads MAKAIO_CONFIG_FILE as the desktop runtime config seam', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-runtime-config-test-'));
    try {
      const configPath = path.join(tmpDir, 'makaio.config.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({
          launcherCommand: 'env-makaio',
          packageConfigDefaults: { 'account-manager': { makaioCommand: 'env-makaio' } },
        }),
        'utf-8',
      );

      const result = await applySelectedDesktopRuntimeConfig(
        { launcherCommand: 'runtime-makaio', hostCapabilities: ['node'] },
        {
          makaioHome: path.join(tmpDir, '.makaio'),
          env: { [MAKAIO_CONFIG_FILE_ENV]: configPath },
        },
      );

      expect(result.launcherCommand).toBe('env-makaio');
      expect(result.hostCapabilities).toEqual(['node']);
      expect(result.packageConfigDefaults?.get('account-manager')).toEqual({ makaioCommand: 'env-makaio' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads extension descriptors through selected runtime config discovery', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-runtime-config-discovery-test-'));
    try {
      const extensionDir = path.join(tmpDir, 'extensions', 'local-extension');
      await fs.mkdir(extensionDir, { recursive: true });
      await fs.writeFile(
        path.join(extensionDir, 'descriptor.json'),
        JSON.stringify({
          name: 'local-extension',
          displayName: 'Local Extension',
          version: '0.1.0',
          makaio: { framework: '>=0.1.0' },
          entrypoints: { server: true },
        }),
        'utf-8',
      );
      const configPath = path.join(tmpDir, 'makaio.config.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({ extensions: { discoveryPaths: [path.join(tmpDir, 'extensions')] } }),
        'utf-8',
      );

      const result = await applySelectedDesktopRuntimeConfig(
        { launcherCommand: 'runtime-makaio', hostCapabilities: ['node'] },
        {
          makaioHome: path.join(tmpDir, '.makaio'),
          env: { [MAKAIO_CONFIG_FILE_ENV]: configPath },
        },
      );

      await expect(result.discovery?.discover()).resolves.toEqual([
        expect.objectContaining({
          descriptor: expect.objectContaining({ name: 'local-extension' }),
          source: 'local',
        }),
      ]);
      expect(result.hostCapabilities).toEqual(['node']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves launcher command from runtime options', () => {
    expect(resolveDesktopLauncherCommand({ launcherCommand: 'runtime-makaio' })).toBe('runtime-makaio');
  });
});
