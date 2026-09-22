import type { IMakaioBus } from '@makaio/bus-core';
import { isRuntimeOwnershipFieldClaimed, type ExtensionConfigProvider } from '@makaio/contracts';
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
import { isExtensionEnabled } from './extension-enablement-store.js';
import { getExtensionPackageSource } from './extension-package-provenance.js';
import type { LoadedAutomationCronSchedulerHostPolicy } from './load-extensions.js';

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

/** Inputs used to determine which descriptor-backed packages can contribute during boot. */
export interface BootExtensionEligibilityOptions {
  readonly packages: ReadonlyArray<KernelMakaioExtension>;
  /**
   * Optional enablement source used by scheduler policy selection to exclude
   * disabled extensions. Only `loadEnabled` is consumed; `loadConfig` and
   * `persistEnabled` are unused at this layer.
   */
  readonly configProvider: Pick<ExtensionConfigProvider, 'loadEnabled'> | undefined;
  readonly surface: ExtensionRuntimeSurface;
  readonly runtimeEnvironment: RuntimeEnvironment;
}

/**
 * Select descriptor-backed extension packages that are surface- and
 * environment-eligible to contribute during this boot.
 *
 * Disabled extensions are intentionally included so the coordinator can create
 * an entry for them — they start in `skipped` state so status and listing
 * still know about them, and an enablement preference change takes effect on
 * the next boot rather than live. Enablement filtering is the coordinator's
 * soft gate (`loadEnabled` → `entry.enabled`), not a pre-load exclusion.
 *
 * This pool contains descriptor-backed extension packages only — no framework
 * packages — so {@link coalesceExtensionOverrides} is called without an
 * overridable-name set: every name here is an extension identity, and two
 * packages claiming one is a collision with no legitimate winner rather than
 * an override.
 * @param options - Package set, surface, and runtime environment.
 * @returns Loaded extension packages eligible for coordinator boot.
 * @throws Error when two eligible extension packages register under one name.
 */
export function selectBootEligibleExtensionPackages(
  options: BootExtensionEligibilityOptions,
): ReadonlyArray<KernelMakaioExtension> {
  return coalesceExtensionOverrides(
    filterEligibleExtensions(options.packages, options.surface, options.runtimeEnvironment),
  );
}

/**
 * Select scheduler provider packages whose exact server-package owner survived
 * final boot composition, eligibility filtering, enablement checks, and the
 * dependency closure applied by {@link closeEffectiveEnabledBootPackages}.
 *
 * Disabled packages are excluded here in addition to the surface/environment
 * check because a scheduler policy contributed by a disabled extension would
 * run without its owning extension ever becoming active. The same is true of
 * an owner whose own required dependency is disabled: the coordinator's
 * start-time dependency check (see `extension-start-runner.ts`) will never let
 * that owner reach `active`, so its contributed scheduler policy must not be
 * treated as the running provider either — otherwise cron bindings would
 * silently go unscheduled behind a policy that never actually starts.
 * @param policies - Owner-anchored policies collected from descriptor server modules.
 * @param options - Final packages and the boot eligibility inputs shared with the coordinator.
 * @param effectiveEnabledExtensionPackages - Optional pre-computed effective-enabled
 *   package set (`BootExtensionSelectionResult.effectiveEnabledBootPackages` from
 *   {@link composeBootExtensionSelection}). When supplied, this function reuses it
 *   instead of recomputing a preliminary, collision-unaware closure — the composed
 *   result is post-collision-correct (see {@link composeBootExtensionSelection}'s
 *   Stage 3), so a scheduler owner whose only unmet dependency is a
 *   core-name-colliding, disabled extension override is no longer wrongly
 *   dropped. When omitted, this function falls back to its own preliminary
 *   closure, matching prior behavior for callers that have not composed a
 *   full boot selection (e.g. isolated unit tests).
 * @returns Provider packages contributed by still-eligible, dependency-closed enabled owners, preserving discovery order.
 */
