import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNodeRuntimeOptions } from '../node-runtime-options.js';

let tmpDir: string | undefined;

async function writeDescriptor(root: string, name: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'descriptor.json'),
    JSON.stringify({
      name,
      displayName: name,
      version: '0.1.0',
      makaio: { minVersion: '0.1.0' },
      entrypoints: { server: true },
    }),
  );
}

describe('buildNodeRuntimeOptions', () => {
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('does not discover local node_modules descriptors from the process cwd', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-node-runtime-options-'));
    const cwd = path.join(tmpDir, 'workspace');
    const makaioHome = path.join(tmpDir, 'home', '.makaio');
    await writeDescriptor(path.join(cwd, 'node_modules', '@makaio', 'services'), 'makaio');
    await writeDescriptor(path.join(makaioHome, 'extensions', 'runtime-extension'), 'runtime-extension');

    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const options = await buildNodeRuntimeOptions({ makaioHome });
      const discovered = await options.discovery.discover();

      expect(options.launcherCommand).toBe('makaio');
      expect(discovered.map((extension) => extension.descriptor.name)).toEqual(['runtime-extension']);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('uses makaio.config discovery paths and runtime defaults', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-node-runtime-options-'));
    const configPath = path.join(tmpDir, 'makaio.config.json');
    const extensionRoot = path.join(tmpDir, 'workspace', 'extensions', 'workspace-extension');
    const makaioHome = path.join(tmpDir, 'home', '.makaio');
    await writeDescriptor(extensionRoot, 'workspace-extension');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        extensions: { discoveryPaths: ['workspace/extensions'] },
        launcherCommand: 'makaio-dev',
        packageConfigDefaults: {
          'account-manager': { makaioCommand: 'makaio-dev' },
        },
      }),
      'utf-8',
    );

    const previousCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const options = await buildNodeRuntimeOptions({ makaioHome, configPath });
      process.chdir(os.tmpdir());

      const discovered = await options.discovery.discover();

      expect(discovered.map((extension) => extension.descriptor.name)).toEqual(['workspace-extension']);
      expect(options.launcherCommand).toBe('makaio-dev');
      expect(options.packageConfigDefaults.get('account-manager')).toEqual({ makaioCommand: 'makaio-dev' });
      expect(options.hostCapabilities).toEqual(['node']);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
