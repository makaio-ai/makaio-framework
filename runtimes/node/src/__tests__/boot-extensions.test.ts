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
import { createInMemoryAttemptRepository, requireCommittedOutcome } from '@makaio/subsystem-workflow-engine/testing';
import type { DiscoveredExtension } from '../extension-discovery.js';
import { ExtensionCoordinator, type ExtensionRuntimeSurface, type KernelMakaioExtension } from '@makaio/kernel';
import { ExplicitDescriptorDiscovery, FilesystemDescriptorDiscovery } from '../extension-discovery.js';
import { loadExtensions, mergePackagesByDescriptorSourcePriority } from '../load-extensions.js';
import type { CoreBootOptions } from '../boot.js';
import {
  buildLocalBusUrl,
  filterConfigDefaultsForLoadedPackages,
  mergePackageConfigDefaults,
  registerExtensionBootContributions,
  selectFrameworkCorePackages,
} from '../boot.js';
import { isExtensionEnabled } from '../extension-enablement-store.js';
import { createNodeWorkflowRunner } from '../workflow-worker/index.js';
import { WorkerRunner } from '../workflow-worker/worker-runner.js';
import { InProcessWorkflowRunner } from '../workflow-worker/in-process-workflow-runner.js';
import { resolveExtensionOptions } from '../resolve-extension-options.js';
import { loadBootExtensions } from '../boot-extension-loading.js';
import {
  type BootExtensionEligibilityOptions,
  buildRuntimeEnvironment,
  closeEffectiveEnabledBootPackages,
  composeBootExtensionSelection,
  excludeIneffectiveCoreNameOverrides,
  selectBootEligibleExtensionPackages,
  selectEligibleAutomationCronSchedulerHostPackages,
  selectExtensionManagedEnabledPackages,
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
import { dep, type ArtifactViewBuilder, type ExtensionArtifactViewBuildersContribution } from '@makaio/contracts';
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const filtered = filterConfigDefaultsForLoadedPackages(
        new Map([
          ['workspace-ext', { mode: 'local' }],
          ['loaded-descriptor-ext', { retries: 3 }],
          ['skipped-descriptor-ext', { retries: 9 }],
          ['misspelled-ext', { retries: 1 }],
        ]),
        new Set(['workspace-ext', 'loaded-descriptor-ext']),
      );

      expect(filtered).toStrictEqual(
        new Map([
          ['workspace-ext', { mode: 'local' }],
          ['loaded-descriptor-ext', { retries: 3 }],
        ]),
      );
      // One diagnostic for the whole pass, naming every dropped package, so a
      // default an operator believes is in effect is never discarded silently.
      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([
        '[boot] Package config defaults have no loaded package and were dropped: skipped-descriptor-ext, misspelled-ext',
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('flattens control characters in a dropped package name before putting it in a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      filterConfigDefaultsForLoadedPackages(new Map([['rogue\u0007ext\nname', { mode: 'local' }]]), new Set());

      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([
        '[boot] Package config defaults have no loaded package and were dropped: rogue ext name',
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when every default has a loaded package', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      filterConfigDefaultsForLoadedPackages(
        new Map([['workspace-ext', { mode: 'local' }]]),
        new Set(['workspace-ext']),
      );

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('mergePackageConfigDefaults', () => {
  it('merges per-package keys instead of replacing whole records', () => {
    const merged = mergePackageConfigDefaults(
      new Map([['gateway', { port: 6299, label: 'descriptor' }]]),
      new Map([['gateway', { label: 'config-file' }]]),
    );

    expect(merged).toStrictEqual(new Map([['gateway', { port: 6299, label: 'config-file' }]]));
  });

  it('treats an absent layer as contributing nothing', () => {
    const merged = mergePackageConfigDefaults(undefined, new Map([['gateway', { port: 1 }]]), undefined);

    expect(merged).toStrictEqual(new Map([['gateway', { port: 1 }]]));
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

  it('keeps the framework session orchestrator when a package declares the field as false', () => {
    // `runtimeOwnership: { sessionOrchestrator: false }` declares the field
    // but claims no ownership. The boot-time owner selector must treat this
    // the same as an absent field (only `=== true` is a claim), the same
    // field-level rule `isRuntimeOwnershipFieldClaimed` encodes in one place.
    const nonOwner: KernelMakaioExtension = {
      ...makePackage('non-owner-runtime'),
      runtimeOwnership: { sessionOrchestrator: false },
    };

    const selected = selectFrameworkCorePackages([nonOwner]);

    expect(selected.map((pkg) => pkg.name)).toContain(SessionOrchestratorToken.name);
  });
});

describe('closeEffectiveEnabledBootPackages', () => {
  it('excludes a preference-enabled package whose required dependency is disabled', () => {
    const requiredDep = makePackage('provider-a');
    const dependent: KernelMakaioExtension = {
      ...makePackage('feature-b'),
      dependencies: [dep('provider-a')],
    };
    // `provider-a` was disabled by preference, so it never made it into the
    // preference-enabled set handed to the closure — only `feature-b` did.
    const preferenceEnabled = [dependent];
    const bootEligible = [requiredDep, dependent];

    const closed = closeEffectiveEnabledBootPackages(preferenceEnabled, bootEligible);

    expect(closed.map((pkg) => pkg.name)).toStrictEqual([]);
  });

  it('keeps a preference-enabled package whose required dependency is also enabled', () => {
    const requiredDep = makePackage('provider-a');
    const dependent: KernelMakaioExtension = {
      ...makePackage('feature-b'),
      dependencies: [dep('provider-a')],
    };
    const preferenceEnabled = [requiredDep, dependent];
    const bootEligible = [requiredDep, dependent];

    const closed = closeEffectiveEnabledBootPackages(preferenceEnabled, bootEligible);

    expect(closed.map((pkg) => pkg.name)).toStrictEqual(['provider-a', 'feature-b']);
  });

  it('keeps a preference-enabled package whose dependency is only optional and disabled', () => {
    const dependent: KernelMakaioExtension = {
      ...makePackage('feature-b'),
      dependencies: [dep('provider-a', undefined, true)],
    };
    // `provider-a` is disabled (absent from the preference-enabled set) but the
    // dependency is optional, so `feature-b` must still be able to start.
    const preferenceEnabled = [dependent];
    const bootEligible = [makePackage('provider-a'), dependent];

    const closed = closeEffectiveEnabledBootPackages(preferenceEnabled, bootEligible);

    expect(closed.map((pkg) => pkg.name)).toStrictEqual(['feature-b']);
  });

  it('treats a dependency on a framework package name as always satisfied', () => {
    // `makaio.clients-core` is not part of the descriptor-backed extension
    // pool (`bootEligibleExtensionPackages`); it is a framework package that
    // loads unconditionally, so a dependency on it must never exclude the
    // dependent extension.
    const dependent: KernelMakaioExtension = {
      ...makePackage('feature-b'),
      dependencies: [dep('makaio.clients-core')],
    };
    const preferenceEnabled = [dependent];
    const bootEligible = [dependent];

    const closed = closeEffectiveEnabledBootPackages(preferenceEnabled, bootEligible);

    expect(closed.map((pkg) => pkg.name)).toStrictEqual(['feature-b']);
  });

  it('transitively excludes an entire dependency chain when its root is disabled', () => {
    // A (disabled) <- B (enabled) <- C (enabled). Disabling A must also drop
    // B and C even though B and C were themselves preference-enabled,
    // because neither will ever reach `active` without A.
    const pkgA = makePackage('pkg-a');
    const pkgB: KernelMakaioExtension = { ...makePackage('pkg-b'), dependencies: [dep('pkg-a')] };
    const pkgC: KernelMakaioExtension = { ...makePackage('pkg-c'), dependencies: [dep('pkg-b')] };
    const bootEligible = [pkgA, pkgB, pkgC];
    // pkgA is absent: disabled by preference.
    const preferenceEnabled = [pkgB, pkgC];

    const closed = closeEffectiveEnabledBootPackages(preferenceEnabled, bootEligible);

    expect(closed.map((pkg) => pkg.name)).toStrictEqual([]);
  });

  it('excludes a critical package whose required dependency is disabled, matching the coordinator abort path', () => {
    // The critical override (isExtensionEnabled) already ran before this
    // function is called, so `criticalDependent` is in the preference-enabled
    // input despite the store disabling it. Its required dependency
    // `provider-a` is disabled and absent from the preference-enabled set.
    // The coordinator's startExtensionEntry() would fail this critical entry
    // and throw, aborting startAll() entirely (extension-start-runner.ts) —
    // this function must not contradict that by keeping the package in the
    // boot composition as if it will run.
    const criticalDependent: KernelMakaioExtension = {
      ...makePackage('critical-feature'),
      critical: true,
      dependencies: [dep('provider-a')],
    };
    const bootEligible = [makePackage('provider-a'), criticalDependent];
    const preferenceEnabled = [criticalDependent];

    const closed = closeEffectiveEnabledBootPackages(preferenceEnabled, bootEligible);

    expect(closed.map((pkg) => pkg.name)).toStrictEqual([]);
  });

  it('logs a diagnostic naming the disabled dependency for each excluded package', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const dependent: KernelMakaioExtension = {
        ...makePackage('feature-b'),
        dependencies: [dep('provider-a')],
      };
      closeEffectiveEnabledBootPackages([dependent], [makePackage('provider-a'), dependent]);

      expect(warnSpy).toHaveBeenCalledWith(
        '[boot] Excluding extension "%s" from boot composition: required dependency %s is disabled',
        'feature-b',
        'provider-a',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('excludeIneffectiveCoreNameOverrides', () => {
  it('excludes a disabled extension package that collides with a core package name and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const disabledOverride = makePackage('makaio.clients-core');
      const unrelatedExtension = makePackage('unrelated-ext');

      const result = excludeIneffectiveCoreNameOverrides(
        [disabledOverride, unrelatedExtension],
        new Set(['makaio.clients-core']),
        new Set(['unrelated-ext']),
      );

      expect(result).toStrictEqual([unrelatedExtension]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[boot] Excluding extension "%s": a disabled override would replace core package %s; ' +
          'the core package stays active; the override applies after enabling and restart',
        'makaio.clients-core',
        'makaio.clients-core',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps an enabled extension override that collides with a core package name', () => {
    const enabledOverride = makePackage('makaio.clients-core');

    const result = excludeIneffectiveCoreNameOverrides(
      [enabledOverride],
      new Set(['makaio.clients-core']),
      new Set(['makaio.clients-core']),
    );

    expect(result).toStrictEqual([enabledOverride]);
  });

  it('excludes an enabled override whose required dependency is disabled, since it is absent from effective-enabled', () => {
    // `effectiveEnabledPackageNames` is the dependency-closed set computed by
    // closeEffectiveEnabledBootPackages: an enabled override with a disabled
    // required dependency never reaches `active`, so it is already absent
    // from that set by the time this function runs — it must not displace
    // the core package either.
    const overrideWithDisabledDependency = makePackage('makaio.clients-core');

    const result = excludeIneffectiveCoreNameOverrides(
      [overrideWithDisabledDependency],
      new Set(['makaio.clients-core']),
      new Set(),
    );

    expect(result).toStrictEqual([]);
  });

  it('leaves non-colliding extension packages untouched regardless of enablement', () => {
    const disabledUnrelated = makePackage('disabled-unrelated-ext');

    const result = excludeIneffectiveCoreNameOverrides(
      [disabledUnrelated],
      new Set(['makaio.clients-core']),
      new Set(),
    );

    expect(result).toStrictEqual([disabledUnrelated]);
  });
});

describe('composeBootExtensionSelection', () => {
  /**
   * Build an enablement preference source that disables exactly the given names.
   * @param disabledNames - Package names to treat as disabled by preference.
   */
  const disabling = (disabledNames: ReadonlyArray<string>): { loadEnabled: (name: string) => boolean } => ({
    loadEnabled: (name) => !disabledNames.includes(name),
  });

  it('keeps a package whose only unmet dependency is a core-name-colliding, disabled extension override (P1)', () => {
    // Extension A ("makaio.clients-core") collides with a framework/core
    // package name and is disabled by preference. Extension B requires A by
    // name and is enabled. Stage 2 lets the retained core package win the
    // name collision; Stage 3 must then treat B's dependency on "A" as
    // satisfied by the retained core package, not by the dropped, disabled
    // override — the P1 finding this composition fixes.
    const disabledOverride = makePackage('makaio.clients-core');
    const dependentB: KernelMakaioExtension = {
      ...makePackage('feature-b'),
      dependencies: [dep('makaio.clients-core')],
    };
    const frameworkPackageNames = new Set(['makaio.clients-core']);

    const result = composeBootExtensionSelection({
      bootEligibleExtensionPackages: [disabledOverride, dependentB],
      configProvider: disabling(['makaio.clients-core']),
      frameworkPackageNames,
    });

    // Stage 2: the disabled override is dropped so the core package stays active.
    expect(result.mergeableExtensionPackages.map((pkg) => pkg.name)).toStrictEqual(['feature-b']);
    expect(result.extensionManagedPackageNames).toStrictEqual(new Set(['feature-b']));
    // Stage 3: B's clients, ownership claims, scheduler policy, and
    // runtimeBoot contribution all key off this set being non-empty for B.
    expect(result.effectiveEnabledBootPackages.map((pkg) => pkg.name)).toStrictEqual(['feature-b']);
    expect(result.effectiveEnabledPackageNames.has('feature-b')).toBe(true);
  });

  it('keeps a transitive dependent when the root dependency is a core-name-colliding, disabled override', () => {
    // A (disabled, collides with core) <- B (enabled, requires A) <- C (enabled, requires B).
    const disabledOverride = makePackage('makaio.clients-core');
    const pkgB: KernelMakaioExtension = { ...makePackage('pkg-b'), dependencies: [dep('makaio.clients-core')] };
    const pkgC: KernelMakaioExtension = { ...makePackage('pkg-c'), dependencies: [dep('pkg-b')] };
    const frameworkPackageNames = new Set(['makaio.clients-core']);

    const result = composeBootExtensionSelection({
      bootEligibleExtensionPackages: [disabledOverride, pkgB, pkgC],
      configProvider: disabling(['makaio.clients-core']),
      frameworkPackageNames,
    });

    expect(result.effectiveEnabledPackageNames).toStrictEqual(new Set(['pkg-b', 'pkg-c']));
  });

  it('still excludes a dependent whose disabled dependency does not collide with any framework package name', () => {
    // Plain disabled-dependency exclusion (no collision involved) must keep
    // working exactly as `closeEffectiveEnabledBootPackages` already covers.
    const requiredDep = makePackage('provider-a');
    const dependent: KernelMakaioExtension = { ...makePackage('feature-b'), dependencies: [dep('provider-a')] };

    const result = composeBootExtensionSelection({
      bootEligibleExtensionPackages: [requiredDep, dependent],
      configProvider: disabling(['provider-a']),
      frameworkPackageNames: new Set(),
    });

    expect(result.effectiveEnabledPackageNames).toStrictEqual(new Set());
  });

  it('holds the fixed stage order as a contract on the composed result object', () => {
    // Stage 1 (preference) -> Stage 2 (collision) -> Stage 3 (post-collision
    // closure) -> Stage 4 (derived sets). A package dropped by Stage 2 is
    // absent from `extensionManagedPackageNames`, and
    // `effectiveEnabledPackageNames` is always a subset of it by construction.
    const disabledOverride = makePackage('makaio.clients-core');
    const dependentB: KernelMakaioExtension = {
      ...makePackage('feature-b'),
      dependencies: [dep('makaio.clients-core')],
    };
    const unrelatedDisabled = makePackage('unrelated-disabled');

    const result = composeBootExtensionSelection({
      bootEligibleExtensionPackages: [disabledOverride, dependentB, unrelatedDisabled],
      configProvider: disabling(['makaio.clients-core', 'unrelated-disabled']),
      frameworkPackageNames: new Set(['makaio.clients-core']),
    });

    // Stage 2 output.
    expect(result.mergeableExtensionPackages.map((pkg) => pkg.name)).not.toContain('makaio.clients-core');
    // Stage 4 derives extensionManagedPackageNames from Stage 2's survivors.
    expect(result.extensionManagedPackageNames).toStrictEqual(
      new Set(result.mergeableExtensionPackages.map((pkg) => pkg.name)),
    );
    // Stage 3's output is always a subset of Stage 2's survivor names.
    for (const name of result.effectiveEnabledPackageNames) {
      expect(result.extensionManagedPackageNames.has(name)).toBe(true);
    }
    // feature-b survives despite its literal dependency name being disabled,
    // because Stage 3 resolves it against the post-collision composition.
    expect(result.effectiveEnabledPackageNames.has('feature-b')).toBe(true);
    expect(result.effectiveEnabledPackageNames.has('unrelated-disabled')).toBe(false);
  });
});

describe('selectExtensionManagedEnabledPackages', () => {
  /**
   * Build a package that records the moment its boot contribution is
   * configured, so a test can assert whether `runtimeBoot.configure` ran.
   * @param name - Package name.
   * @param label - Distinguishing label pushed onto `configured` (lets a test
   *   tell the core package's own contribution apart from a same-named
   *   override's contribution).
   * @param configured - Shared recorder array the test asserts against.
   * @returns The package, ready to be handed to the coordinator.
   */
  function makeBootContributor(name: string, label: string, configured: string[]): KernelMakaioExtension {
    return {
      ...makePackage(name),
      runtimeBoot: {
        configure: () => {
          configured.push(label);
          return [];
        },
      },
    };
  }

  it('keeps a retained core package that won a disabled-override name collision, so its runtimeBoot contribution still registers', () => {
    // Reproduces the P2 finding: a disabled extension shares a core
    // package's name. `excludeIneffectiveCoreNameOverrides` correctly keeps
    // the core package active, but classifying `enabledRetainedPackages` by
    // the shared NAME against the pre-collision extension pool used to treat
    // the retained core package as "extension-managed and not enabled" —
    // dropping its runtimeBoot.configure even though the coordinator kept it
    // active. Classifying by the post-collision extension set fixes that.
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { surface: 'headless' });
    const configured: string[] = [];

    const corePackage = makeBootContributor('makaio.clients-core', 'core', configured);
    const disabledOverride = makeBootContributor('makaio.clients-core', 'override', configured);

    const frameworkPackageNames = new Set([corePackage.name]);
    // The override is disabled, so it is absent from the effective-enabled set.
    const effectiveEnabledPackageNames = new Set<string>();
    const mergeableExtensionPackages = excludeIneffectiveCoreNameOverrides(
      [disabledOverride],
      frameworkPackageNames,
      effectiveEnabledPackageNames,
    );
    expect(mergeableExtensionPackages).toStrictEqual([]);

    // `extensionManagedPackageNames` is derived from the post-collision
    // extension set, exactly as boot.ts now computes it.
    const extensionManagedPackageNames = new Set(mergeableExtensionPackages.map((pkg) => pkg.name));

    const packagesToLoad = [corePackage, ...mergeableExtensionPackages];
    const retainedPackages = coordinator.load(packagesToLoad);
    expect(retainedPackages).toStrictEqual([corePackage]);

    const enabledRetainedPackages = selectExtensionManagedEnabledPackages(
      retainedPackages,
      extensionManagedPackageNames,
      effectiveEnabledPackageNames,
    );

    registerExtensionBootContributions(enabledRetainedPackages, bus, coordinator);

    expect(configured).toStrictEqual(['core']);
  });

  it('keeps an enabled override that wins a core-name collision effectively enabled', () => {
    // Symmetric case: an enabled extension override legitimately shadows the
    // core package. `excludeIneffectiveCoreNameOverrides` keeps it, the
    // coordinator's own coalescing lets it win over the core package, and it
    // must remain classified as extension-managed AND effectively enabled so
    // its own runtimeBoot.configure still runs.
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { surface: 'headless' });
    const configured: string[] = [];

    const corePackage = makeBootContributor('makaio.clients-core', 'core', configured);
    const enabledOverride = makeBootContributor('makaio.clients-core', 'override', configured);

    const frameworkPackageNames = new Set([corePackage.name]);
    const effectiveEnabledPackageNames = new Set([enabledOverride.name]);
    const mergeableExtensionPackages = excludeIneffectiveCoreNameOverrides(
      [enabledOverride],
      frameworkPackageNames,
      effectiveEnabledPackageNames,
    );
    expect(mergeableExtensionPackages).toStrictEqual([enabledOverride]);

    const extensionManagedPackageNames = new Set(mergeableExtensionPackages.map((pkg) => pkg.name));

    const packagesToLoad = [corePackage, ...mergeableExtensionPackages];
    const retainedPackages = coordinator.load(packagesToLoad);
    // The coordinator's own name-collision coalescing keeps the last
    // registration — the override — not the core package.
    expect(retainedPackages).toStrictEqual([enabledOverride]);

    const enabledRetainedPackages = selectExtensionManagedEnabledPackages(
      retainedPackages,
      extensionManagedPackageNames,
      effectiveEnabledPackageNames,
    );

    registerExtensionBootContributions(enabledRetainedPackages, bus, coordinator);

    expect(configured).toStrictEqual(['override']);
  });

  it('excludes a non-colliding extension-managed package that is not effectively enabled', () => {
    const retainedPackages = [makePackage('disabled-ext'), makePackage('kept-ext')];

    const result = selectExtensionManagedEnabledPackages(
      retainedPackages,
      new Set(['disabled-ext', 'kept-ext']),
      new Set(['kept-ext']),
    );

    expect(result.map((pkg) => pkg.name)).toStrictEqual(['kept-ext']);
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

  it('registers nothing for a package the coordinator filtered out', () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { surface: 'headless' });
    const configured: string[] = [];

    /**
     * Build a package that records the moment its boot contribution is configured.
     * @param name - Package name.
     * @param surface - Runtime surface the package declares.
     * @returns The package, ready to be handed to the coordinator.
     */
    const makeBootContributor = (name: string, surface: ExtensionRuntimeSurface): KernelMakaioExtension => ({
      ...makePackage(name),
      surface,
      runtimeBoot: {
        configure: () => {
          configured.push(name);
          return [];
        },
      },
    });

    const packagesToLoad = [
      makeBootContributor('interactive-only', 'interactive'),
      makeBootContributor('kept', 'headless'),
    ];
    // Exactly the composition boot performs: register for what load returned.
    // A filtered package never activates, so configuring its boot contribution
    // would install behaviour for an extension that does not run.
    registerExtensionBootContributions(coordinator.load(packagesToLoad), bus, coordinator);

    expect(configured).toStrictEqual(['kept']);
  });

  it('critical extension hand-disabled in the store still contributes runtimeBoot at boot', () => {
    // Simulate an enablement store where both extensions are in "disabled".
    // The coordinator's load() applies the critical override (entry.enabled = true),
    // and the boot-layer must apply the same rule so the critical extension also
    // reaches registerExtensionBootContributions while optional-ext is correctly
    // excluded.
    const disabledNames = new Set(['critical-ext', 'optional-ext']);
    const store = {
      loadEnabled: (name: string): boolean | undefined => (disabledNames.has(name) ? false : undefined),
    };

    const configured: string[] = [];

    const packages: KernelMakaioExtension[] = [
      {
        ...makePackage('critical-ext'),
        critical: true,
        runtimeBoot: {
          configure: () => {
            configured.push('critical-ext');
            return [];
          },
        },
      },
      {
        ...makePackage('optional-ext'),
        runtimeBoot: {
          configure: () => {
            configured.push('optional-ext');
            return [];
          },
        },
      },
    ];

    // Mirror the boot-layer filter: include if effectively enabled (store OR critical).
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { surface: 'headless' });
    const retained = coordinator.load(packages);

    // Verify the predicate: critical-ext passes despite being disabled in the store.
    const enabledNames = retained.filter((pkg) => isExtensionEnabled(store, pkg.name, pkg)).map((p) => p.name);
    expect(enabledNames).toStrictEqual(['critical-ext']);

    // registerExtensionBootContributions is called with the filtered retained packages.
    const retainedEnabled = retained.filter((pkg) => isExtensionEnabled(store, pkg.name, pkg));
    registerExtensionBootContributions(retainedEnabled, bus, coordinator);

    // Only the critical extension's runtimeBoot.configure was invoked.
    expect(configured).toStrictEqual(['critical-ext']);
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
      await coordinator.applyExtensionTransition('test-builder-ext', false);
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
      await coordinator.applyExtensionTransition('test-builder-ext', false);
      expect(registry!.getBuilder('test-review', 1)).toBeUndefined();

      await coordinator.applyExtensionTransition('test-builder-ext', true);
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
            loadEnabled: (name) => !disabled.has(name),
          }
        : undefined,
      surface: options.surface ?? 'headless',
      runtimeEnvironment: environment,
    };
    const enabledLoadedPackages = selectBootEligibleExtensionPackages(eligibility).filter((pkg) =>
      isExtensionEnabled(eligibility.configProvider ?? {}, pkg.name, pkg),
    );
    return selectAutomationCronSchedulerPackage({
      hostPackages: [...selectEligibleAutomationCronSchedulerHostPackages(options.policies, eligibility)],
      loadedPackages: enabledLoadedPackages,
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

  // A disabled extension is still handed to the coordinator (so status and
  // listing still know about it, and a preference change takes effect on the
  // next boot) and stays in `loadedPackages`, but the coordinator soft-skips
  // it at start — it never actually runs. Provider
  // detection against `loadedPackages` must therefore honour enablement the
  // same way the owner-anchored host-policy path already does above, or a
  // disabled provider package would suppress the local fallback while nothing
  // is actually scheduling cron bindings.
  it('falls back to the local scheduler when a directly-registered provider package is disabled', () => {
    const disabledScheduler = scheduler('Disabled Direct Scheduler');
    expect(
      selectForBoot({
        packages: [disabledScheduler],
        policies: [],
        disabled: new Set([disabledScheduler.name]),
      }),
    ).toBe(localAutomationCronSchedulerPackage);
  });

  it('does not add a local fallback when a directly-registered provider package is enabled', () => {
    const enabledScheduler = scheduler('Enabled Direct Scheduler');
    expect(
      selectForBoot({
        packages: [enabledScheduler],
        policies: [],
      }),
    ).toBeUndefined();
  });

  it('falls back to the local scheduler when the policy owner has a disabled required dependency', () => {
    // The owner is preference-enabled but its required dependency is not, so
    // the coordinator's start-time dependency check will never let it reach
    // `active` (extension-start-runner.ts). The owner-anchored policy must
    // therefore be treated the same as a disabled owner: fall back to the
    // local scheduler instead of selecting a policy that will never run.
    const requiredDep = owner('example.provider');
    const relayOwner: KernelMakaioExtension = { ...owner('example.relay'), dependencies: [dep('example.provider')] };
    expect(
      selectForBoot({
        packages: [relayOwner, requiredDep],
        policies: [{ ownerPackage: relayOwner, package: scheduler('Relay Scheduler') }],
        disabled: new Set([requiredDep.name]),
      }),
    ).toBe(localAutomationCronSchedulerPackage);
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
        .then((decision) =>
          stubAuthority.settleOutcome(ctx.payload.executionAttemptId, {
            ...requireCommittedOutcome(decision),
            acceptance: 'projected',
          }),
        );
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
      expect(completion).toMatchObject({ state: 'authority-committed', result: { status: 'completed' } });
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
      stubAuthority.settleOutcome(request.executionAttemptId, {
        ...requireCommittedOutcome(decision),
        acceptance: 'projected',
      });
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
      await coordinator.applyExtensionTransition('test-disable-ext', false);
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
      await coordinator.applyExtensionTransition('test-reenable-ext', false);
      expect(
        clientsCore!.hookResponseRegistry.snapshot('claude-code', 'claude-code.tool-response', 'PreToolUse', []),
      ).toHaveLength(0);

      await coordinator.applyExtensionTransition('test-reenable-ext', true);
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