export function selectEligibleAutomationCronSchedulerHostPackages(
  policies: ReadonlyArray<LoadedAutomationCronSchedulerHostPolicy>,
  options: BootExtensionEligibilityOptions,
  effectiveEnabledExtensionPackages?: ReadonlyArray<KernelMakaioExtension>,
): ReadonlyArray<KernelMakaioExtension> {
  const eligiblePackages = effectiveEnabledExtensionPackages ?? computePreliminaryEffectiveEnabledPackages(options);
  const eligibleSources = new Set(eligiblePackages.map(getExtensionPackageSource));
  return policies.filter(({ ownerPackage }) => eligibleSources.has(ownerPackage)).map(({ package: pkg }) => pkg);
}

/**
 * Compute the preliminary (pre-collision) preference-enabled, dependency-closed
 * package set for a caller that has not composed a full
 * {@link composeBootExtensionSelection} result.
 * @param options - Boot eligibility inputs.
 * @returns Preference-enabled packages closed over the boot-eligible extension pool.
 */
function computePreliminaryEffectiveEnabledPackages(
  options: BootExtensionEligibilityOptions,
): ReadonlyArray<KernelMakaioExtension> {
  const { configProvider } = options;
  const bootEligiblePackages = selectBootEligibleExtensionPackages(options);
  const preferenceEnabledPackages = configProvider
    ? bootEligiblePackages.filter((pkg) => isExtensionEnabled(configProvider, pkg.name, pkg))
    : bootEligiblePackages;
  return closeEffectiveEnabledBootPackages(preferenceEnabledPackages, bootEligiblePackages);
}

/**
 * Reduce a preference-enabled package set to its dependency-closed subset.
 *
 * `enabledBootPackages` in `boot.ts` used to be computed by filtering on
 * enablement preference alone (`isExtensionEnabled`), independent of whether a
 * package's own required dependencies were actually going to start. A package
 * whose required, non-optional dependency was disabled still contributed its
 * `clients`, `runtimeOwnership`, and `runtimeBoot` to the boot composition,
 * even though the coordinator's start-time dependency check
 * (`extension-start-runner.ts`, `startExtensionEntry`) would never let that
 * package reach `active`. This function closes that gap: it mirrors the
 * coordinator's own dependency-satisfaction rule — only non-optional
 * `dependencies` entries count, and a dependency is satisfied only if it is
 * itself in the (recursively closed) enabled set — so every downstream boot
 * composition step that consumed `enabledBootPackages` agrees with what the
 * coordinator will actually start.
 *
 * A `critical` package is not exempted from this rule. `critical` only means
 * the operator's enablement preference cannot disable the package itself (see
 * `isExtensionEnabled`'s override, already applied by the caller before this
 * function runs) — it says nothing about that package's own dependencies. If
 * a critical package's required dependency is not effectively enabled, the
 * coordinator's `startExtensionEntry` fails that critical entry and *throws*,
 * aborting `ExtensionCoordinator.startAll()` entirely (see
 * `extension-start-runner.ts`, the `if (entry.pkg.critical) throw ...` branch,
 * and `ExtensionCoordinator.startAllInLifecycleLane` propagating it). The
 * coordinator does not "force-start" such a package — it aborts
 * boot. Excluding the package here cannot make that outcome worse: either the
 * coordinator aborts boot regardless (this function's answer was moot), or —
 * if the composition root tolerates the eventual abort — the package never
 * ran, so it correctly never contributed to `clients`/ownership/`runtimeBoot`.
 *
 * Only dependency names that are themselves part of the descriptor-backed
 * extension pool are treated as excludable. A dependency on a framework
 * package name (e.g. a clients-core token) is always considered satisfied
 * here: framework packages load unconditionally and are not subject to the
 * extension enablement store, so they are outside this closure's jurisdiction
 * — exactly as the coordinator's own entry map always contains them.
 * @param preferenceEnabledPackages - Packages enabled by operator preference
 *   (including the critical override), before dependency closure.
 * @param bootEligibleExtensionPackages - The full surface- and
 *   environment-eligible extension pool; used only to decide which dependency
 *   names are extension-managed (and thus excludable) versus framework core packages
 *   (and thus always satisfied).
 * @returns The dependency-closed subset of `preferenceEnabledPackages`, preserving input order.
 */
