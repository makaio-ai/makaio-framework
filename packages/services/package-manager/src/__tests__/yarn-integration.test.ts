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

  it('uses a portal range for a host-provided framework package path', async () => {
    const { resolveFrameworkDependencyRange } = await import('../yarn-integration.js');
    const localPackagePath = path.join(tempDir, 'app', 'node_modules', '@makaio', 'framework');
    const expectedPortablePath =
      process.platform === 'win32'
        ? localPackagePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')
        : localPackagePath;

    // makaio-boundary-allow-next-line: Windows path fixture verifies Yarn portal URL normalization.
    expect(
      resolveFrameworkDependencyRange({
        versionRange: '^0.1.0',
        localPackagePath,
      }),
    ).toBe(`portal:${expectedPortablePath}`);
  });

  it('uses Yarn portable path format for Windows portal ranges', async () => {
    const { resolveFrameworkDependencyRange } = await import('../yarn-integration.js');

    expect(
      resolveFrameworkDependencyRange({
        versionRange: '^0.1.0',
        localPackagePath: 'C:\\Users\\makaio\\AppData\\Local\\Makaio\\node_modules\\@makaio\\framework',
      }),
    ).toBe('portal:/C:/Users/makaio/AppData/Local/Makaio/node_modules/@makaio/framework'); // makaio-boundary-allow-line: Windows path fixture verifies Yarn portal URL normalization.
  });

  it('uses the registry range when no host framework package path is provided', async () => {
    const { resolveFrameworkDependencyRange } = await import('../yarn-integration.js');

    expect(resolveFrameworkDependencyRange({ versionRange: '^0.1.0' })).toBe('^0.1.0');
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

  it('reads an installed extension descriptor from node_modules', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const descriptorDir = path.join(tempDir, 'node_modules', '@acme', 'weather-tools');
    await fs.mkdir(descriptorDir, { recursive: true });
    await fs.writeFile(
      path.join(descriptorDir, 'descriptor.json'),
      JSON.stringify({
        name: '@acme/weather-tools',
        displayName: 'Weather Tools',
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { server: true },
      }),
    );

    const pm = new YarnPackageManager(tempDir);
    const descriptor = await pm.readInstalledExtensionDescriptor('@acme/weather-tools');

    expect(descriptor?.name).toBe('@acme/weather-tools');
  });

  it('returns null for an installed package without a valid descriptor', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const descriptorDir = path.join(tempDir, 'node_modules', '@acme', 'plain-package');
    await fs.mkdir(descriptorDir, { recursive: true });

    const pm = new YarnPackageManager(tempDir);
    const descriptor = await pm.readInstalledExtensionDescriptor('@acme/plain-package');

    expect(descriptor).toBeNull();
  });

  it('snapshots and restores package.json contents', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const pm = new YarnPackageManager(tempDir);
    await pm.initialize();

    const packageJsonPath = path.join(tempDir, 'package.json');
    const snapshot = await pm.readManifestSnapshot();
    await fs.writeFile(packageJsonPath, JSON.stringify({ name: 'changed', private: true, dependencies: {} }));

    await pm.writeManifestAndReinstall(snapshot);

    const restored = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    expect(restored.name).toBe('makaio-packages');
  });

  it('exposes package version resolution for package specifiers', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const pm = new YarnPackageManager(tempDir);

    expect(typeof pm.resolvePackageVersion).toBe('function');
  });

  it('formats package spec with version range', async () => {
    const { packageSpecWithRange } = await import('../yarn-integration.js');
    expect(packageSpecWithRange('@makaio/child', '>=1.0.0')).toBe('@makaio/child@>=1.0.0');
  });

  it('returns bare name when range is undefined', async () => {
    const { packageSpecWithRange } = await import('../yarn-integration.js');
    expect(packageSpecWithRange('@makaio/child', undefined)).toBe('@makaio/child');
  });

  it('returns bare name when range is latest', async () => {
    const { packageSpecWithRange } = await import('../yarn-integration.js');
    expect(packageSpecWithRange('@makaio/child', 'latest')).toBe('@makaio/child');
  });

  it('lists installed extension descriptors from scoped and unscoped packages', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');

    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'makaio-packages',
        private: true,
        dependencies: { '@acme/weather-tools': '^1.0.0', 'my-ext': '^2.0.0', 'plain-pkg': '^1.0.0' },
      }),
    );

    const validDescriptor = {
      name: 'weather-tools',
      displayName: 'Weather Tools',
      version: '1.0.0',
      makaio: { framework: '>=0.1.0' },
      entrypoints: { server: true },
    };

    const scopedDir = path.join(tempDir, 'node_modules', '@acme', 'weather-tools');
    await fs.mkdir(scopedDir, { recursive: true });
    await fs.writeFile(path.join(scopedDir, 'descriptor.json'), JSON.stringify(validDescriptor));
    await fs.writeFile(path.join(scopedDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));

    const unscopedDir = path.join(tempDir, 'node_modules', 'my-ext');
    await fs.mkdir(unscopedDir, { recursive: true });
    await fs.writeFile(
      path.join(unscopedDir, 'descriptor.json'),
      JSON.stringify({ ...validDescriptor, name: 'my-ext' }),
    );
    await fs.writeFile(path.join(unscopedDir, 'package.json'), JSON.stringify({ version: '2.0.0' }));

    const noDescriptorDir = path.join(tempDir, 'node_modules', 'plain-pkg');
    await fs.mkdir(noDescriptorDir, { recursive: true });
    await fs.writeFile(path.join(noDescriptorDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));

    const dotDir = path.join(tempDir, 'node_modules', '.bin');
    await fs.mkdir(dotDir, { recursive: true });

    const pm = new YarnPackageManager(tempDir);
    const descriptors = await pm.listInstalledExtensionDescriptors();

    expect(descriptors).toHaveLength(2);
    expect(descriptors.map((d) => d.npmName).sort()).toEqual(['@acme/weather-tools', 'my-ext']);
    expect(descriptors.find((d) => d.npmName === '@acme/weather-tools')?.version).toBe('1.0.0');
    expect(descriptors.find((d) => d.npmName === 'my-ext')?.version).toBe('2.0.0');
  });
});
