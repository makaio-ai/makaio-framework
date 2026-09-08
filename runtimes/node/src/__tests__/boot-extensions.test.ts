/**
 * Tests for extension wiring in the boot sequence.
 *
 * These tests cover:
 * - resolveExtensionOptions correctly handles extensions
 * - Descriptor-source priority wins on package name collision
 * - Extension with incompatible framework range is skipped
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
import {
  ToolSubjects,
  WorkerNamespace,
  WorkerSubjects,
  type ProviderAllocationRef,
  type WorkerDispatch,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { ExecutionAttemptAuthority, workflowAttemptOutcomeCodec } from '@makaio/subsystem-workflow-engine';
import { createInMemoryAttemptRepository } from '@makaio/subsystem-workflow-engine/testing';
import type { DiscoveredExtension } from '../extension-discovery.js';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import { ExplicitDescriptorDiscovery, FilesystemDescriptorDiscovery } from '../extension-discovery.js';
import { loadExtensions, mergePackagesByDescriptorSourcePriority } from '../load-extensions.js';
import type { CoreBootOptions } from '../boot.js';
import {
  buildLocalBusUrl,
  filterConfigDefaultsForLoadedPackages,
  registerExtensionBootContributions,
  selectFrameworkCorePackages,
} from '../boot.js';
import { createNodeWorkflowRunner } from '../workflow-worker/index.js';
import { WorkerRunner } from '../workflow-worker/worker-runner.js';
import { InProcessWorkflowRunner } from '../workflow-worker/in-process-workflow-runner.js';
import { resolveExtensionOptions } from '../resolve-extension-options.js';
import { loadBootExtensions } from '../boot-extension-loading.js';
import {
  type BootExtensionEligibilityOptions,
  buildRuntimeEnvironment,
  selectBootEligibleExtensionPackages,
  selectEligibleAutomationCronSchedulerHostPackages,
} from '../boot-extension-selection.js';
import {
  artifactSchemaRegistryPackage,
  createToolContributionProcessor,
  SessionOrchestratorToken,
  toolRegistryPackage,
} from '@makaio/services-core';
import {
  AutomationCronSchedulerToken,
  localAutomationCronSchedulerPackage,
  selectAutomationCronSchedulerPackage,
} from '@makaio/services-core/automation-trigger';
import {
  artifactViewBuilderRegistryPackage,
  artifactViewServicePackage,
  ArtifactViewBuilderRegistryToken,
  createArtifactViewBuilderContributionProcessor,
} from '@makaio/services-core/materialization';
import type { ArtifactViewBuilder, ExtensionArtifactViewBuildersContribution } from '@makaio/contracts';
import { filesystemPackage } from '@makaio/extension-filesystem';
import { shellPackage } from '@makaio/extension-shell';
import { subagentPackage } from '@makaio/extension-subagent';
import { createAppendEffect } from '@makaio/contracts/client';
import type { ExtensionClientHookResponsesContribution } from '@makaio/contracts/client';
import { ClientsCoreToken, createClientsCorePackage } from '@makaio/subsystem-client';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRAMEWORK_VERSION = '3.0.0';

const TEST_ALLOCATION_REF: ProviderAllocationRef = {
  version: 1,
  providerId: 'test-provider',
  providerData: {},
};

let fixtureRoot: string | undefined;

/**
 * Build a minimal valid {@link KernelMakaioExtension}.
 * @param name - Package name.
 */
const makePackage = (name: string): KernelMakaioExtension => ({
  name,
  displayName: `${name} Display`,
  version: '0.1.0',
});

/**
 * Build a minimal valid {@link DiscoveredExtension}.
 * @param name - Extension name used in the descriptor.
 * @param frameworkRange - Framework semver range required. Defaults to `'>=1.0.0'`.
 */