export function closeEffectiveEnabledBootPackages(
  preferenceEnabledPackages: ReadonlyArray<KernelMakaioExtension>,
  bootEligibleExtensionPackages: ReadonlyArray<KernelMakaioExtension>,
): ReadonlyArray<KernelMakaioExtension> {
  const extensionManagedNames = new Set(bootEligibleExtensionPackages.map((pkg) => pkg.name));
  const closed = new Map(preferenceEnabledPackages.map((pkg) => [pkg.name, pkg]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of closed.values()) {
      const missingDependencies = (pkg.dependencies ?? []).filter(
        (dependency) =>
          !dependency.optional && extensionManagedNames.has(dependency.name) && !closed.has(dependency.name),
      );
      if (missingDependencies.length === 0) continue;
      closed.delete(pkg.name);
      changed = true;
      console.warn(
        '[boot] Excluding extension "%s" from boot composition: required dependency %s is disabled',
        pkg.name,
        missingDependencies.map((dependency) => dependency.name).join(', '),
      );
    }
  }

  return [...closed.values()];
}

/**
 * Drop extension packages that would displace a framework package by name
 * unless the extension package is actually going to run.
 *
 * The coordinator's own `load()` re-runs {@link coalesceExtensionOverrides}
 * over its full input (framework packages followed by extension packages).
 * There, a second registration under a *framework* package name is the
 * supported core-override flow: the extension wins the name and the framework
 * package's registration is discarded outright — not soft-skipped. (A second
 * registration under any other name is an extension identity collision and
 * aborts `load()`; extension identities are already made unique upstream by
 * discovery's tier resolution.)
 *
 * That override rule is correct only for an extension that is actually going
 * to run. A *disabled* extension whose name collides with a framework
 * package's name would otherwise take mandatory runtime infrastructure out of
 * the boot composition entirely — it wins the name before the coordinator ever
 * assigns it a `skipped`/`active` state, and then never starts. Filtering the
 * extension side here, before the merge, keeps the framework package's entry
 * as the coordinator's only registration under that name, so it stays
 * active and the excluded extension package correctly never appears as a
 * soft-skipped entry under that name — the coordinator entry for the name is
 * the running framework package, not the extension.
 *
 * "Actually going to run" is `effectiveEnabledPackageNames`: the
 * dependency-closed, preference-enabled subset the same boot composition
 * already computed via {@link closeEffectiveEnabledBootPackages}. An
 * enabled extension whose own required dependency is disabled is excluded
 * from that set too, so it cannot displace a same-named framework package
 * either — it would never reach `active` regardless.
 * @param extensionPackages - Boot-eligible descriptor-backed extension
 *   packages about to be merged with the framework package list.
 * @param frameworkPackageNames - Names of the framework packages this boot
 *   already assembled.
 * @param effectiveEnabledPackageNames - Names of extension packages that
 *   survived enablement preference and dependency closure — the packages
 *   that will actually reach `active`.
 * @returns `extensionPackages` minus any package whose name collides with a
 *   framework package name and that is not effectively enabled.
 */
export function excludeIneffectiveCoreNameOverrides(
  extensionPackages: ReadonlyArray<KernelMakaioExtension>,
  frameworkPackageNames: ReadonlySet<string>,
  effectiveEnabledPackageNames: ReadonlySet<string>,
): ReadonlyArray<KernelMakaioExtension> {
  return extensionPackages.filter((pkg) => {
    if (!frameworkPackageNames.has(pkg.name) || effectiveEnabledPackageNames.has(pkg.name)) {
      return true;
    }
    console.warn(
      '[boot] Excluding extension "%s": a disabled override would replace core package %s; ' +
        'the core package stays active; the override applies after enabling and restart',
      pkg.name,
      pkg.name,
    );
    return false;
  });
}

