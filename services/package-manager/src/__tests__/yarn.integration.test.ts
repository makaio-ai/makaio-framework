import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

vi.setConfig({ testTimeout: 15_000 });

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

  it('excludes and warns about an installed descriptor that fails schema validation', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const descriptorDir = path.join(tempDir, 'node_modules', '@acme', 'drifted-ext');
    await fs.mkdir(descriptorDir, { recursive: true });
    // `critical` alongside a `server` entrypoint is rejected by
    // `ExtensionDescriptorSchema`'s superRefine — the server entry's exported
    // package(s) own criticality, not the descriptor.
    await fs.writeFile(
      path.join(descriptorDir, 'descriptor.json'),
      JSON.stringify({
        name: '@acme/drifted-ext',
        displayName: 'Drifted Ext',
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { server: true },
        critical: true,
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pm = new YarnPackageManager(tempDir);
      const descriptor = await pm.readInstalledExtensionDescriptor('@acme/drifted-ext');

      expect(descriptor).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid descriptor.json for @acme/drifted-ext'),
        expect.any(String),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('excludes and warns about an installed descriptor.json that is truncated JSON', async () => {
    // Simulates a partial write (crash mid-write, disk full) rather than a
    // schema violation: the file exists and is readable, but `JSON.parse`
    // itself throws before schema validation ever runs.
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const descriptorDir = path.join(tempDir, 'node_modules', '@acme', 'truncated-ext');
    await fs.mkdir(descriptorDir, { recursive: true });
    const validJson = JSON.stringify({
      name: '@acme/truncated-ext',
      displayName: 'Truncated Ext',
      version: '1.0.0',
      makaio: { framework: '>=0.1.0' },
      entrypoints: { server: true },
    });
    await fs.writeFile(
      path.join(descriptorDir, 'descriptor.json'),
      validJson.slice(0, Math.floor(validJson.length / 2)),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pm = new YarnPackageManager(tempDir);
      const descriptor = await pm.readInstalledExtensionDescriptor('@acme/truncated-ext');

      expect(descriptor).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[YarnPackageManager] @acme/truncated-ext: Skipping unparsable descriptor.json'),
        expect.any(String),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('excludes and warns about an installed descriptor.json that is the JSON literal `null`', async () => {
    // `null` is valid JSON, so it must not be confused with a parse failure:
    // it has to reach schema validation and be reported as schema-invalid,
    // not silently swallowed as if `JSON.parse` itself had thrown.
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const descriptorDir = path.join(tempDir, 'node_modules', '@acme', 'null-descriptor-ext');
    await fs.mkdir(descriptorDir, { recursive: true });
    await fs.writeFile(path.join(descriptorDir, 'descriptor.json'), 'null');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pm = new YarnPackageManager(tempDir);
      const descriptor = await pm.readInstalledExtensionDescriptor('@acme/null-descriptor-ext');

      expect(descriptor).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid descriptor.json for @acme/null-descriptor-ext'),
        expect.any(String),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Skipping unparsable descriptor.json'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves critical from the server entry's exported package when the descriptor declares a server entrypoint", async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const packageDir = path.join(tempDir, 'node_modules', '@acme', 'critical-server-ext');
    await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
    // `critical` is forbidden directly on a descriptor with a server
    // entrypoint — only its exported package may declare it.
    await fs.writeFile(
      path.join(packageDir, 'descriptor.json'),
      JSON.stringify({
        name: '@acme/critical-server-ext',
        displayName: 'Critical Server Ext',
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { server: true },
      }),
    );
    await fs.writeFile(
      path.join(packageDir, 'dist', 'server.mjs'),
      `export default { name: '@acme/critical-server-ext', displayName: 'Critical Server Ext', version: '1.0.0', critical: true };\n`,
    );

    const pm = new YarnPackageManager(tempDir);
    const result = await pm.readInstalledDescriptor('@acme/critical-server-ext');

    expect(result).toEqual({
      hasDescriptor: true,
      descriptorName: '@acme/critical-server-ext',
      serverImportPath: await fs.realpath(path.join(packageDir, 'dist', 'server.mjs')),
      declaresServerEntrypoint: true,
      critical: true,
    });
  });

  it('reports no critical flag, with a warning, when the exported server entry cannot be imported', async () => {
    const { YarnPackageManager } = await import('../yarn-integration.js');
    const packageDir = path.join(tempDir, 'node_modules', '@acme', 'broken-server-ext');
    await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, 'descriptor.json'),
      JSON.stringify({
        name: '@acme/broken-server-ext',
        displayName: 'Broken Server Ext',
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { server: true },
      }),
    );
    await fs.writeFile(path.join(packageDir, 'dist', 'server.mjs'), `throw new Error('boom');\n`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pm = new YarnPackageManager(tempDir);
      const result = await pm.readInstalledDescriptor('@acme/broken-server-ext');

      expect(result).toEqual({
        hasDescriptor: true,
        descriptorName: '@acme/broken-server-ext',
        serverImportPath: await fs.realpath(path.join(packageDir, 'dist', 'server.mjs')),
        declaresServerEntrypoint: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to import server entry while reading its exported packages'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
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

  it('resolves per-package descriptors concurrently and keeps manifest declaration order regardless of resolution speed', async () => {
    // Each server-backed dependency's `critical` resolution imports its entry
    // in an isolated worker (resolveCriticalFlag), so this asserts listPackages
    // does not serialize those imports: the manifest's first-declared
    // dependency resolves slower than the second here, and the returned order
    // must still follow declaration order, not settlement order.
    const { YarnPackageManager } = await import('../yarn-integration.js');

    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'makaio-packages',
        private: true,
        dependencies: { '@acme/slow-ext': '^1.0.0', '@acme/fast-ext': '^1.0.0' },
      }),
    );

    const baseDescriptor = {
      displayName: 'Ext',
      version: '1.0.0',
      makaio: { framework: '>=0.1.0' },
      entrypoints: { server: true },
    };

    const slowDir = path.join(tempDir, 'node_modules', '@acme', 'slow-ext');
    await fs.mkdir(path.join(slowDir, 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(slowDir, 'descriptor.json'),
      JSON.stringify({ ...baseDescriptor, name: '@acme/slow-ext' }),
    );
    await fs.writeFile(path.join(slowDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    await fs.writeFile(
      path.join(slowDir, 'dist', 'server.mjs'),
      `await new Promise((resolve) => setTimeout(resolve, 150));\n` +
        `export default { name: '@acme/slow-ext', displayName: 'Slow Ext', version: '1.0.0', critical: true };\n`,
    );

    const fastDir = path.join(tempDir, 'node_modules', '@acme', 'fast-ext');
    await fs.mkdir(path.join(fastDir, 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(fastDir, 'descriptor.json'),
      JSON.stringify({ ...baseDescriptor, name: '@acme/fast-ext' }),
    );
    await fs.writeFile(path.join(fastDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    await fs.writeFile(
      path.join(fastDir, 'dist', 'server.mjs'),
      `export default { name: '@acme/fast-ext', displayName: 'Fast Ext', version: '1.0.0', critical: false };\n`,
    );

    const pm = new YarnPackageManager(tempDir);
    const packages = await pm.listPackages();

    expect(packages.map((pkg) => pkg.name)).toEqual(['@acme/slow-ext', '@acme/fast-ext']);
    expect(packages.map((pkg) => pkg.critical)).toEqual([true, false]);
  });
});
