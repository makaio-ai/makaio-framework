/**
 * Coverage for the coordinator's installed-extension catalog: the
 * `kernel:extension.catalog` RPC, and the `kernel:extension.setEnabled`
 * validation that runs against it for a name the coordinator never loaded.
 *
 * Exercises the real coordinator, toggle seam, and RPC handlers against a real
 * bus. The catalog source itself is a host seam — scanning install tiers and
 * importing extension code belongs to the runtime, not the kernel — so these
 * supply records directly; the scan that produces them is covered where it
 * lives.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { InstalledExtensionCatalogSource, KernelMakaioExtension } from '../extension/types.js';
import { ExtensionSubjects } from '../observability/extension-namespace.js';
import type { InstalledExtensionRecord } from '../observability/installed-extension-catalog-schemas.js';

/**
 * Build a minimal executable package for these fixtures.
 * @param name - Package identifier.
 * @param options - Optional manifest overrides.
 * @returns A loadable package manifest.
 */
function makePackage(
  name: string,
  options: Partial<Omit<KernelMakaioExtension, 'name' | 'displayName'>> = {},
): KernelMakaioExtension {
  return { name, displayName: name, version: '0.1.0', ...options };
}

/**
 * Build an installed-package record for the catalog source.
 * @param name - Executable package name.
 * @param options - Optional record overrides.
 * @returns One installed record.
 */
function record(name: string, options: Partial<InstalledExtensionRecord> = {}): InstalledExtensionRecord {
  return { name, version: '1.0.0', origin: 'npm', ...options };
}

/** A coordinator plus the durable enablement state wired behind it. */
interface Harness {
  readonly coordinator: ExtensionCoordinator;
  /** Durable preferences, standing in for the enablement file. */
  readonly persisted: Map<string, boolean>;
  /** Number of times the catalog source was read. */
  catalogReads: () => number;
}