/** Inputs for {@link composeBootExtensionSelection}. */
export interface BootExtensionSelectionOptions {
  /** Surface- and environment-eligible extension pool this boot considered (see {@link selectBootEligibleExtensionPackages}). */
  readonly bootEligibleExtensionPackages: ReadonlyArray<KernelMakaioExtension>;
  /** Enablement preference source; `undefined` treats every boot-eligible package as preference-enabled. */
  readonly configProvider: Pick<ExtensionConfigProvider, 'loadEnabled'> | undefined;
  /**
   * Names of every framework/core package this boot loads unconditionally,
   * regardless of extension state — the collision boundary Stage 2 protects.
   * Must be computed from the framework package identities this boot will
   * assemble, independent of any extension-closure result, so it is safe to
   * compute before {@link composeBootExtensionSelection} runs.
   */
  readonly frameworkPackageNames: ReadonlySet<string>;
}

/**
 * Canonical, order-dependent result of the boot-time extension selection
 * pipeline. Every downstream `boot.ts` consumer (client definitions, runtime
 * ownership, scheduler policy selection, `packagesToLoad`,
 * `registerExtensionBootContributions`, and warning diagnostics) reads its
 * sets from this single object instead of recomputing any stage
 * independently — see {@link composeBootExtensionSelection}.
 */
export interface BootExtensionSelectionResult {
  /**
   * Extension packages that survived collision resolution against framework
   * package names (Stage 2) and are eligible to merge into `packagesToLoad`.
   * Includes operator-disabled packages — the coordinator still receives them
   * so status/listing know about them and a preference change takes effect on
   * the next boot.
   */
  readonly mergeableExtensionPackages: ReadonlyArray<KernelMakaioExtension>;
  /**
   * Names of {@link mergeableExtensionPackages} — the set that decides
   * whether a coordinator-retained package with a given name is
   * extension-managed (see {@link selectExtensionManagedEnabledPackages}) and
   * the set passed to the kernel as `ExtensionCoordinatorOptions.extensionManagedNames`
   * so the coordinator can enforce that framework packages are not toggleable.
   */
  readonly extensionManagedPackageNames: ReadonlySet<string>;
  /**
   * Packages that are preference-enabled AND whose required, non-optional
   * dependencies are satisfied against the post-collision composition
   * (Stage 3) — the packages that will actually reach `active`.
   */
  readonly effectiveEnabledBootPackages: ReadonlyArray<KernelMakaioExtension>;
  /** Names of {@link effectiveEnabledBootPackages}. */
  readonly effectiveEnabledPackageNames: ReadonlySet<string>;
}

