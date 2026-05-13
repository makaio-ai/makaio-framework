/**
 * Tests for extension wiring in the boot sequence.
 *
 * These tests cover:
 * - resolveExtensionOptions correctly handles extensions
 * - Descriptor-source priority wins on package name collision
 * - Extension with incompatible minVersion is skipped
 *
 * Full bootMakaioRuntime integration tests are out of scope here (they require
 * an HTTP server, SQLite DB, and many other heavy dependencies). The logic
 * added in the boot sequence is tested at the unit level.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects, type MakaioExtension } from '@makaio/contracts';
import type { DiscoveredExtension } from '../extension-discovery.js';
import { ExtensionCoordinator } from '@makaio/kernel';
import { ExplicitDescriptorDiscovery, FilesystemDescriptorDiscovery } from '../extension-discovery.js';
import { loadExtensions, mergePackagesByDescriptorSourcePriority } from '../load-extensions.js';
import type { CoreBootOptions } from '../boot.js';
import {
  buildLocalBusUrl,
  filterConfigDefaultsForLoadedPackages,
  registerExtensionBootContributions,
  selectFrameworkCorePackages,
} from '../boot.js';
import { resolveExtensionOptions } from '../resolve-extension-options.js';
import { createToolContributionProcessor, SessionOrchestratorToken, toolRegistryPackage } from '@makaio/services-core';
import { filesystemPackage } from '@makaio/extension-filesystem';
import { shellPackage } from '@makaio/extension-shell';
import { subagentPackage } from '@makaio/extension-subagent';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRAMEWORK_VERSION = '3.0.0';
let fixtureRoot: string | undefined;

/**
 * Build a minimal valid {@link MakaioExtension}.
 * @param name - Package name.
 */
const makePackage = (name: string): MakaioExtension => ({
  name,
  displayName: `${name} Display`,
});

/**
 * Build a minimal valid {@link DiscoveredExtension}.
 * @param name - Extension name used in the descriptor.
 * @param minVersion - Minimum framework version required. Defaults to `'1.0.0'`.
 */
const makeDiscovered = (name: string, minVersion = '1.0.0'): DiscoveredExtension => ({
  descriptor: {
    name,
    displayName: `${name} Display`,
    version: '1.0.0',
    makaio: { minVersion },
    entrypoints: { server: true as const },
  },
  extensionPath: createExtensionRoot(name),
  source: 'local',
});

/**
 * Create a real extension root with a production server candidate.
 * @param name - Extension name used for the fixture directory.
 * @returns Absolute extension fixture root.
 */
function createExtensionRoot(name: string): string {
  if (fixtureRoot === undefined) {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-boot-extensions-'));
  }

  const extensionPath = fs.mkdtempSync(path.join(fixtureRoot, `${name}-`));
  const serverPath = path.join(extensionPath, 'dist/server.mjs');
  fs.mkdirSync(path.dirname(serverPath), { recursive: true });
  fs.writeFileSync(serverPath, 'export default {};\n');
  return extensionPath;
}

// ---------------------------------------------------------------------------
// resolveExtensionOptions — extensions field
// ---------------------------------------------------------------------------

/**
 * Minimal boot options for exercising resolveExtensionOptions in isolation.
 * @param partial - Partial boot options to merge.
 * @returns Full CoreBootOptions for passing to resolveExtensionOptions.
 */
function minimalBootOptions(partial: Partial<CoreBootOptions> = {}): CoreBootOptions {
  return { ...partial };
}

const TEST_MAKAIO_HOME = '/home/test/.makaio';

describe('resolveExtensionOptions — extensions', () => {
  it('defaults to FilesystemDescriptorDiscovery when no override is provided', () => {
    const resolved = resolveExtensionOptions(minimalBootOptions(), TEST_MAKAIO_HOME);

    expect(resolved.extensions).toBeInstanceOf(FilesystemDescriptorDiscovery);
  });

  it('uses the provided extensions override', () => {
    const discovery = new ExplicitDescriptorDiscovery([]);
    const resolved = resolveExtensionOptions(minimalBootOptions({ discovery }), TEST_MAKAIO_HOME);

    expect(resolved.extensions).toBe(discovery);
  });
});

// ---------------------------------------------------------------------------
// Deduplication: descriptor-source priority wins on name collision
// ---------------------------------------------------------------------------