const makeDiscovered = (name: string, frameworkRange = '>=1.0.0'): DiscoveredExtension => ({
  descriptor: {
    name,
    displayName: `${name} Display`,
    version: '1.0.0',
    makaio: { framework: frameworkRange },
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

/**
 * Create a coordinator wired with the artifact view builder contribution path.
 * @param extension - Extension contributing artifact view builders.
 * @returns The configured coordinator.
 */
function setupArtifactViewBuilderCoordinator(extension: KernelMakaioExtension): ExtensionCoordinator {
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

  coordinator.load([
    artifactSchemaRegistryPackage,
    artifactViewBuilderRegistryPackage,
    artifactViewServicePackage,
    extension,
  ]);
  coordinator.registerContributionProcessor(createArtifactViewBuilderContributionProcessor());
  return coordinator;
}

/**
 * Create a minimal workflow worker config for runner composition tests.
 * @returns A valid workflow worker config fixture.
 */
function makeWorkerConfig(): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'workflow-1' },
    definition: {
      id: 'workflow-1',
      name: 'Test workflow',
      root: { id: 'root', type: 'sequence', nodes: [] },
      scope: { type: 'global' },
    },
    executionId: 'wfx-1',
    workflowId: 'workflow-1',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
    suspensionStrategy: 'wait-in-process',
  };
}

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
    const owner: KernelMakaioExtension = {
      ...makePackage('host-runtime'),
      runtimeOwnership: { sessionOrchestrator: true },
    };

    const selected = selectFrameworkCorePackages([owner]);

    expect(selected.map((pkg) => pkg.name)).not.toContain(SessionOrchestratorToken.name);
  });

  it('fails when multiple loaded extensions own the session orchestrator', () => {
    const firstOwner: KernelMakaioExtension = {
      ...makePackage('first-runtime'),
      runtimeOwnership: { sessionOrchestrator: true },
    };
    const secondOwner: KernelMakaioExtension = {
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

    const packages: KernelMakaioExtension[] = [
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
// Artifact view builder contribution extensibility
// ---------------------------------------------------------------------------

describe('artifact view builder contribution extensibility', () => {
  it('activates and replaces builder contributions through the coordinator', async () => {
    const testBuilder: ArtifactViewBuilder = {
      kind: 'test-review',
      schemaVersion: 1,
      version: 1,
      build: async () => undefined,
    };
    const contribution: ExtensionArtifactViewBuildersContribution = {
      createBuilders: () => [testBuilder],
    };
    const extensionWithBuilders: KernelMakaioExtension = {
      ...makePackage('test-builder-ext'),
      artifactViewBuilders: contribution,
    };
    const coordinator = setupArtifactViewBuilderCoordinator(extensionWithBuilders);

    try {
      await coordinator.startAll();

      // Verify the builder is registered
      const registry = coordinator.getExtensionService(ArtifactViewBuilderRegistryToken);
      expect(registry).toBeDefined();
      const builder = registry!.getBuilder('test-review', 1);
      expect(builder).toBeDefined();
      expect(builder!.version).toBe(1);

      // Disable the extension and verify the builder is removed
      await coordinator.handleSetEnabled('test-builder-ext', false);
      expect(registry!.getBuilder('test-review', 1)).toBeUndefined();
    } finally {
      await coordinator.shutdown();
    }
  });

  it('replaces builder set on extension reactivation', async () => {
    let builderVersion = 1;
    const contribution: ExtensionArtifactViewBuildersContribution = {
      createBuilders: () => [
        {
          kind: 'test-review',
          schemaVersion: 1,
          version: builderVersion,
          build: async () => undefined,
        },
      ],
    };
    const extensionWithBuilders: KernelMakaioExtension = {
      ...makePackage('test-builder-ext'),
      artifactViewBuilders: contribution,
    };
    const coordinator = setupArtifactViewBuilderCoordinator(extensionWithBuilders);

    try {
      await coordinator.startAll();

      const registry = coordinator.getExtensionService(ArtifactViewBuilderRegistryToken);
      expect(registry!.getBuilder('test-review', 1)!.version).toBe(1);

      // Disable and re-enable the extension with a new version
      builderVersion = 2;
      await coordinator.handleSetEnabled('test-builder-ext', false);
      expect(registry!.getBuilder('test-review', 1)).toBeUndefined();

      await coordinator.handleSetEnabled('test-builder-ext', true);
      expect(registry!.getBuilder('test-review', 1)!.version).toBe(2);
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
    expect(result.packages[0]).toEqual(pkg);
  });

  it('skips an extension whose framework range excludes the framework version', async () => {
    const discovery = new ExplicitDescriptorDiscovery([makeDiscovered('version-gated-ext', '>=99.0.0')]);
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

  it('preserves descriptor host cron scheduler candidates through boot extension loading', async () => {
    const schedulerPackage = makePackage(AutomationCronSchedulerToken.name);
    const serverPackage = makePackage('my-ext');
    const extension = makeDiscovered('my-ext');
    if (extension.descriptor.execution === 'detached') {
      throw new Error('Expected embedded extension fixture');
    }
    fs.writeFileSync(path.join(extension.extensionPath, 'dist', 'browser.mjs'), 'export default {};\n');
    fs.writeFileSync(
      path.join(extension.extensionPath, 'dist', 'cli.mjs'),
      "export default { name: 'my-ext', description: 'Test CLI', subcommands: [], interactive: async () => undefined };\n",
    );
    const discovered: DiscoveredExtension = {
      ...extension,
      descriptor: {
        ...extension.descriptor,
        entrypoints: { server: true as const, browser: true as const, cli: true as const },
      },
      preloadedModule: {
        default: serverPackage,
        automationCronSchedulerHostPolicy: {
          ownerPackageName: 'my-ext',
          package: schedulerPackage,
        },
      },
    };

    const result = await loadBootExtensions({
      extensionOptions: resolveExtensionOptions(
        minimalBootOptions({ discovery: new ExplicitDescriptorDiscovery([discovered]) }),
        TEST_MAKAIO_HOME,
      ),
      skipExtensions: new Set(),
      frameworkVersion: FRAMEWORK_VERSION,
    });

    expect(result.extensionLoadResult.automationCronSchedulerHostPolicies).toHaveLength(1);
    expect(result.extensionLoadResult.automationCronSchedulerHostPolicies[0]).toMatchObject({
      package: schedulerPackage,
    });
    expect(result.extensionLoadResult.automationCronSchedulerHostPolicies[0]?.ownerPackage).toBe(serverPackage);
    expect(result.allExtensionPackages[0]).not.toBe(serverPackage);
    expect(result.allExtensionPackages.map(({ name }) => name)).toEqual(['my-ext']);
    expect(
      selectEligibleAutomationCronSchedulerHostPackages(
        result.extensionLoadResult.automationCronSchedulerHostPolicies,
        {
          packages: result.allExtensionPackages,
          configProvider: undefined,
          surface: 'headless',
          runtimeEnvironment: buildRuntimeEnvironment('linux', ['node']),
        },
      ),
    ).toEqual([schedulerPackage]);
  });

  it('drops a server child policy when later browser composition replaces its owner', async () => {
    const schedulerPackage = makePackage(AutomationCronSchedulerToken.name);
    const serverChild = makePackage('example.parent.child');
    const server = {
      ...makeDiscovered('example.parent'),
      preloadedModule: {
        default: [makePackage('example.parent'), serverChild],
        automationCronSchedulerHostPolicy: {
          ownerPackageName: serverChild.name,
          package: schedulerPackage,
        },
      },
    };
    const browserChildRoot = createExtensionRoot(serverChild.name);
    fs.writeFileSync(path.join(browserChildRoot, 'dist', 'browser.mjs'), 'export default {};\n');
    const browserChild: DiscoveredExtension = {
      ...makeDiscovered(serverChild.name),
      descriptor: {
        name: serverChild.name,
        displayName: `${serverChild.name} Display`,
        version: '1.0.0',
        makaio: { framework: '>=1.0.0' },
        entrypoints: { browser: true },
      },
      extensionPath: browserChildRoot,
    };

    const result = await loadBootExtensions({
      extensionOptions: resolveExtensionOptions(
        minimalBootOptions({ discovery: new ExplicitDescriptorDiscovery([server, browserChild]) }),
        TEST_MAKAIO_HOME,
      ),
      skipExtensions: new Set(),
      frameworkVersion: FRAMEWORK_VERSION,
    });
    const eligibility: BootExtensionEligibilityOptions = {
      packages: result.allExtensionPackages,
      configProvider: undefined,
      surface: 'headless',
      runtimeEnvironment: buildRuntimeEnvironment('linux', ['node']),
    };

    expect(result.allExtensionPackages.find(({ name }) => name === serverChild.name)).not.toBe(serverChild);
    expect(
      selectEligibleAutomationCronSchedulerHostPackages(
        result.extensionLoadResult.automationCronSchedulerHostPolicies,
        eligibility,
      ),
    ).toEqual([]);
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
          makaio: { framework: '>=1.0.0' },
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

describe('owner-anchored automation cron scheduler host policy', () => {
  const scheduler = (displayName: string): KernelMakaioExtension => ({
    ...makePackage(AutomationCronSchedulerToken.name),
    displayName,
  });
  const owner = (name: string): KernelMakaioExtension => ({ ...makePackage(name), surface: 'headless' });
  const environment = buildRuntimeEnvironment('linux', ['node']);

  function selectForBoot(options: {
    packages: KernelMakaioExtension[];
    policies: Array<{ ownerPackage: KernelMakaioExtension; package: KernelMakaioExtension }>;
    surface?: 'headless' | 'interactive';
    disabled?: ReadonlySet<string>;
  }): KernelMakaioExtension | undefined {
    const disabled = options.disabled;
    const eligibility: BootExtensionEligibilityOptions = {
      packages: options.packages,
      configProvider: disabled
        ? {
            loadConfig: () => undefined,
            loadEnabled: (name) => !disabled.has(name),
          }
        : undefined,
      surface: options.surface ?? 'headless',
      runtimeEnvironment: environment,
    };
    return selectAutomationCronSchedulerPackage({
      hostPackages: [...selectEligibleAutomationCronSchedulerHostPackages(options.policies, eligibility)],
      loadedPackages: selectBootEligibleExtensionPackages(eligibility),
    });
  }

  it('falls back to the local scheduler when the policy owner is disabled', () => {
    const relayOwner = owner('example.relay');
    expect(
      selectForBoot({
        packages: [relayOwner],
        policies: [{ ownerPackage: relayOwner, package: scheduler('Relay Scheduler') }],
        disabled: new Set([relayOwner.name]),
      }),
    ).toBe(localAutomationCronSchedulerPackage);
  });

  it('falls back to the local scheduler when a headless policy owner is ineligible on an interactive surface', () => {
    const relayOwner = owner('example.relay');
    expect(
      selectForBoot({
        packages: [relayOwner],
        policies: [{ ownerPackage: relayOwner, package: scheduler('Relay Scheduler') }],
        surface: 'interactive',
      }),
    ).toBe(localAutomationCronSchedulerPackage);
  });

  it('selects the contributed scheduler while its exact owner is eligible', () => {
    const relayOwner = owner('example.relay');
    const relayScheduler = scheduler('Relay Scheduler');
    expect(
      selectForBoot({
        packages: [relayOwner],
        policies: [{ ownerPackage: relayOwner, package: relayScheduler }],
      }),
    ).toBe(relayScheduler);
  });

  it('falls back to the local scheduler when a later server package replaces the policy owner by name', () => {
    const oldOwner = owner('example.relay');
    const replacementOwner = owner('example.relay');

    expect(
      selectForBoot({
        packages: [oldOwner, replacementOwner],
        policies: [{ ownerPackage: oldOwner, package: scheduler('Old Relay Scheduler') }],
      }),
    ).toBe(localAutomationCronSchedulerPackage);
  });

  it('selects the later policy when a later server package replaces the policy owner by name', () => {
    const oldOwner = owner('example.relay');
    const replacementOwner = owner('example.relay');
    const replacementScheduler = scheduler('Replacement Relay Scheduler');

    expect(
      selectForBoot({
        packages: [oldOwner, replacementOwner],
        policies: [
          { ownerPackage: oldOwner, package: scheduler('Old Relay Scheduler') },
          { ownerPackage: replacementOwner, package: replacementScheduler },
        ],
      }),
    ).toBe(replacementScheduler);
  });

  it('ignores an ineligible competing policy', () => {
    const relayOwner = owner('example.relay');
    const disabledOwner = owner('example.disabled-relay');
    const relayScheduler = scheduler('Relay Scheduler');
    expect(
      selectForBoot({
        packages: [relayOwner, disabledOwner],
        policies: [
          { ownerPackage: relayOwner, package: relayScheduler },
          { ownerPackage: disabledOwner, package: scheduler('Disabled Scheduler') },
        ],
        disabled: new Set([disabledOwner.name]),
      }),
    ).toBe(relayScheduler);
  });

  it('rejects duplicate policies when both owners are eligible', () => {
    const firstOwner = owner('example.first-relay');
    const secondOwner = owner('example.second-relay');
    expect(() =>
      selectForBoot({
        packages: [firstOwner, secondOwner],
        policies: [
          { ownerPackage: firstOwner, package: scheduler('First Scheduler') },
          { ownerPackage: secondOwner, package: scheduler('Second Scheduler') },
        ],
      }),
    ).toThrow(/Multiple automation cron scheduler providers/);
  });
});

// ---------------------------------------------------------------------------
// Workflow-level runner boot composition
// ---------------------------------------------------------------------------

describe('workflow-level runner boot composition', () => {
  // These tests verify runner wiring, not repository behavior.
  const stubAuthority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowAttemptOutcomeCodec), {
    bootstrapTimeoutMs: 60_000,
  });

  it('returns undefined when no runner is configured', () => {
    const runner = createNodeWorkflowRunner({
      moduleDir: '/runtime/src',
      defaultWorkerEntryMode: 'source',
    });

    expect(runner).toBeUndefined();
  });

  it('creates an InProcessWorkflowRunner for in-process mode when a bus is provided', () => {
    const bus = createBusInstance();
    const runner = createNodeWorkflowRunner({
      moduleDir: '/runtime/src',
      defaultWorkerEntryMode: 'source',
      runner: { mode: 'in-process' },
      bus,
    });

    expect(runner).toBeInstanceOf(InProcessWorkflowRunner);
  });

  it('creates a WorkerRunner for worker mode', () => {
    const dispatch = vi.fn();
    const runner = createNodeWorkflowRunner({
      moduleDir: '/runtime/src',
      defaultWorkerEntryMode: 'source',
      runner: {
        mode: 'worker',
        dispatch,
        manifest: { contributionRefs: [] },
      },
      authority: stubAuthority,
    });

    expect(runner).toBeInstanceOf(WorkerRunner);
  });

  it('creates a WorkerRunner with optional requirements forwarded', () => {
    const dispatch = vi.fn();
    const runner = createNodeWorkflowRunner({
      moduleDir: '/runtime/src',
      defaultWorkerEntryMode: 'source',
      runner: {
        mode: 'worker',
        dispatch,
        manifest: { contributionRefs: [] },
        requirements: { persistentStorage: true, customCapabilities: [] },
      },
      authority: stubAuthority,
    });

    expect(runner).toBeInstanceOf(WorkerRunner);
  });

  it('creates a bus-backed WorkerRunner when worker mode omits dispatch', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    let capturedConfig: unknown;
    const cleanup = bus.on(WorkerSubjects.dispatch, (ctx) => {
      capturedConfig = ctx.payload.config;
      const result = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed' as const,
      };
      // Commit the outcome through the Authority so the runner's
      // outcomePromise settles, mirroring real worker behavior.
      void stubAuthority
        .commitOutcome(
          ctx.payload.executionAttemptId,
          ctx.payload.config.executionId,
          stubAuthority.canonicalizeOutcome(result),
        )
        .then((decision) => stubAuthority.settleOutcome(ctx.payload.executionAttemptId, decision));
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });
    const runner = createNodeWorkflowRunner({
      moduleDir: '/runtime/src',
      defaultWorkerEntryMode: 'source',
      runner: { mode: 'worker' },
      bus,
      authority: stubAuthority,
    });

    try {
      if (runner === undefined) {
        throw new Error('Expected worker runner');
      }
      const config = makeWorkerConfig();
      const completion = await runner.run(config, new AbortController().signal);

      expect(runner).toBeInstanceOf(WorkerRunner);
      expect(completion.result.status).toBe('completed');
      expect(capturedConfig).toEqual({ ...config, terminalAuthority: 'authority' });
    } finally {
      cleanup();
    }
  });

  it('preserves omitted manifests for worker mode', async () => {
    let capturedRequest: Parameters<WorkerDispatch>[0] | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedRequest = request;
      const result = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed' as const,
      };
      // Commit the outcome through the Authority so the runner's
      // outcomePromise settles, mirroring real worker behavior.
      const decision = await stubAuthority.commitOutcome(
        request.executionAttemptId,
        request.config.executionId,
        stubAuthority.canonicalizeOutcome(result),
      );
      stubAuthority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = createNodeWorkflowRunner({
      moduleDir: '/runtime/src',
      defaultWorkerEntryMode: 'source',
      runner: {
        mode: 'worker',
        dispatch,
      },
      authority: stubAuthority,
    });
    const signal = new AbortController().signal;

    if (runner === undefined) {
      throw new Error('Expected worker runner');
    }
    expect(runner).toBeInstanceOf(WorkerRunner);
    await runner.run(makeWorkerConfig(), signal);

    if (capturedRequest === undefined) {
      throw new Error('Expected dispatch request');
    }
    expect('manifest' in capturedRequest).toBe(false);
  });

  it('creates an InProcessWorkflowRunner when runner mode is omitted but a runner object is present', () => {
    const bus = createBusInstance();
    const runner = createNodeWorkflowRunner({
      moduleDir: '/runtime/src',
      defaultWorkerEntryMode: 'source',
      runner: {},
      bus,
    });

    expect(runner).toBeInstanceOf(InProcessWorkflowRunner);
  });

  it('throws when in-process mode is configured but no bus is provided', () => {
    expect(() =>
      createNodeWorkflowRunner({
        moduleDir: '/runtime/src',
        defaultWorkerEntryMode: 'source',
        runner: { mode: 'in-process' },
        // bus intentionally omitted
      }),
    ).toThrow(/InProcessWorkflowRunner requires a bus instance/i);
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
      makeDiscovered('valid-ext', '>=1.0.0'),
      makeDiscovered('gated-ext', '>=99.0.0'),
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

// ---------------------------------------------------------------------------
// createMount seam threading through loadBootExtensions
// ---------------------------------------------------------------------------

describe('loadBootExtensions createMount seam', () => {
  let testFixtureRoot: string | undefined;

  beforeEach(() => {
    testFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-boot-createMount-'));
  });

  afterEach(() => {
    if (testFixtureRoot !== undefined) {
      fs.rmSync(testFixtureRoot, { recursive: true, force: true });
      testFixtureRoot = undefined;
    }
  });

  /**
   * Create an {@link ExplicitDescriptorDiscovery} with a single browser-only
   * extension that has a real browser bundle on disk.
   * @param options - Extension fixture options: `name` (extension name) and
   *   `browserEntrypoint` (browser entry stem, e.g. `'browser/index'`).
   * @returns Discovery instance ready for use in boot options.
   */
  function createDiscoveryWithBrowserOnlyExtension(options: {
    name: string;
    browserEntrypoint: string;
  }): ExplicitDescriptorDiscovery {
    const extensionPath = fs.mkdtempSync(path.join(testFixtureRoot!, `${options.name}-`));
    const stem = options.browserEntrypoint;
    const bundlePath = path.join(extensionPath, 'dist', `${stem}.mjs`);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, 'export default {};\n');

    const discovered: DiscoveredExtension = {
      descriptor: {
        name: options.name,
        displayName: `${options.name} Display`,
        version: '1.0.0',
        makaio: { framework: '>=0.1.0' },
        entrypoints: { browser: options.browserEntrypoint },
      },
      extensionPath,
      source: 'local',
    };

    return new ExplicitDescriptorDiscovery([discovered]);
  }

  it('threads createMount into browser extension package synthesis', async () => {
    const mount = vi.fn();
    const createMount = vi.fn(() => mount);
    const options = minimalBootOptions({
      createMount,
      discovery: createDiscoveryWithBrowserOnlyExtension({
        name: 'browser-only-dashboard',
        browserEntrypoint: 'browser/index',
      }),
    });

    const resolved = resolveExtensionOptions(options, TEST_MAKAIO_HOME);
    const result = await loadBootExtensions({
      extensionOptions: resolved,
      skipExtensions: new Set(),
      frameworkVersion: '0.1.0',
      createMount: options.createMount,
    });

    const pkg = result.allExtensionPackages.find((entry) => entry.name === 'browser-only-dashboard');
    expect(pkg?.http?.prefix).toBe('/extensions/browser-only-dashboard/browser');
    expect(createMount).toHaveBeenCalledWith(
      expect.stringContaining('browser'),
      '/extensions/browser-only-dashboard/browser',
    );
    expect(pkg?.http?.mount).toBe(mount);
  });
});

// ---------------------------------------------------------------------------
// Client hook response contribution extensibility via coordinator
// ---------------------------------------------------------------------------

describe('client hook response contribution extensibility', () => {
  /**
   * Create a coordinator wired with the clients-core package and the Claude
   * Code provider contract, ready for testing hook response contributions.
   * @param extension - Extension contributing hook response callbacks.
   * @returns The configured coordinator.
   */
  function setupHookResponseCoordinator(extension: KernelMakaioExtension): ExtensionCoordinator {
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

    // Create the clients-core package — its runtimeBoot.configure
    // registers the contribution processor.
    const clientsCorePackage = createClientsCorePackage();
    coordinator.load([clientsCorePackage, extension]);

    // Register the contribution processor via the boot wiring path.
    // In production this is done by registerExtensionBootContributions(),
    // but here we call runtimeBoot.configure directly to test the
    // contribution processor registration without full boot.
    registerExtensionBootContributions([clientsCorePackage], bus, coordinator);

    return coordinator;
  }

  it('activates an external extension contributing canonical context.append via the coordinator', async () => {
    const contribution: ExtensionClientHookResponsesContribution = {
      createContributors: () => [
        {
          lane: 'canonical',
          id: 'coordinator-ctx-appender',
          priority: 100,
          timeoutMs: 5000,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => ({
            canonicalEffects: [createAppendEffect('Contributed through coordinator')],
          }),
        },
      ],
    };
    const extensionWithHookResponses: KernelMakaioExtension = {
      ...makePackage('test-hook-ext'),
      clientHookResponses: contribution,
    };
    const coordinator = setupHookResponseCoordinator(extensionWithHookResponses);

    try {
      await coordinator.startAll();

      // Verify the contributor was installed via the clients-core service
      const clientsCore = coordinator.getExtensionService(ClientsCoreToken);
      expect(clientsCore).toBeDefined();
      const snapshot = clientsCore!.hookResponseRegistry.snapshot(
        'claude-code',
        'claude-code.tool-response',
        'PreToolUse',
        [],
      );
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].namespacedId).toBe('test-hook-ext/coordinator-ctx-appender');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('removes contributors when the extension is disabled via the coordinator', async () => {
    const contribution: ExtensionClientHookResponsesContribution = {
      createContributors: () => [
        {
          lane: 'canonical',
          id: 'disable-test',
          priority: 100,
          timeoutMs: 5000,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => undefined,
        },
      ],
    };
    const extensionWithHookResponses: KernelMakaioExtension = {
      ...makePackage('test-disable-ext'),
      clientHookResponses: contribution,
    };
    const coordinator = setupHookResponseCoordinator(extensionWithHookResponses);

    try {
      await coordinator.startAll();

      const clientsCore = coordinator.getExtensionService(ClientsCoreToken);
      expect(clientsCore).toBeDefined();
      expect(
        clientsCore!.hookResponseRegistry.snapshot('claude-code', 'claude-code.tool-response', 'PreToolUse', []),
      ).toHaveLength(1);

      // Disable the extension
      await coordinator.handleSetEnabled('test-disable-ext', false);
      expect(
        clientsCore!.hookResponseRegistry.snapshot('claude-code', 'claude-code.tool-response', 'PreToolUse', []),
      ).toHaveLength(0);
    } finally {
      await coordinator.shutdown();
    }
  });

  it('re-enables an extension with a fresh contributor batch', async () => {
    let activationCount = 0;
    const contribution: ExtensionClientHookResponsesContribution = {
      createContributors: () => {
        activationCount += 1;
        return [
          {
            lane: 'canonical',
            id: 'reenable-test',
            priority: 100,
            timeoutMs: 5000,
            selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
            respond: () => ({
              canonicalEffects: [createAppendEffect(`activation-${String(activationCount)}`)],
            }),
          },
        ];
      },
    };
    const extensionWithHookResponses: KernelMakaioExtension = {
      ...makePackage('test-reenable-ext'),
      clientHookResponses: contribution,
    };
    const coordinator = setupHookResponseCoordinator(extensionWithHookResponses);

    try {
      await coordinator.startAll();

      const clientsCore = coordinator.getExtensionService(ClientsCoreToken);
      expect(clientsCore).toBeDefined();
      expect(
        clientsCore!.hookResponseRegistry.snapshot('claude-code', 'claude-code.tool-response', 'PreToolUse', []),
      ).toHaveLength(1);
      expect(activationCount).toBe(1);

      // Disable and re-enable
      await coordinator.handleSetEnabled('test-reenable-ext', false);
      expect(
        clientsCore!.hookResponseRegistry.snapshot('claude-code', 'claude-code.tool-response', 'PreToolUse', []),
      ).toHaveLength(0);

      await coordinator.handleSetEnabled('test-reenable-ext', true);
      const snapshot = clientsCore!.hookResponseRegistry.snapshot(
        'claude-code',
        'claude-code.tool-response',
        'PreToolUse',
        [],
      );
      expect(snapshot).toHaveLength(1);
      expect(activationCount).toBe(2);
    } finally {
      await coordinator.shutdown();
    }
  });
});
