/**
 * End-to-end integration test for the extension browser-loading pipeline.
 *
 * Covers the full flow for a browser-only extension (no server entry):
 *   ExplicitDescriptorDiscovery → synthesizeBrowserOnlyPackages
 *     → mergePackagesByDescriptorSourcePriority
 *
 * Also verifies that the mount callback correctly wires a Hono app by delegating
 * to the injected `createMount` factory, and that the URL/path conventions are
 * preserved end-to-end.
 *
 * These tests use real implementations throughout — no mocked modules.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MakaioExtension } from '@makaio/contracts';
import { ExplicitDescriptorDiscovery, type DiscoveredExtension } from '../extension-discovery.js';
import { synthesizeBrowserOnlyPackages } from '../synthesize-browser-only-packages.js';
import { mergePackagesByDescriptorSourcePriority } from '../load-extensions.js';
import type { BridgeBrowserOptions } from '../create-static-mount.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const BROWSER_EXT_PATH = path.join(FIXTURES_DIR, 'browser-ext');

/**
 * Build a {@link DiscoveredExtension} from the browser-ext fixture.
 * The descriptor values are taken from the real fixture descriptor.json.
 */
const BROWSER_EXT_DISCOVERED: DiscoveredExtension = {
  descriptor: {
    name: 'browser-ext',
    displayName: 'Browser Extension',
    version: '1.0.0',
    makaio: { framework: '>=0.1.0' },
    entrypoints: { browser: 'bundle/browser/index' },
  },
  extensionPath: BROWSER_EXT_PATH,
  source: 'local',
};

// ---------------------------------------------------------------------------
// Mount spy factory — records calls without needing a real Hono instance
// ---------------------------------------------------------------------------

/** Recorded arguments from a single `createMount` invocation. */
interface MountCallRecord {
  readonly serveRoot: string;
  readonly urlPrefix: string;
  readonly mountedApps: unknown[];
}

/**
 * Factory for a `createMount` spy.
 * @param records - Array to push {@link MountCallRecord} entries into.
 * @returns A {@link BridgeBrowserOptions.createMount} compatible function.
 */
function makeMountSpy(records: MountCallRecord[]): NonNullable<BridgeBrowserOptions['createMount']> {
  return (serveRoot, urlPrefix) => {
    const mountedApps: unknown[] = [];
    records.push({ serveRoot, urlPrefix, mountedApps });
    return (app) => {
      mountedApps.push(app);
    };
  };
}

// ---------------------------------------------------------------------------
// Test 1: ExplicitDescriptorDiscovery with browser-only fixture
// ---------------------------------------------------------------------------

describe('ExplicitDescriptorDiscovery with browser-only fixture', () => {
  it('discover returns the fixture extension unchanged', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.descriptor.name).toBe('browser-ext');
    expect(discovered[0]?.descriptor.entrypoints?.browser).toBe('bundle/browser/index');
    expect(discovered[0]?.descriptor.entrypoints?.server).toBeUndefined();
  });

  it('synthesizeBrowserOnlyPackages produces a package with correct browser entrypoint', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();
    const mountRecords: MountCallRecord[] = [];

    const result = synthesizeBrowserOnlyPackages(discovered, { createMount: makeMountSpy(mountRecords) });

    expect(result.packages).toHaveLength(1);
    const pkg = result.packages[0];
    expect(pkg?.name).toBe('browser-ext');
    expect(pkg?.displayName).toBe('Browser Extension');
    expect(pkg?.browser?.entrypoint).toBe('/extensions/browser-ext/browser/index.js');
    expect(pkg?.http?.prefix).toBe('/extensions/browser-ext/browser');
  });

  it('synthesizeBrowserOnlyPackages resolves serveRoot to the directory containing the browser bundle', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();
    const mountRecords: MountCallRecord[] = [];

    synthesizeBrowserOnlyPackages(discovered, { createMount: makeMountSpy(mountRecords) });

    expect(mountRecords).toHaveLength(1);
    const expectedServeRoot = path.join(BROWSER_EXT_PATH, 'dist', 'bundle', 'browser');
    expect(mountRecords[0]?.serveRoot).toBe(expectedServeRoot);
    expect(mountRecords[0]?.urlPrefix).toBe('/extensions/browser-ext/browser');
  });

  it('descriptor-source merge passes the synthesized package through when it is the only source', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();
    const mountRecords: MountCallRecord[] = [];

    const { packages } = synthesizeBrowserOnlyPackages(discovered, { createMount: makeMountSpy(mountRecords) });
    const merged = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'browser-ext', descriptorSource: 'workspace-descriptors', packages },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('browser-ext');
  });
});

// ---------------------------------------------------------------------------
// Test 2: mount callback wiring
// ---------------------------------------------------------------------------