describe('extension package merge by descriptor-source priority', () => {
  it('keeps packages when descriptor sources do not collide by name', () => {
    const workspace = [makePackage('workspace-ext')];
    const lowerPriority = [makePackage('secondary-ext')];

    const result = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'workspace-ext', descriptorSource: 'workspace-descriptors', packages: workspace },
      { descriptorName: 'secondary-ext', descriptorSource: 'lower-priority-descriptors', packages: lowerPriority },
    ]);

    expect(result.map((pkg) => pkg.name)).toStrictEqual(['workspace-ext', 'secondary-ext']);
  });

  it('keeps the earlier descriptor source when package names collide', () => {
    const workspace = makePackage('shared-ext');
    const lowerPriority = makePackage('shared-ext');

    const result = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'shared-ext', descriptorSource: 'workspace-descriptors', packages: [workspace] },
      {
        descriptorName: 'lower-priority-shared-ext',
        descriptorSource: 'lower-priority-descriptors',
        packages: [lowerPriority],
      },
    ]);

    expect(result).toStrictEqual([workspace]);
  });

  it('keeps the entire earlier descriptor source when descriptor names collide', () => {
    const workspace = [makePackage('shared-ext')];
    const lowerPriority = [makePackage('shared-ext'), makePackage('shared-ext.settings')];

    const result = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'shared-ext', descriptorSource: 'workspace-descriptors', packages: workspace },
      { descriptorName: 'shared-ext', descriptorSource: 'lower-priority-descriptors', packages: lowerPriority },
    ]);

    expect(result).toStrictEqual(workspace);
  });

  it('keeps the earlier descriptor family when it exports namespaced packages', () => {
    const workspace = [makePackage('shared-ext'), makePackage('shared-ext.settings')];
    const lowerPriority = [makePackage('shared-ext')];

    const result = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'shared-ext', descriptorSource: 'workspace-descriptors', packages: workspace },
      { descriptorName: 'shared-ext', descriptorSource: 'lower-priority-descriptors', packages: lowerPriority },
    ]);

    expect(result).toStrictEqual(workspace);
  });

  it('keeps later-source packages that do not collide with earlier sources', () => {
    const workspace = [makePackage('shared-ext')];
    const lowerPriority = [makePackage('shared-ext'), makePackage('lower-priority-only')];

    const result = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'workspace-ext', descriptorSource: 'workspace-descriptors', packages: workspace },
      {
        descriptorName: 'lower-priority-ext',
        descriptorSource: 'lower-priority-descriptors',
        packages: lowerPriority,
      },
    ]);

    expect(result.map((pkg) => pkg.name)).toStrictEqual(['shared-ext', 'lower-priority-only']);
  });

  it('keeps all packages when earlier descriptor sources are empty', () => {
    const lowerPriority = [makePackage('ext-a'), makePackage('ext-b')];

    const result = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'workspace-ext', descriptorSource: 'workspace-descriptors', packages: [] },
      {
        descriptorName: 'lower-priority-ext',
        descriptorSource: 'lower-priority-descriptors',
        packages: lowerPriority,
      },
    ]);

    expect(result).toHaveLength(2);
  });
});

describe('filterConfigDefaultsForLoadedPackages', () => {
  it('drops defaults for extension packages excluded from the final load set', () => {
    const filtered = filterConfigDefaultsForLoadedPackages(
      new Map([
        ['workspace-ext', { mode: 'local' }],
        ['loaded-descriptor-ext', { retries: 3 }],
        ['skipped-descriptor-ext', { retries: 9 }],
      ]),
      new Set(['workspace-ext', 'loaded-descriptor-ext']),
    );

    expect(filtered).toStrictEqual(
      new Map([
        ['workspace-ext', { mode: 'local' }],
        ['loaded-descriptor-ext', { retries: 3 }],
      ]),
    );
  });
});

describe('buildLocalBusUrl', () => {
  it('uses IPv4 loopback when the host binds the IPv4 wildcard', () => {
    expect(buildLocalBusUrl('0.0.0.0', 3010)).toBe('ws://127.0.0.1:3010/bus');
  });

  it('uses IPv6 loopback when the host binds the IPv6 wildcard', () => {
    expect(buildLocalBusUrl('::', 3010)).toBe('ws://[::1]:3010/bus');
  });

  it('brackets explicit IPv6 hosts', () => {
    expect(buildLocalBusUrl('::1', 3010)).toBe('ws://[::1]:3010/bus');
  });
});

