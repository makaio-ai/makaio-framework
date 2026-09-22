import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ExtensionCoordinator, ExtensionSubjects } from '@makaio/kernel';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { scanInstalledExtensions } from '../installed-extension-scan.js';
import { ExplicitDescriptorDiscovery, FilesystemDescriptorDiscovery } from '../extension-discovery.js';
import { parseMakaioConfig, createMakaioConfigDiscovery } from '../makaio-config.js';
import type { ExportedPackagesReader } from '../installed-extension-readers.js';

/**
 * One exported package a stub reader reports for an extension's server entry.
 */
interface StubExportedPackage {
  /** Executable package name, as the server entry would export it. */
  readonly name: string;
  /** Version reported for that package. */
  readonly version: string;
}

/**
 * Write an installable extension package: a valid `descriptor.json` declaring
 * a server entrypoint, plus the `dist/server.mjs` file the runtime's
 * convention resolution looks for.
 *
 * The file is never imported — the scan under test is driven with a stub
 * reader — but it must exist, because an unresolvable entrypoint is a
 * different (criticality-unknown) code path than the one these tests cover.
 * @param packageDir - Absolute directory the package is written to.
 * @param name - Descriptor name to declare.
 * @param version - Descriptor version to declare.
 * @returns Absolute path of the server entry the scan will resolve.
 */
async function writeExtensionPackage(packageDir: string, name: string, version: string): Promise<string> {
  await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
  const descriptor = {
    name,
    displayName: name,
    version,
    makaio: { framework: '>=0.1.0' },
    entrypoints: { server: true },
  };
  await fs.writeFile(path.join(packageDir, 'descriptor.json'), JSON.stringify(descriptor), 'utf-8');
  const serverEntry = path.join(packageDir, 'dist', 'server.mjs');
  await fs.writeFile(serverEntry, 'export default [];\n', 'utf-8');
  return serverEntry;
}

/**
 * Build a reader that answers from a fixed map, keyed by the resolved server
 * entry path so two tiers can declare the same descriptor name and still get
 * distinct exports.
 * @param exportsByServerPath - Exported packages per resolved server entry path.
 * @returns A reader over that map; unknown paths resolve to `undefined`.
 */
function stubReader(exportsByServerPath: ReadonlyMap<string, readonly StubExportedPackage[]>): ExportedPackagesReader {
  return async (target) => {
    const packages = exportsByServerPath.get(target.serverImportPath);
    return packages === undefined ? undefined : { packages, invalidCriticalNames: new Set<string>() };
  };
}