describe('mount callback wiring', () => {
  it('mount callback is invoked with the app passed to it', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();
    const mountRecords: MountCallRecord[] = [];

    const { packages } = synthesizeBrowserOnlyPackages(discovered, { createMount: makeMountSpy(mountRecords) });

    const fakeApp = { use: () => {} };
    packages[0]?.http?.mount(fakeApp);

    expect(mountRecords[0]?.mountedApps).toContain(fakeApp);
  });

  it('each synthesized package gets its own independent mount callback', async () => {
    // The fixture at browser-ext-two/dist/browser/index.mjs must exist so that
    // resolveConventionEntrypoint finds a valid production candidate.
    const secondExt: DiscoveredExtension = {
      descriptor: {
        name: 'browser-ext-two',
        displayName: 'Browser Extension Two',
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { browser: 'browser/index' },
      },
      extensionPath: path.join(FIXTURES_DIR, 'browser-ext-two'),
      source: 'local',
    };

    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED, secondExt]);
    const discovered = await discovery.discover();
    const mountRecords: MountCallRecord[] = [];

    const { packages } = synthesizeBrowserOnlyPackages(discovered, { createMount: makeMountSpy(mountRecords) });

    expect(mountRecords).toHaveLength(2);
    expect(packages).toHaveLength(2);

    const appA = { id: 'app-a' };
    const appB = { id: 'app-b' };
    packages[0]?.http?.mount(appA);
    packages[1]?.http?.mount(appB);

    expect(mountRecords[0]?.mountedApps).toContain(appA);
    expect(mountRecords[0]?.mountedApps).not.toContain(appB);
    expect(mountRecords[1]?.mountedApps).toContain(appB);
    expect(mountRecords[1]?.mountedApps).not.toContain(appA);
  });
});

// ---------------------------------------------------------------------------
// Test 3: full pipeline — discover → synthesize browser-only → merge
// ---------------------------------------------------------------------------

describe('full pipeline: discover → synthesize browser-only → merge', () => {
  it('resolves surface-name stem to the dist bundle directory', async () => {
    // true means "use surface name as stem" → resolves to dist/browser.mjs
    const sourceExt: DiscoveredExtension = {
      descriptor: {
        name: 'makaio-dev',
        displayName: 'Makaio Dev',
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { browser: true as const },
      },
      extensionPath: path.join(FIXTURES_DIR, 'makaio-dev'),
      source: 'local',
    };
    const discovery = new ExplicitDescriptorDiscovery([sourceExt]);
    const discovered = await discovery.discover();
    const mountRecords: MountCallRecord[] = [];

    const { packages } = synthesizeBrowserOnlyPackages(discovered, { createMount: makeMountSpy(mountRecords) });

    expect(packages[0]?.browser?.entrypoint).toBe('/extensions/makaio-dev/browser/browser.js');
    expect(mountRecords[0]?.serveRoot).toBe(path.join(FIXTURES_DIR, 'makaio-dev', 'dist'));
  });

  it('browser-only extension survives full pipeline with no descriptor-source collision', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();
    const mountRecords: MountCallRecord[] = [];

    const { packages: synthesized } = synthesizeBrowserOnlyPackages(discovered, {
      createMount: makeMountSpy(mountRecords),
    });

    const bundledPackages: MakaioExtension[] = [
      {
        name: 'bundled-browser-ext',
        displayName: 'Bundled Browser Ext',
        version: '0.1.0',
      },
    ];
    const merged = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'browser-ext', descriptorSource: 'workspace-descriptors', packages: synthesized },
      { descriptorName: 'bundled-browser-ext', descriptorSource: 'bundled-descriptors', packages: bundledPackages },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.name).toBe('browser-ext');
    expect(merged[0]?.browser?.entrypoint).toBe('/extensions/browser-ext/browser/index.js');
    expect(merged[0]?.http?.prefix).toBe('/extensions/browser-ext/browser');
    expect(mountRecords).toHaveLength(1);
  });

  it('browser-only extension wins when its descriptor source has higher priority', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();

    const { packages: synthesized } = synthesizeBrowserOnlyPackages(discovered, { createMount: () => () => {} });

    const bundledPackages: MakaioExtension[] = [
      {
        name: 'browser-ext',
        displayName: 'Bundled Browser Ext',
        version: '0.1.0',
      },
    ];
    const merged = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'browser-ext', descriptorSource: 'workspace-descriptors', packages: synthesized },
      { descriptorName: 'browser-ext', descriptorSource: 'bundled-descriptors', packages: bundledPackages },
    ]);

    expect(merged).toStrictEqual(synthesized);
  });

  it('extensions with server entries in the same batch are not synthesized', async () => {
    const serverExt: DiscoveredExtension = {
      descriptor: {
        name: 'full-ext',
        displayName: 'Full Extension',
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { server: true as const, browser: 'browser/index' },
      },
      extensionPath: path.join(FIXTURES_DIR, 'full-ext'),
      source: 'local',
    };

    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED, serverExt]);
    const discovered = await discovery.discover();

    const { packages } = synthesizeBrowserOnlyPackages(discovered, { createMount: () => () => {} });

    // Only browser-ext (browser-only) is synthesized; full-ext has a server entry and is skipped
    expect(packages).toHaveLength(1);
    expect(packages[0]?.name).toBe('browser-ext');
  });

  it('configDefaults are empty for the browser-ext fixture (no config.defaults in descriptor)', async () => {
    const discovery = new ExplicitDescriptorDiscovery([BROWSER_EXT_DISCOVERED]);
    const discovered = await discovery.discover();

    const { configDefaults } = synthesizeBrowserOnlyPackages(discovered, { createMount: () => () => {} });

    expect(configDefaults.size).toBe(0);
  });
});