describe('session orchestrator runtime ownership', () => {
  it('keeps the framework session orchestrator when no loaded extension owns it', () => {
    const selected = selectFrameworkCorePackages([makePackage('plain-extension')]);

    expect(selected.map((pkg) => pkg.name)).toContain(SessionOrchestratorToken.name);
  });

  it('omits the framework session orchestrator when a loaded extension owns it', () => {
    const owner: MakaioExtension = {
      ...makePackage('host-runtime'),
      runtimeOwnership: { sessionOrchestrator: true },
    };

    const selected = selectFrameworkCorePackages([owner]);

    expect(selected.map((pkg) => pkg.name)).not.toContain(SessionOrchestratorToken.name);
  });

  it('fails when multiple loaded extensions own the session orchestrator', () => {
    const firstOwner: MakaioExtension = {
      ...makePackage('first-runtime'),
      runtimeOwnership: { sessionOrchestrator: true },
    };
    const secondOwner: MakaioExtension = {
      ...makePackage('second-runtime'),
      runtimeOwnership: { sessionOrchestrator: true },
    };

    expect(() => selectFrameworkCorePackages([firstOwner, secondOwner])).toThrow();
  });
});

describe('runtime boot contribution rollback', () => {
  it('runs every registered cleanup when a later contribution fails', () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus);
    const calls: string[] = [];
    const configureError = new Error('configure failed');
    const cleanupError = new Error('cleanup failed');

    const packages: MakaioExtension[] = [
      {
        ...makePackage('first-runtime-boot'),
        runtimeBoot: {
          configure: () => [
            () => {
              calls.push('first-cleanup');
              throw cleanupError;
            },
            () => {
              calls.push('second-cleanup');
            },
          ],
        },
      },
      {
        ...makePackage('failing-runtime-boot'),
        runtimeBoot: {
          configure: () => {
            throw configureError;
          },
        },
      },
    ];

    let thrown: unknown;
    try {
      registerExtensionBootContributions(packages, bus, coordinator);
    } catch (error) {
      thrown = error;
    }

    expect(calls).toStrictEqual(['second-cleanup', 'first-cleanup']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toStrictEqual([configureError, cleanupError]);
  });
});

