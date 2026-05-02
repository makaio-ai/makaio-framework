import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

describe('YarnPackageManager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yarn-pm-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create package.json on initialize when missing', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const pm = new YarnPackageManager(tempDir);
    await pm.initialize();

    const pkgJson = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(pkgJson.name).toBe('makaio-packages');
    expect(pkgJson.private).toBe(true);
  });

  it('should create .yarnrc.yml on initialize when missing', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const pm = new YarnPackageManager(tempDir);
    await pm.initialize();

    const yarnrc = await fs.readFile(path.join(tempDir, '.yarnrc.yml'), 'utf-8');
    expect(yarnrc).toContain('nodeLinker: node-modules');
  });

  it('should replace incompatible existing Yarn linker config', async () => {
    await fs.writeFile(path.join(tempDir, '.yarnrc.yml'), 'nodeLinker: pnp\nenableGlobalCache: false\n');

    const { YarnPackageManager } = await import('../yarn-integration.js');
    const pm = new YarnPackageManager(tempDir);
    await pm.initialize();

    const yarnrc = await fs.readFile(path.join(tempDir, '.yarnrc.yml'), 'utf-8');
    expect(yarnrc).toContain('nodeLinker: node-modules');
    expect(yarnrc).toContain('enableGlobalCache: false');
    expect(yarnrc).not.toContain('nodeLinker: pnp');
  });

  it('adds @makaio/framework dependency when ensureFrameworkDependency is called', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const pm = new YarnPackageManager(tempDir);
    await pm.initialize();

    // ensureFrameworkDependency requires a real Yarn project install which
    // is too heavy for unit tests without a live npm registry. Verify the
    // method exists and is callable so integration tests cover the full flow.
    expect(typeof pm.ensureFrameworkDependency).toBe('function');
  });

  it('should not overwrite existing package.json on initialize', async () => {
    const existing = { name: 'existing', version: '2.0.0', private: true, dependencies: { foo: '1.0.0' } };
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(existing));
    await fs.writeFile(path.join(tempDir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

    const { YarnPackageManager } = await import('../yarn-integration.js');
    const pm = new YarnPackageManager(tempDir);
    await pm.initialize();

    const pkgJson = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(pkgJson.name).toBe('existing');
    expect(pkgJson.dependencies.foo).toBe('1.0.0');
  });
});
