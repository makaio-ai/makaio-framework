import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionConfigProvider } from '@makaio/contracts';
import {
  ExtensionCoordinator,
  coalesceExtensionOverrides,
  filterEligibleExtensions,
  type KernelMakaioExtension,
  type RuntimeCapability,
  type ExtensionRuntimeSurface,
  type RuntimeEnvironment,
} from '@makaio/kernel';
import { frameworkCorePackages, SessionOrchestratorToken } from '@makaio/services-core';
import type { ShutdownStep } from './boot-phase.js';

/**
 * Add host-provided cleanup callbacks to the shared shutdown list.
 * @param shutdownSteps - Runtime shutdown list.
 * @param cleanup - Optional cleanup or cleanup list returned by a host hook.
 */
export function collectHostCleanups(
  shutdownSteps: ShutdownStep[],
  cleanup: void | ShutdownStep | readonly ShutdownStep[],
): void {
  shutdownSteps.push(...normalizeHostCleanups(cleanup));
}

/**
 * Normalize host-provided cleanup callbacks into an array.
 * @param cleanup - Optional cleanup or cleanup list returned by a host hook.
 * @returns Cleanup callbacks in startup order.
 */
function normalizeHostCleanups(cleanup: void | ShutdownStep | readonly ShutdownStep[]): ShutdownStep[] {
  if (cleanup === undefined) return [];
  if (typeof cleanup === 'function') {
    return [cleanup];
  }
  return [...cleanup];
}

/**
 * Build the runtime environment snapshot for the extension coordinator.
 *
 * `hosts` receives the OS platform token (`'darwin'`, `'linux'`, `'win32'`)
 * plus any plain-string host-identity tokens (e.g. `'node'`) so extensions
 * can gate on `{ type: 'host', id: 'node' }`.
 *
 * `capabilities` receives only object-form {@link RuntimeCapability} tokens
 * so extensions can gate on `{ type: 'capability', id: 'storage.drizzle' }`.
 * Plain-string declarations are host identities, not capabilities.
 *
 * Node-based hosts must include `'node'` in their host capabilities array.
 * The platform-agnostic core deliberately does not inject Node semantics;
 * the Node wrapper normalizes before calling core.
 * @param platform - Current OS platform string (e.g. `'darwin'`, `'linux'`).
 * @param hostCapabilities - Host identity and capability facts declared by the composition root.
 * @returns Runtime environment ready for passing to {@link ExtensionCoordinator}.
 */
export function buildRuntimeEnvironment(
  platform: string,
  hostCapabilities: readonly HostCapabilityDeclaration[] = [],
): RuntimeEnvironment {
  const hosts = new Set<string>([platform]);
  const capabilities = new Set<string>();
  const capabilityVersions = new Map<string, NonNullable<RuntimeCapability['version']>>();

  for (const declaration of hostCapabilities) {
    if (typeof declaration === 'string') {
      hosts.add(declaration);
    } else {
      capabilities.add(declaration.id);
      if (declaration.version !== undefined) {
        capabilityVersions.set(declaration.id, declaration.version);
      }
    }
  }

  return {
    hosts,
    capabilities,
    ...(capabilityVersions.size > 0 ? { capabilityVersions } : {}),
  };
}

/**
 * Return host capability tokens for Node.js composition roots.
 *
 * This helper is intentionally called by Node surfaces before boot rather
 * than from {@link buildRuntimeEnvironment}, so the platform token remains an
 * explicit host policy and Bun/future runtimes do not inherit Node semantics.
 * @param hostCapabilities - Host-declared capability facts.
 * @returns Capability tokens with `'node'` present exactly once.
 */
export function normalizeNodeHostCapabilities(
  hostCapabilities: readonly HostCapabilityDeclaration[] = [],
): readonly HostCapabilityDeclaration[] {
  return hostCapabilities.some((capability) => typeof capability === 'string' && capability === 'node')
    ? hostCapabilities
    : ['node', ...hostCapabilities];
}

/** Host capability input accepted by Node runtime composition roots. */
export type HostCapabilityDeclaration = string | RuntimeCapability;

/**
 * Select descriptor-backed extension packages that are allowed to contribute
 * during this boot.
 * @param options - Package set, persisted enablement source, surface, and runtime environment.
 * @returns Loaded extension packages eligible for coordinator boot.
 */
export function selectBootEligibleExtensionPackages(options: {
  readonly packages: ReadonlyArray<KernelMakaioExtension>;
  readonly configProvider: ExtensionConfigProvider | undefined;
  readonly surface: ExtensionRuntimeSurface;
  readonly runtimeEnvironment: RuntimeEnvironment;
}): ReadonlyArray<KernelMakaioExtension> {
  return coalesceExtensionOverrides(
    filterEligibleExtensions(
      filterPersistentlyEnabledExtensionPackages(options.packages, options.configProvider),
      options.surface,
      options.runtimeEnvironment,
    ),
  );
}