describe('runtime tool extension contributions', () => {
  it('exposes migrated framework tool extensions through ToolSubjects.list', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: {
        platform: process.platform,
        homedir: '/home/test',
        makaioHome: TEST_MAKAIO_HOME,
        username: 'test',
        machineId: 'machine-1',
        busUrl: 'ws://127.0.0.1:0/bus',
        tryImport: async () => null,
      },
    });

    coordinator.load([toolRegistryPackage, filesystemPackage, shellPackage, subagentPackage]);
    coordinator.registerContributionProcessor(createToolContributionProcessor());

    try {
      await coordinator.startAll();

      const listed = await bus.request(ToolSubjects.list, {});
      const toolsetNames = listed.toolsets.map((toolset) => toolset.name);
      const toolNames = listed.tools.map((tool) => tool.name);

      expect(toolsetNames).toEqual(
        expect.arrayContaining(['filesystem', 'shell', 'subagent-parent', 'subagent-child']),
      );
      expect(toolNames).toEqual(expect.arrayContaining(['read_file', 'shell_exec', 'spawn_subagent', 'complete_task']));
    } finally {
      await coordinator.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Extension version gating via ExplicitDescriptorDiscovery
// ---------------------------------------------------------------------------

describe('extension loading with ExplicitDescriptorDiscovery', () => {
  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-boot-extensions-'));
  });

  afterEach(() => {
    if (fixtureRoot !== undefined) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('loads a valid extension', async () => {
    const pkg = makePackage('my-ext');
    const discovery = new ExplicitDescriptorDiscovery([makeDiscovered('my-ext')]);
    const discovered = await discovery.discover();

    const result = await loadExtensions(discovered, {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: pkg }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toBe(pkg);
  });

  it('skips an extension whose minVersion exceeds the framework version', async () => {
    const discovery = new ExplicitDescriptorDiscovery([makeDiscovered('version-gated-ext', '99.0.0')]);
    const discovered = await discovery.discover();

    const result = await loadExtensions(discovered, {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makePackage('version-gated-ext') }),
    });

    expect(result.packages).toHaveLength(0);
  });

  it('returns an empty list when no extensions are discovered', async () => {
    const discovery = new ExplicitDescriptorDiscovery([]);
    const discovered = await discovery.discover();

    const result = await loadExtensions(discovered, {
      frameworkVersion: FRAMEWORK_VERSION,
    });

    expect(result.packages).toHaveLength(0);
  });

  it('synthesizes a managed package for detached execution mode', async () => {
    const importModule = vi.fn(async () => {
      throw new Error('detached extensions must not use embedded import fallback');
    });
    const discovered: DiscoveredExtension[] = [
      {
        descriptor: {
          name: 'detached-ext',
          displayName: 'Detached Ext Display',
          version: '1.0.0',
          makaio: { minVersion: '1.0.0' },
          execution: 'detached',
          transport: { type: 'bus-stdio', command: 'node', args: ['detached.js'] },
        },
        extensionPath: '/fake/path',
        source: 'local',
      },
    ];

    const result = await loadExtensions(discovered, {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule,
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.name).toBe('detached-ext');
    expect(importModule).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration: discover → load → descriptor-source merge
// ---------------------------------------------------------------------------

describe('extension pipeline integration', () => {
  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-boot-extensions-'));
  });

  afterEach(() => {
    if (fixtureRoot !== undefined) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('discovery → load → merge pipeline produces valid packages', async () => {
    const discovery = new ExplicitDescriptorDiscovery([
      makeDiscovered('workspace-ext'),
      makeDiscovered('collision-ext'),
    ]);

    const discovered = await discovery.discover();

    const loaded = await loadExtensions(discovered, {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async (entryPath) => {
        const name = entryPath.includes('workspace-ext') ? 'workspace-ext' : 'collision-ext';
        return { default: makePackage(name) };
      },
    });

    // Both loaded successfully before source-priority merging
    expect(loaded.packages).toHaveLength(2);

    const merged = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'workspace-ext', descriptorSource: 'workspace-descriptors', packages: loaded.packages },
      {
        descriptorName: 'lower-priority-ext',
        descriptorSource: 'lower-priority-descriptors',
        packages: [makePackage('collision-ext'), makePackage('lower-priority-ext')],
      },
    ]);

    expect(merged.map((pkg) => pkg.name)).toStrictEqual(['workspace-ext', 'collision-ext', 'lower-priority-ext']);

    // Verify the merged package carries the expected MakaioExtension shape
    expect(merged[0]).toHaveProperty('name');
    expect(merged[0]).toHaveProperty('displayName');
  });

  it('pipeline skips version-gated extensions and boot continues', async () => {
    const discovery = new ExplicitDescriptorDiscovery([
      makeDiscovered('valid-ext', '1.0.0'),
      makeDiscovered('gated-ext', '99.0.0'),
    ]);

    const discovered = await discovery.discover();

    const loaded = await loadExtensions(discovered, {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async (entryPath) => {
        const name = entryPath.includes('valid-ext') ? 'valid-ext' : 'gated-ext';
        return { default: makePackage(name) };
      },
    });

    // Only the version-compatible extension is loaded
    expect(loaded.packages).toHaveLength(1);
    expect(loaded.packages[0]?.name).toBe('valid-ext');

    const merged = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'workspace-ext', descriptorSource: 'workspace-descriptors', packages: loaded.packages },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('valid-ext');
  });

  it('pipeline with descriptor-source name collision keeps higher-priority source and boot continues', async () => {
    const discovery = new ExplicitDescriptorDiscovery([makeDiscovered('shared-name')]);

    const discovered = await discovery.discover();

    const loaded = await loadExtensions(discovered, {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makePackage('shared-name') }),
    });

    expect(loaded.packages).toHaveLength(1);

    const merged = mergePackagesByDescriptorSourcePriority([
      { descriptorName: 'shared-name', descriptorSource: 'workspace-descriptors', packages: loaded.packages },
      {
        descriptorName: 'shared-name',
        descriptorSource: 'lower-priority-descriptors',
        packages: [makePackage('shared-name')],
      },
    ]);

    expect(merged).toStrictEqual(loaded.packages);
  });
});
