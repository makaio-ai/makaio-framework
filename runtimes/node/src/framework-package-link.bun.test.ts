import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureFrameworkPackageLink } from './framework-package-link.js';

describe('framework package link', () => {
  let tmpDir: string;
  let makaioHome: string;
  let frameworkPackagePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-framework-link-'));
    makaioHome = path.join(tmpDir, '.makaio');
    frameworkPackagePath = path.join(tmpDir, 'app', 'node_modules', '@makaio', 'framework');
    await fs.mkdir(frameworkPackagePath, { recursive: true });
    await fs.writeFile(
      path.join(frameworkPackagePath, 'package.json'),
      JSON.stringify({ name: '@makaio/framework', version: '0.1.0' }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('links the host framework package into the managed extension node_modules tree', async () => {
    await ensureFrameworkPackageLink({ makaioHome, frameworkPackagePath });

    const linkPath = path.join(makaioHome, 'node_modules', '@makaio', 'framework');
    const linkStat = await fs.lstat(linkPath);
    const realTarget = await fs.realpath(linkPath);

    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(realTarget).toBe(await fs.realpath(frameworkPackagePath));
  });

  it('replaces an existing managed framework copy with the host package link', async () => {
    const managedFrameworkPath = path.join(makaioHome, 'node_modules', '@makaio', 'framework');
    await fs.mkdir(managedFrameworkPath, { recursive: true });
    await fs.writeFile(path.join(managedFrameworkPath, 'package.json'), JSON.stringify({ name: '@makaio/framework' }));

    await ensureFrameworkPackageLink({ makaioHome, frameworkPackagePath });

    expect(await fs.realpath(managedFrameworkPath)).toBe(await fs.realpath(frameworkPackagePath));
  });
});