/**
 * Keep extension packages that are not persistently disabled.
 * @param packages - Descriptor-backed extension packages loaded from extension discovery.
 * @param configProvider - Optional persisted extension configuration provider.
 * @returns Packages whose persisted enabled state permits boot-time contributions.
 */
function filterPersistentlyEnabledExtensionPackages(
  packages: ReadonlyArray<KernelMakaioExtension>,
  configProvider: ExtensionConfigProvider | undefined,
): ReadonlyArray<KernelMakaioExtension> {
  if (!configProvider) return packages;
  return packages.filter((pkg) => configProvider.loadEnabled(pkg.name) !== false);
}

type RuntimeOwnershipPackageView = Pick<KernelMakaioExtension, 'name' | 'displayName' | 'version' | 'runtimeOwnership'>;

/**
 * Find loaded extensions that declare ownership of one runtime subsystem.
 * @param packages - Loaded executable extension packages.
 * @param ownership - Runtime ownership field to inspect.
 * @returns Package names that declare the ownership field.
 */
function findRuntimeOwners(
  packages: ReadonlyArray<RuntimeOwnershipPackageView>,
  ownership: keyof NonNullable<KernelMakaioExtension['runtimeOwnership']>,
): string[] {
  return packages.filter((pkg) => pkg.runtimeOwnership?.[ownership] === true).map((pkg) => pkg.name);
}

/**
 * Fail when more than one loaded extension owns a runtime subsystem.
 * @param packages - Loaded executable extension packages.
 * @param ownership - Runtime ownership field to inspect.
 */
function assertSingleRuntimeOwner(
  packages: ReadonlyArray<RuntimeOwnershipPackageView>,
  ownership: keyof NonNullable<KernelMakaioExtension['runtimeOwnership']>,
): void {
  const owners = findRuntimeOwners(packages, ownership);
  if (owners.length > 1) {
    throw new Error(`Multiple extensions own runtimeOwnership.${ownership}: ${owners.join(', ')}`);
  }
}

/**
 * Decide whether a composition root should load the default session orchestrator.
 * @param loadedExtensionPackages - Executable extension packages available to the runtime.
 * @returns `true` when no extension declares session-orchestrator ownership.
 */
export function shouldLoadDefaultSessionOrchestrator(
  loadedExtensionPackages: ReadonlyArray<RuntimeOwnershipPackageView>,
): boolean {
  assertSingleRuntimeOwner(loadedExtensionPackages, 'sessionOrchestrator');
  return findRuntimeOwners(loadedExtensionPackages, 'sessionOrchestrator').length === 0;
}

/**
 * Select framework core packages for the loaded descriptor-backed extensions.
 *
 * The framework session orchestrator is the default owner of
 * `session.sendMessage`. It is omitted when a loaded extension declares
 * `runtimeOwnership.sessionOrchestrator`, and boot fails if more than one
 * loaded extension declares that ownership.
 * @param loadedExtensionPackages - Descriptor-loaded executable extension packages.
 * @returns Framework core packages for this boot.
 */
export function selectFrameworkCorePackages(
  loadedExtensionPackages: ReadonlyArray<RuntimeOwnershipPackageView> | true,
): ReadonlyArray<KernelMakaioExtension> {
  if (loadedExtensionPackages === true) {
    return frameworkCorePackages;
  }

  if (shouldLoadDefaultSessionOrchestrator(loadedExtensionPackages)) {
    return frameworkCorePackages;
  }

  return frameworkCorePackages.filter((pkg) => pkg.name !== SessionOrchestratorToken.name);
}

/**
 * Register extension-owned boot contributions before coordinator startup.
 * @param packages - Packages loaded into the coordinator.
 * @param bus - Runtime bus.
 * @param coordinator - Extension coordinator being configured.
 * @returns Cleanup callbacks for registered boot contributions.
 */
export function registerExtensionBootContributions(
  packages: ReadonlyArray<KernelMakaioExtension>,
  bus: IMakaioBus,
  coordinator: ExtensionCoordinator,
): readonly ShutdownStep[] {
  const cleanups: ShutdownStep[] = [];

  try {
    for (const pkg of packages) {
      const contribution = pkg.runtimeBoot;
      if (!contribution) continue;

      collectHostCleanups(
        cleanups,
        contribution.configure({
          bus,
          registerContributionProcessor: (processor) => {
            cleanups.push(coordinator.registerContributionProcessor(processor));
          },
          forEachActiveExtension: (callback) => {
            coordinator.forEachActiveExtension(callback);
          },
        }),
      );
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) {
      try {
        cleanup();
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Extension boot contribution failed and rollback cleanup reported additional errors',
        { cause: error },
      );
    }
    throw error;
  }

  return cleanups;
}

/**
 * Parse the `MAKAIO_SKIP_EXTENSIONS` environment variable into a set of names
 * to skip. Returns an empty set when the variable is unset or empty.
 * @returns Normalised set of extension names to suppress during boot.
 */
export function parseSkipExtensions(): ReadonlySet<string> {
  const raw = process.env.MAKAIO_SKIP_EXTENSIONS;
  if (!raw) return new Set();
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(names);
}