/**
 * Compose the boot-time extension selection pipeline in one call, in the
 * order later stages require. This is the single seam every `boot.ts`
 * consumer of extension-selection sets must read from — no stage may be
 * recomputed independently elsewhere (see `selectEligibleAutomationCronSchedulerHostPackages`'s
 * optional pre-computed-set parameter for the one caller that previously
 * duplicated Stage 1+3).
 *
 * **Stage 1 — Preference.** Filter `bootEligibleExtensionPackages` by
 * {@link isExtensionEnabled} (the `critical`-package override included).
 *
 * **Stage 2 — Collision resolution.** Drop an extension package whose name
 * collides with a framework package name unless it is actually going to run
 * ({@link excludeIneffectiveCoreNameOverrides}). "Actually going to run" for
 * *this* stage is judged with a preliminary dependency closure computed over
 * the full boot-eligible extension pool (pre-collision) — the one
 * henne-and-egg edge this stage tolerates. That edge is benign: a
 * preference-enabled colliding package's own survival through the
 * preliminary closure is unaffected by collision order, because
 * {@link closeEffectiveEnabledBootPackages} already treats any dependency
 * name *outside* the boot-eligible extension pool (i.e. every pure framework
 * package name) as unconditionally satisfied. The only case the preliminary
 * closure gets wrong is a *dependency* of some *other* package whose name
 * collides with a framework package — and that is exactly what Stage 3
 * exists to correct, using the now-known Stage 2 outcome.
 *
 * **Stage 3 — Dependency closure over the post-collision composition.**
 * Re-run {@link closeEffectiveEnabledBootPackages}, this time treating only
 * `mergeableExtensionPackages` (the Stage 2 survivors) as the "excludable"
 * dependency-name universe, seeded from preference-enabled packages that
 * also survived Stage 2. A name Stage 2 dropped in favor of a retained
 * framework package is no longer part of that universe, so a dependency on
 * it is treated as unconditionally satisfied — exactly like a dependency on
 * any other framework package name. This is what keeps a package whose only
 * unmet dependency is a core-name-colliding, disabled extension override in
 * the boot composition: the framework package that actually wins that name
 * satisfies the dependency, so the dependent is not excluded even though its
 * literal dependency-name entry is disabled.
 *
 * **Stage 4 — Derived sets.** `extensionManagedPackageNames` (Stage 2
 * survivors' names) and `effectiveEnabledPackageNames` (Stage 3 survivors'
 * names) are exposed on the result for every downstream consumer.
 * @param options - Extension-selection inputs for this boot.
 * @returns The staged composition result every `boot.ts` consumer reads from.
 */
export function composeBootExtensionSelection(options: BootExtensionSelectionOptions): BootExtensionSelectionResult {
  const { bootEligibleExtensionPackages, configProvider, frameworkPackageNames } = options;

  // Stage 1 — preference.
  const preferenceEnabledPackages = configProvider
    ? bootEligibleExtensionPackages.filter((pkg) => isExtensionEnabled(configProvider, pkg.name, pkg))
    : bootEligibleExtensionPackages;

  // Stage 2 — collision resolution, judged against a preliminary
  // (pre-collision) closure; see the henne-and-egg note above.
  const preliminaryEffectiveEnabledNames = new Set(
    closeEffectiveEnabledBootPackages(preferenceEnabledPackages, bootEligibleExtensionPackages).map((pkg) => pkg.name),
  );
  const mergeableExtensionPackages = excludeIneffectiveCoreNameOverrides(
    bootEligibleExtensionPackages,
    frameworkPackageNames,
    preliminaryEffectiveEnabledNames,
  );
  const extensionManagedPackageNames = new Set(mergeableExtensionPackages.map((pkg) => pkg.name));

  // Stage 3 — dependency closure over the post-collision composition. Only
  // preference-enabled packages that also survived Stage 2 seed the closure;
  // `extensionManagedPackageNames` (Stage 2's survivors) is the excludable
  // dependency-name universe, so a name Stage 2 dropped is now unconditionally
  // satisfied — the fix for the P1 finding.
  const preferenceEnabledMergeablePackages = preferenceEnabledPackages.filter((pkg) =>
    extensionManagedPackageNames.has(pkg.name),
  );
  const effectiveEnabledBootPackages = closeEffectiveEnabledBootPackages(
    preferenceEnabledMergeablePackages,
    mergeableExtensionPackages,
  );
  const effectiveEnabledPackageNames = new Set(effectiveEnabledBootPackages.map((pkg) => pkg.name));

  return {
    mergeableExtensionPackages,
    extensionManagedPackageNames,
    effectiveEnabledBootPackages,
    effectiveEnabledPackageNames,
  };
}