describe('scanInstalledExtensions tier merge', () => {
  let tmpDir: string;
  let makaioHome: string;
  let projectRoot: string;
  let sourcesDir: string;

  beforeEach(async () => {
    // Realpath'd up front: entrypoint containment checks canonicalize
    // symlinks, so a symlinked temp root (the default on macOS) would yield
    // two spellings of the same file and make the stub reader's keys
    // tier-dependent.
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-installed-scan-')));
    makaioHome = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    sourcesDir = path.join(tmpDir, 'sources');
    await fs.mkdir(path.join(projectRoot, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(makaioHome, 'extensions'), { recursive: true });
    await fs.mkdir(sourcesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build the discovery a runtime started from this project directory with no
   * runtime-config overrides would use.
   * @returns Filesystem discovery over all three default tiers.
   */
  function defaultDiscovery(): FilesystemDescriptorDiscovery {
    return new FilesystemDescriptorDiscovery(projectRoot, {
      extensionsDir: path.join(makaioHome, 'extensions'),
      nodeModulesDir: path.join(makaioHome, 'node_modules'),
    });
  }

  /**
   * Install a project-local extension — the highest-priority discovery tier.
   * @param name - Descriptor name.
   * @param version - Descriptor version.
   * @returns Absolute path of its resolved server entry.
   */
  async function installProjectLocal(name: string, version: string): Promise<string> {
    return writeExtensionPackage(path.join(projectRoot, 'node_modules', name), name, version);
  }

  /**
   * Install a symlinked data-home extension — the `'local'` discovery tier,
   * which ranks below project-local.
   *
   * The scan resolves entrypoints against the path discovery reports, which is
   * the link itself rather than its target, so the returned entry is spelled
   * through the link.
   * @param name - Descriptor name.
   * @param version - Descriptor version.
   * @returns Absolute path of its resolved server entry.
   */
  async function installSymlinked(name: string, version: string): Promise<string> {
    await writeExtensionPackage(path.join(sourcesDir, name), name, version);
    const linkPath = path.join(makaioHome, 'extensions', name);
    await fs.symlink(path.join(sourcesDir, name), linkPath, 'dir');
    return path.join(linkPath, 'dist', 'server.mjs');
  }

  it('reports the whole lower-tier group as shadowed when a descriptor name collides across tiers', async () => {
    const projectEntry = await installProjectLocal('alpha', '1.0.0');
    const symlinkedEntry = await installSymlinked('alpha', '2.0.0');

    const records = await scanInstalledExtensions({
      discovery: defaultDiscovery(),
      exportedPackages: stubReader(
        new Map([
          [
            projectEntry,
            [
              { name: 'alpha', version: '1.0.0' },
              { name: 'alpha.project-child', version: '1.0.0' },
            ],
          ],
          [
            symlinkedEntry,
            [
              { name: 'alpha', version: '2.0.0' },
              { name: 'alpha.symlinked-child', version: '2.0.0' },
            ],
          ],
        ]),
      ),
    });

    // The losing descriptor's non-colliding child is shadowed with it: the
    // runtime would only ever load one of the two descriptors, so the other's
    // exported packages never register. Both stay in the scan, marked and
    // ordered after their winner, because they are installed and an operator
    // who just installed them would otherwise see them vanish.
    expect(records).toStrictEqual([
      { name: 'alpha', version: '1.0.0', origin: 'project-local', declaresServerEntrypoint: true },
      { name: 'alpha.project-child', version: '1.0.0', origin: 'project-local', declaresServerEntrypoint: true },
      {
        name: 'alpha',
        version: '2.0.0',
        origin: 'local',
        declaresServerEntrypoint: true,
        shadowedBy: 'project-local',
      },
      {
        name: 'alpha.symlinked-child',
        version: '2.0.0',
        origin: 'local',
        declaresServerEntrypoint: true,
        shadowedBy: 'project-local',
      },
    ]);
  });

  it('reports a contest between a higher-tier child package and a lower-tier descriptor of that name as a collision', async () => {
    const projectEntry = await installProjectLocal('beta', '1.0.0');
    const symlinkedEntry = await installSymlinked('beta.child', '2.0.0');

    const records = await scanInstalledExtensions({
      discovery: defaultDiscovery(),
      exportedPackages: stubReader(
        new Map([
          [
            projectEntry,
            [
              { name: 'beta', version: '1.0.0' },
              { name: 'beta.child', version: '1.0.0' },
            ],
          ],
          [
            symlinkedEntry,
            [
              { name: 'beta.child', version: '2.0.0' },
              { name: 'beta.child.leaf', version: '2.0.0' },
            ],
          ],
        ]),
      ),
    });

    // Tier precedence cannot settle this: discovery deduplicates by descriptor
    // name, and `beta` and `beta.child` are two different descriptor names, so
    // both descriptors are admitted and both register `beta.child`. The
    // coordinator's own name resolution then aborts the load, so neither
    // claimant is reported as the winner. The losing descriptor's
    // non-colliding child is unaffected — its descriptor won its own name.
    expect(records).toStrictEqual([
      { name: 'beta', version: '1.0.0', origin: 'project-local', declaresServerEntrypoint: true },
      {
        name: 'beta.child',
        version: '1.0.0',
        origin: 'project-local',
        declaresServerEntrypoint: true,
        collidesWith: 'local',
      },
      {
        name: 'beta.child',
        version: '2.0.0',
        origin: 'local',
        declaresServerEntrypoint: true,
        collidesWith: 'project-local',
      },
      { name: 'beta.child.leaf', version: '2.0.0', origin: 'local', declaresServerEntrypoint: true },
    ]);
  });

  it('reports the version the server entry exports, not the descriptor version', async () => {
    // The loader registers the exported package object, and the two versions
    // are allowed to diverge (a descriptor republished under its own version
    // line, a package built from a different source version).
    const projectEntry = await installProjectLocal('gamma', '1.0.0');

    const records = await scanInstalledExtensions({
      discovery: defaultDiscovery(),
      exportedPackages: stubReader(new Map([[projectEntry, [{ name: 'gamma', version: '9.9.9' }]]])),
    });

    expect(records).toStrictEqual([
      { name: 'gamma', version: '9.9.9', origin: 'project-local', declaresServerEntrypoint: true },
    ]);
  });
});

describe('scanInstalledExtensions configured-discovery view', () => {
  let tmpDir: string;
  let makaioHome: string;
  let hostExtensionsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-configured-scan-')));
    makaioHome = path.join(tmpDir, 'home');
    hostExtensionsDir = path.join(tmpDir, 'host-extensions');
    await fs.mkdir(makaioHome, { recursive: true });
    await fs.mkdir(hostExtensionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build the discovery a host configuring its own descriptor root and an
   * exclude filter boots with.
   * @returns Discovery over the host's own root, honouring its filters.
   */
  function configuredDiscovery(): ReturnType<typeof createMakaioConfigDiscovery> {
    return createMakaioConfigDiscovery(
      parseMakaioConfig(
        { extensions: { discoveryPaths: [hostExtensionsDir], exclude: ['filtered-*'] } },
        { baseDir: tmpDir, makaioHome },
      ),
    );
  }

  it('lists a package only the configured root can see, and omits one the configured filter drops', async () => {
    // Neither package lives in a default tier, so a scan that assembled its
    // own filesystem view would report both as not installed; a scan that
    // ignored the filter would offer `filtered-ext` as toggleable even though
    // the next boot never discovers it.
    const eligibleEntry = await writeExtensionPackage(
      path.join(hostExtensionsDir, 'eligible-ext'),
      'eligible-ext',
      '1.0.0',
    );
    const filteredEntry = await writeExtensionPackage(
      path.join(hostExtensionsDir, 'filtered-ext'),
      'filtered-ext',
      '1.0.0',
    );

    const records = await scanInstalledExtensions({
      discovery: configuredDiscovery(),
      exportedPackages: stubReader(
        new Map([
          [eligibleEntry, [{ name: 'eligible-ext', version: '1.0.0' }]],
          [filteredEntry, [{ name: 'filtered-ext', version: '1.0.0' }]],
        ]),
      ),
    });

    expect(records).toStrictEqual([
      { name: 'eligible-ext', version: '1.0.0', origin: 'project-local', declaresServerEntrypoint: true },
    ]);
  });

  it('persists for the configured root and refuses the filtered name as not installed', async () => {
    const eligibleEntry = await writeExtensionPackage(
      path.join(hostExtensionsDir, 'eligible-ext'),
      'eligible-ext',
      '1.0.0',
    );
    const filteredEntry = await writeExtensionPackage(
      path.join(hostExtensionsDir, 'filtered-ext'),
      'filtered-ext',
      '1.0.0',
    );
    const exportedPackages = stubReader(
      new Map([
        [eligibleEntry, [{ name: 'eligible-ext', version: '1.0.0' }]],
        [filteredEntry, [{ name: 'filtered-ext', version: '1.0.0' }]],
      ]),
    );

    const bus = createBusInstance();
    const persisted = new Map<string, boolean>();
    const coordinator = new ExtensionCoordinator(bus, {
      loadEnabled: (name) => persisted.get(name),
      persistEnabled: async (name, enabled) => {
        persisted.set(name, enabled);
      },
      installedCatalog: () => scanInstalledExtensions({ discovery: configuredDiscovery(), exportedPackages }),
    });
    coordinator.load([]);

    try {
      await expect(
        bus.request(ExtensionSubjects.setEnabled, { name: 'eligible-ext', enabled: false }),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await expect(
        bus.request(ExtensionSubjects.setEnabled, { name: 'filtered-ext', enabled: false }),
      ).resolves.toEqual({ success: false, outcome: 'rejected', reason: 'not-installed' });

      expect([...persisted]).toStrictEqual([['eligible-ext', false]]);
    } finally {
      await coordinator.shutdown();
    }
  });
});

describe('scanInstalledExtensions preloaded server modules', () => {
  let bundleRoot: string;

  beforeEach(async () => {
    // A bundled host statically imports its extensions; the package root it
    // reports carries the descriptor but no built server entry, so nothing
    // here is convention-resolvable on disk.
    bundleRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-preloaded-scan-')));
  });

  afterEach(async () => {
    await fs.rm(bundleRoot, { recursive: true, force: true });
  });

  /**
   * Build the discovery a bundled host hands both the loader and the catalog:
   * one descriptor whose server module is already loaded.
   * @param defaultExport - Server entry default export the host preloaded.
   * @returns Explicit discovery over that single preloaded descriptor.
   */
  function preloadedDiscovery(defaultExport: unknown): ExplicitDescriptorDiscovery {
    return new ExplicitDescriptorDiscovery([
      {
        descriptor: parseExtensionDescriptor({
          name: 'bundled-ext',
          displayName: 'Bundled Extension',
          version: '1.0.0',
          makaio: { framework: '>=0.1.0' },
          entrypoints: { server: true },
        }),
        extensionPath: path.join(bundleRoot, 'bundled-ext'),
        source: 'local',
        preloadedModule: { default: defaultExport },
      },
    ]);
  }

  /**
   * Reader that fails the test if the scan tries to load anything itself.
   * @param target - Entry the scan asked to import, named in the failure.
   * @returns Never resolves; always throws.
   */
  const rejectingReader: ExportedPackagesReader = async (target) => {
    throw new Error(`reader must not be asked to import ${target.serverImportPath}`);
  };

  const bundledExport = [
    { name: 'bundled-ext', displayName: 'Bundled Extension', version: '2.0.0', critical: true },
    { name: 'bundled-ext.child', displayName: 'Bundled Child', version: '2.1.0' },
  ];

  it('expands the preloaded export instead of resolving an entry file', async () => {
    const records = await scanInstalledExtensions({
      discovery: preloadedDiscovery(bundledExport),
      exportedPackages: rejectingReader,
    });

    // Criticality is resolved (never `criticalityUnknown`), the child package
    // exists, and both carry the exported versions — the loader loads this
    // very module, so the catalog describes exactly what it registers.
    expect(records).toStrictEqual([
      {
        name: 'bundled-ext',
        version: '2.0.0',
        origin: 'project-local',
        critical: true,
        declaresServerEntrypoint: true,
      },
      { name: 'bundled-ext.child', version: '2.1.0', origin: 'project-local', declaresServerEntrypoint: true },
    ]);
  });

  it('rejects a preloaded export that violates the descriptor identity contract', async () => {
    const records = await scanInstalledExtensions({
      discovery: preloadedDiscovery({ name: 'other-ext', displayName: 'Other', version: '1.0.0' }),
      exportedPackages: rejectingReader,
    });

    // The loader would refuse this export too, so its criticality is genuinely
    // unresolved rather than a legitimate "not critical".
    expect(records).toStrictEqual([
      {
        name: 'bundled-ext',
        version: '1.0.0',
        origin: 'project-local',
        criticalityUnknown: true,
        declaresServerEntrypoint: true,
      },
    ]);
  });

  it('admits a toggle for a preloaded child package and refuses a name it never exported', async () => {
    const bus = createBusInstance();
    const persisted = new Map<string, boolean>();
    const coordinator = new ExtensionCoordinator(bus, {
      loadEnabled: (name) => persisted.get(name),
      persistEnabled: async (name, enabled) => {
        persisted.set(name, enabled);
      },
      installedCatalog: () =>
        scanInstalledExtensions({
          discovery: preloadedDiscovery(bundledExport),
          exportedPackages: rejectingReader,
        }),
    });
    coordinator.load([]);

    try {
      await expect(
        bus.request(ExtensionSubjects.setEnabled, { name: 'bundled-ext.child', enabled: false }),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await expect(
        bus.request(ExtensionSubjects.setEnabled, { name: 'bundled-ext.missing', enabled: false }),
      ).resolves.toEqual({ success: false, outcome: 'rejected', reason: 'not-installed' });

      expect([...persisted]).toStrictEqual([['bundled-ext.child', false]]);
    } finally {
      await coordinator.shutdown();
    }
  });
});