describe('installed-extension catalog', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  /**
   * Build a loaded coordinator backed by an in-memory durable store.
   * @param options - Fixture inputs: `packages` the coordinator loads,
   *   `installed` records the catalog source reports (omitted entirely to build
   *   a coordinator with no catalog at all), and `managedNames` scoping which
   *   loaded names are operator-managed — every other one behaves as a
   *   framework package.
   * @returns The harness.
   */
  function makeHarness(options: {
    readonly packages: readonly KernelMakaioExtension[];
    readonly installed?: readonly InstalledExtensionRecord[];
    readonly managedNames?: ReadonlySet<string>;
    readonly onCatalogRead?: () => Promise<void>;
  }): Harness {
    const persisted = new Map<string, boolean>();
    let reads = 0;
    const installedCatalog: InstalledExtensionCatalogSource | undefined =
      options.installed === undefined
        ? undefined
        : async () => {
            reads += 1;
            await options.onCatalogRead?.();
            return options.installed ?? [];
          };
    const coordinator = new ExtensionCoordinator(bus, {
      loadEnabled: (name) => persisted.get(name),
      persistEnabled: async (name, enabled) => {
        persisted.set(name, enabled);
      },
      ...(options.managedNames && { extensionManagedNames: options.managedNames }),
      ...(installedCatalog && { installedCatalog }),
    });
    coordinator.load([...options.packages]);
    return { coordinator, persisted, catalogReads: () => reads };
  }

  it('reports every installed package, enriched with the durable preference the coordinator holds', async () => {
    const { persisted } = makeHarness({
      packages: [makePackage('loaded-ext')],
      installed: [record('loaded-ext'), record('never-loaded', { origin: 'project-local', critical: true })],
    });
    persisted.set('never-loaded', false);

    const { entries } = await bus.request(ExtensionSubjects.catalog, {});

    expect(entries).toEqual([
      { name: 'loaded-ext', version: '1.0.0', origin: 'npm', extensionManaged: true },
      {
        name: 'never-loaded',
        version: '1.0.0',
        origin: 'project-local',
        critical: true,
        extensionManaged: true,
        persistedEnabled: false,
      },
    ]);
  });

  it('reports a name held by a framework package as unmanaged, without inventing a preference for it', async () => {
    // A framework package is never subject to operator enablement, so
    // reporting the store's answer under its name would describe a preference
    // that has no effect — the shadowed install is what the name refers to.
    const { persisted } = makeHarness({
      packages: [makePackage('collided-ext')],
      installed: [record('collided-ext')],
      managedNames: new Set(),
    });
    persisted.set('collided-ext', false);

    const { entries } = await bus.request(ExtensionSubjects.catalog, {});

    expect(entries).toEqual([{ name: 'collided-ext', version: '1.0.0', origin: 'npm', extensionManaged: false }]);
  });

  it('answers null, not an empty list, when this runtime has no catalog to report', async () => {
    makeHarness({ packages: [makePackage('loaded-ext')] });

    const { entries } = await bus.request(ExtensionSubjects.catalog, {});

    expect(entries).toBeNull();
  });

  it('persists a preference for an installed package this process never loaded', async () => {
    const { persisted } = makeHarness({ packages: [], installed: [record('never-loaded')] });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'never-loaded', enabled: true });

    // Nothing in this process will start it before a restart, so an enable is
    // durable but deferred.
    expect(result).toEqual({ success: false, outcome: 'restart-required', reason: 'not-loaded' });
    expect(persisted.get('never-loaded')).toBe(true);
  });

  it('reports a disable of a never-loaded package as already matching the runtime', async () => {
    const { persisted } = makeHarness({ packages: [], installed: [record('never-loaded')] });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'never-loaded', enabled: false });

    expect(result).toEqual({ success: true, outcome: 'applied', reason: 'not-loaded' });
    expect(persisted.get('never-loaded')).toBe(false);
  });

  it('refuses a name no installed package carries, writing nothing', async () => {
    const { persisted } = makeHarness({ packages: [], installed: [record('other-ext')] });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'typo-ext', enabled: false });

    expect(result).toEqual({ success: false, outcome: 'rejected', reason: 'not-installed' });
    expect(persisted.size).toBe(0);
  });

  it('refuses to disable an installed package that declares itself critical', async () => {
    const { persisted } = makeHarness({ packages: [], installed: [record('core-ext', { critical: true })] });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'core-ext', enabled: false });

    expect(result).toEqual({ success: false, outcome: 'rejected', reason: 'critical' });
    expect(persisted.size).toBe(0);
  });

  it('still allows enabling an installed critical package', async () => {
    const { persisted } = makeHarness({ packages: [], installed: [record('core-ext', { critical: true })] });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'core-ext', enabled: true });

    expect(result.outcome).toBe('restart-required');
    expect(persisted.get('core-ext')).toBe(true);
  });

  it("fails closed on a disable when the package's criticality could not be resolved", async () => {
    // An unreadable export is not "not critical": the next boot may well read
    // it and force-start the package, leaving this disable permanently
    // ignored.
    const { persisted } = makeHarness({
      packages: [],
      installed: [record('broken-ext', { criticalityUnknown: true, declaresServerEntrypoint: true })],
    });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'broken-ext', enabled: false });

    expect(result).toEqual({ success: false, outcome: 'rejected', reason: 'criticality-unknown' });
    expect(persisted.size).toBe(0);
  });

  it('persists for a name a framework package currently shadows, naming the collision', async () => {
    const { persisted } = makeHarness({
      packages: [makePackage('collided-ext')],
      installed: [record('collided-ext')],
      managedNames: new Set(),
    });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'collided-ext', enabled: true });

    expect(result).toEqual({
      success: false,
      outcome: 'restart-required',
      reason: 'framework-package-shadowed',
    });
    expect(persisted.get('collided-ext')).toBe(true);
  });

  it('refuses an unloaded name outright when this runtime cannot enumerate installed packages', async () => {
    const { persisted } = makeHarness({ packages: [] });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'never-loaded', enabled: true });

    expect(result).toEqual({ success: false, outcome: 'rejected', reason: 'no-catalog' });
    expect(persisted.size).toBe(0);
  });

  it('rejects a framework package outright when there is no catalog to discover a shadowed install through', async () => {
    makeHarness({ packages: [makePackage('framework-ext')], managedNames: new Set() });

    await expect(bus.request(ExtensionSubjects.setEnabled, { name: 'framework-ext', enabled: false })).rejects.toThrow(
      /framework packages are always loaded/,
    );
  });

  it('refuses a request whose catalog scan was still running when shutdown began, persisting nothing', async () => {
    // The scan spawns worker imports, so it deliberately runs outside the
    // lifecycle queue. Admission therefore has to be decided after it, not
    // before: a request admitted on the pre-scan state would be queued behind
    // teardown and still write the enablement file after the runtime stopped.
    let releaseScan = (): void => undefined;
    let markScanStarted = (): void => undefined;
    const scanStarted = new Promise<void>((resolveStarted) => {
      markScanStarted = resolveStarted;
    });
    const scanGate = new Promise<void>((resolveGate) => {
      releaseScan = resolveGate;
    });
    const harness = makeHarness({
      packages: [],
      installed: [record('never-loaded')],
      onCatalogRead: async () => {
        markScanStarted();
        await scanGate;
      },
    });

    const request = bus.request(ExtensionSubjects.setEnabled, { name: 'never-loaded', enabled: true });
    await scanStarted;
    const shutdown = harness.coordinator.shutdown();
    releaseScan();

    await expect(request).resolves.toEqual({ success: false, outcome: 'rejected', reason: 'shutting-down' });
    expect(harness.persisted.size).toBe(0);
    await shutdown;
  });

  it('still reads the catalog for a name it loaded as an operator-managed extension', async () => {
    // The coordinator holds the single copy it loaded at boot, so its own
    // entries can never reveal a second copy installed since — only the
    // catalog can. Answering a loaded name from `entries` alone would persist
    // a preference the next start refuses to act on.
    const harness = makeHarness({ packages: [makePackage('loaded-ext')], installed: [record('loaded-ext')] });

    await bus.request(ExtensionSubjects.setEnabled, { name: 'loaded-ext', enabled: true });

    expect(harness.catalogReads()).toBe(1);
    expect(harness.persisted.get('loaded-ext')).toBe(true);
  });

  it('refuses a toggle for a contested name and writes nothing, even for a name it loaded', async () => {
    const harness = makeHarness({
      packages: [makePackage('contested-ext')],
      installed: [record('contested-ext', { collidesWith: 'project-local' })],
    });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'contested-ext', enabled: false });

    expect(result).toEqual({ success: false, outcome: 'rejected', reason: 'name-collision' });
    expect(harness.persisted.size).toBe(0);
  });

  it('refuses a toggle for a contested name this coordinator never loaded', async () => {
    const harness = makeHarness({
      packages: [],
      installed: [record('contested-ext', { collidesWith: 'npm' })],
    });

    const result = await bus.request(ExtensionSubjects.setEnabled, { name: 'contested-ext', enabled: true });

    expect(result).toEqual({ success: false, outcome: 'rejected', reason: 'name-collision' });
    expect(harness.persisted.size).toBe(0);
  });
});