/**
 * Select retained packages whose `runtimeBoot.configure` may run.
 *
 * `extensionManagedPackageNames` must be derived from the extension package
 * set *after* {@link excludeIneffectiveCoreNameOverrides} has run (i.e. from
 * `mergeableExtensionPackages`, not from the pre-collision boot-eligible
 * pool). That distinction is load-bearing: when a disabled extension's name
 * collides with a framework package's name, `excludeIneffectiveCoreNameOverrides`
 * drops the extension package before the merge, so the coordinator's only
 * registration under that name is the framework package — but the
 * enablement store still records the name as disabled (that record describes
 * the excluded extension, not the framework package that now runs under the
 * shared name). Classifying by the post-collision extension set means a
 * retained package whose name is absent from it is, by construction, a
 * framework package — one that was never offered to the coordinator through
 * the extension pipeline at all — and framework packages load unconditionally;
 * they are not subject to the extension enablement store under any name,
 * shared or not. Deriving the set from the pre-collision pool would
 * misclassify that framework package as extension-managed and gate it on a
 * store entry that names a different package, silently dropping its boot
 * contribution (e.g. the clients-core client-hook response processor) even
 * though the coordinator kept the framework package active.
 *
 * A retained package whose name *is* extension-managed still needs the
 * `effectiveEnabledPackageNames` check: a coordinator-filtered package never
 * activates, and a persistently-disabled package starts in `skipped` state
 * (soft-skipped so status/listing still know about it and a preference
 * change takes effect on the next boot), so neither should have its
 * `runtimeBoot.configure` invoked. A preference-enabled extension whose own
 * required dependency is disabled is excluded from `effectiveEnabledPackageNames`
 * by the same dependency closure used elsewhere in boot composition, so it is
 * excluded here too — it would never reach `active` either.
 * @param retainedPackages - Packages the coordinator retained via `load()`.
 * @param extensionManagedPackageNames - Names of extension packages that
 *   survived {@link excludeIneffectiveCoreNameOverrides} and were merged into
 *   the boot composition.
 * @param effectiveEnabledPackageNames - Names of extension packages that
 *   survived enablement preference and dependency closure — the packages
 *   that will actually reach `active`.
 * @returns Retained packages allowed to register boot contributions.
 */
export function selectExtensionManagedEnabledPackages(
  retainedPackages: ReadonlyArray<KernelMakaioExtension>,
  extensionManagedPackageNames: ReadonlySet<string>,
  effectiveEnabledPackageNames: ReadonlySet<string>,
): ReadonlyArray<KernelMakaioExtension> {
  return retainedPackages.filter(
    (pkg) => !extensionManagedPackageNames.has(pkg.name) || effectiveEnabledPackageNames.has(pkg.name),
  );
}

type RuntimeOwnershipPackageView = Pick<KernelMakaioExtension, 'name' | 'displayName' | 'version' | 'runtimeOwnership'>;

/**
 * Find loaded extensions that declare ownership of one runtime subsystem.
 *
 * Uses {@link isRuntimeOwnershipFieldClaimed} so the field-level `=== true`
 * rule stays defined in one place, shared with every other caller that needs
 * to know whether a runtime ownership field is claimed.
 * @param packages - Loaded executable extension packages.
 * @param ownership - Runtime ownership field to inspect.
 * @returns Package names that declare the ownership field.
 */
function findRuntimeOwners(
  packages: ReadonlyArray<RuntimeOwnershipPackageView>,
  ownership: keyof NonNullable<KernelMakaioExtension['runtimeOwnership']>,
): string[] {
  return packages
    .filter((pkg) => isRuntimeOwnershipFieldClaimed(pkg.runtimeOwnership, ownership))
    .map((pkg) => pkg.name);
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
 * @param packages - Packages the coordinator retained AND that are effectively
 *   enabled, not the ones the coordinator was offered. A package excluded by
 *   surface or environment filtering never activates, and a package the
 *   enablement store disables starts in `skipped` state, so neither may install
 *   boot-time state such as contribution processors. The enablement half is
 *   load-bearing: disabled packages now reach the coordinator so status and
 *   listing still know about them and a preference change takes effect on the
 *   next boot, which means they are no longer filtered out upstream.
 *   A `critical` package counts as enabled even when the store disables it.
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
