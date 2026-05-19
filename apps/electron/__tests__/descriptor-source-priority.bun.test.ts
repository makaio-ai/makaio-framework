import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { buildDevHostRuntimeOptions } from '../src/main/dev-host-options.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('dev-host descriptor discovery source priority', () => {
  it('prefers the workspace descriptor source over a lower-priority node_modules alias', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-electron-descriptor-priority-'));
    tempDirs.push(root);

    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['host/**/*'] }),
      'utf-8',
    );

    const productDir = path.join(root, 'host', 'extensions', 'makaio-dev');
    mkdirSync(productDir, { recursive: true });
    writeFileSync(
      path.join(productDir, 'package.json'),
      JSON.stringify({ name: '@makaio/extension-makaio-dev' }),
      'utf-8',
    );
    writeFileSync(
      path.join(productDir, 'descriptor.json'),
      JSON.stringify({
        name: 'makaio-dev',
        displayName: 'Makaio Dev',
        version: '0.1.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { server: true, browser: true },
      }),
      'utf-8',
    );

    const makaioScopeDir = path.join(root, 'node_modules', '@makaio');
    mkdirSync(makaioScopeDir, { recursive: true });
    symlinkSync(
      productDir,
      path.join(makaioScopeDir, 'extension-makaio-dev'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const options = buildDevHostRuntimeOptions(
      {
        workspaceRoot: root,
      },
      path.join(root, '.makaio'),
    );
    const discovered = await options.discovery!.discover();
    const host = discovered.find((ext) => ext.descriptor.name === 'makaio-dev');

    expect(host).toMatchObject({
      descriptor: { name: 'makaio-dev' },
      source: 'local',
    });
    expect(options).not.toHaveProperty('hostCapabilities');
  });
});
