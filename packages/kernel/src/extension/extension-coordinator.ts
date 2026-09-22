/* eslint max-lines: ["error", { "max": 490, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionOperatorConfigSource, ExtensionService, ExtensionToken, TrayManifest } from '@makaio/contracts';
import type { ExtensionWarningAction } from '@makaio/contracts/extension';
import type { CliContribution } from '../cli/types.js';
import { BootProgressObserver } from './boot-progress-observer.js';
import { registerWarningActionHandler } from './warning-action-dispatcher.js';
import { registerCoordinatorRpcHandlers } from './coordinator-rpc-handlers.js';
import { emitWarnings, emitWarningsForEntry } from './health-warning-emitter.js';
import { entryToExtensionInfo } from './extension-info.js';
import { createExtensionIdentity } from './extension-identity-builder.js';
import {
  applyExtensionTransition as applyExtensionTransitionImpl,
  handleSetEnabled as handleSetEnabledImpl,
  type SetEnabledResult,
  type ToggleHost,
  type TransitionOutcome,
} from './extension-toggle.js';
import { coalesceExtensionOverrides, filterEligibleExtensions } from './extension-selection.js';
import { WindowRegistry } from '../window/window-registry.js';
import { topoSort } from './topo-sort.js';
import { resolveBootEnabledNames } from './extension-boot-enablement.js';
import type {
  ContributionProcessor,
  ExtensionCoordinatorOptions,
  ExtensionEntry,
  ExtensionRuntimeSurface,
  KernelExtensionContext,
  KernelMakaioExtension,
  RuntimeEnvironment,
} from './types.js';
import type { ExtensionInfo } from '../observability/shared-schemas.js';
import {
  buildExtensionContext,
  type ExtensionContextHost,
  resolveExtensionEntryConfig,
  resolveExtensionEntryConfigOutcome,
} from './extension-context-builder.js';
import type { ExtensionConfigResolution } from './resolve-config.js';
import { closeEnabledExtensionEntries } from './extension-entry-closure.js';
import { runExtensionMigrations, type ExtensionMigrationRunner } from './extension-migration-runner.js';
import { runExtensionHealthCheck, type ExtensionHealthHost } from './extension-health-runner.js';
import { collectExtensionSurfaces, extensionsWithHttp } from './extension-surface-collector.js';
import { shutdownExtensions } from './extension-shutdown-runner.js';
import { startExtensionEntry } from './extension-start-runner.js';

/**
 * Manages optional extensions through a unified lifecycle with per-extension state
 * machine, bus observability, and window/tray/CLI surface collection.
 *
 * Lifecycle flow for each extension:
 * ```
 * discovered -> initializing -> [create + init + contributions] -> active
 *                            ↘ failed  (any step fails, contributions rolled back)
 *                            ↘ skipped  (ServiceSkipError from create or init,
 *                                        or loadEnabled returned false at boot)
 * ```
 *
 * Every state transition emits `kernel:extension.stateChanged` on the bus.
 * Non-critical failures are isolated so remaining extensions continue to start.
 * Critical extension failures abort boot because the host declared them mandatory.
 *
 * Lifecycle transitions are serialized. Extension lifecycle callbacks must not
 * await another coordinator lifecycle call, because it waits in the same lane.
 *
 * During {@link load}, window manifests are registered into
 * {@link windowRegistry}, tray entries are collected into {@link trayEntries},
 * CLI contributions are collected into {@link cliContributions}, and package
 * namespaces are registered on the bus — but only for entries whose
 * preference-enabled state survives the dependency closure computed by
 * `closeEnabledExtensionEntries` (`extension-entry-closure.ts`), so an entry
 * that can never reach `active` this process never registers surfaces a
 * `cli.execute` or window-open call could otherwise dispatch into, and its
 * namespace can never win a collision against an active entry's or a
 * framework namespace of the same name. Static tray entries are bridged to
 * the tray menu bus service after each extension starts so the tray service
 * can be supplied by the same extension graph.
 *
 * During {@link startAll}, each extension's {@link MakaioExtension.create} factory
 * is called with a `NodeExtensionContext`, followed by `service.init()`.
 * Storage handlers (if any) are registered via
 * `MakaioExtension.storage.registerHandlers` when a `db` instance is
 * provided to the constructor.
 */
export class ExtensionCoordinator {
  private readonly bus: IMakaioBus;
  private readonly surface: ExtensionRuntimeSurface;
  private readonly db: unknown;
  private readonly extensionContextBase:
    | Omit<KernelExtensionContext, 'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'>
    | undefined;
  private readonly runtimeEnvironment: RuntimeEnvironment | undefined;

  /**
   * AbortController signalling graceful shutdown to all active packages.
   *
   * Aborted at the start of {@link shutdown} so packages receive the signal
   * before their services are destroyed.
   */
  private readonly shutdownController = new AbortController();

  /** Insertion-ordered map so iteration matches dependency sort order. */
  private readonly entries: Map<string, ExtensionEntry> = new Map();
  private loadOrder: string[] = [];
  private loaded = false;
  private started = false;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | undefined;
  /** FIFO lane for lifecycle transitions that mutate extension entries. */
  private lifecycleTail: Promise<void> = Promise.resolve();
  private rpcCleanups: Array<() => void> = [];
  private readonly contributionProcessors: ContributionProcessor[] = [];

  /**
   * Transient map from composite key (`toastId:actionId`) to the corresponding
   * {@link ExtensionWarningAction}. Populated during {@link emitWarningsForEntry}
   * and cleared per package before that package's current warning set is
   * recorded, then cleared globally on {@link shutdown}.
   *
   * This map is intentionally coordinator-owned because toast interactions
   * arrive after warning emission and need a short-lived runtime lookup without
   * exposing executable warning actions in the toast payload.
   */
  private readonly warningActionMap: Map<string, ExtensionWarningAction> = new Map();

  /** Window registry populated during {@link load}. */
  public readonly windowRegistry: WindowRegistry = new WindowRegistry();

  private readonly _trayEntries: Array<TrayManifest & { readonly packageName: string }> = [];
  private readonly _cliContributions: CliContribution[] = [];

  private readonly persistEnabled: ((name: string, enabled: boolean) => Promise<void>) | undefined;
  private readonly loadEnabled: ((name: string) => boolean | undefined) | undefined;
  private readonly loadConfig: ((name: string) => Record<string, unknown> | undefined) | undefined;
  private readonly operatorConfig: ExtensionOperatorConfigSource | undefined;
  private readonly runMigrations: ExtensionMigrationRunner | undefined;
  private readonly extensionManagedNames: ReadonlySet<string> | undefined;
  private readonly frameworkPackageNames: ReadonlySet<string> | undefined;

  /**
   * @param bus - Bus instance for emitting lifecycle events and serving the list RPC.
   * @param options - Coordinator configuration.
   */
  public constructor(bus: IMakaioBus, options: ExtensionCoordinatorOptions = {}) {
    this.bus = bus;
    this.surface = options.surface ?? 'headless';
    this.db = options.db;
    this.extensionContextBase = options.extensionContextBase;
    this.runtimeEnvironment = options.runtimeEnvironment;
    this.persistEnabled = options.persistEnabled;
    this.loadEnabled = options.loadEnabled;
    this.loadConfig = options.loadConfig;
    this.operatorConfig = options.operatorConfig;
    this.runMigrations = options.runMigrations;
    this.extensionManagedNames = options.extensionManagedNames;
    this.frameworkPackageNames = options.frameworkPackageNames;
    this.rpcCleanups.push(
      registerWarningActionHandler(this.bus, this.warningActionMap, options.launcherCommand ?? 'makaio'),
    );
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  /**
   * Tray manifest entries collected from packages during {@link load}.
   * @returns Immutable snapshot of all collected tray entries.
   */
  public get trayEntries(): ReadonlyArray<TrayManifest & { readonly packageName: string }> {
    return this._trayEntries.map((entry) => ({ ...entry }));
  }

  /**
   * CLI contributions collected from packages during {@link load}.
   * @returns Immutable snapshot of all collected CLI contributions.
   */
  public get cliContributions(): ReadonlyArray<CliContribution> {
    return this._cliContributions;
  }

  /**
   * Returns extensions that declare HTTP routes.
   * Primarily retained for diagnostics and compatibility with callers that
   * need a snapshot of loaded HTTP surfaces. Runtime route mounting is handled
   * by contribution processors as extensions activate or stop.
   * @returns Loaded extensions that have an `http` field defined.
   */
  public extensionsWithHttp(): ReadonlyArray<{ http: { prefix: string; mount: (app: unknown) => void } }> {
    return extensionsWithHttp(this.entries);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load extension manifests and build the dependency graph.
   *
   * Sets all entries to the `discovered` state and registers the
   * `kernel:extension.list`, `kernel:extension.get`, `kernel:extension.setEnabled`,
   * `cli.listContributions`, and `cli.execute` RPC handlers.
   *
   * Extensions that do not match the coordinator's runtime surface or declared
   * environment requirements are
   * silently excluded. Dependents of excluded extensions are transitively pruned.
   *
   * Window manifests are registered into {@link windowRegistry}, tray entries
   * are collected into {@link trayEntries}, CLI contributions are collected
   * into {@link cliContributions}, and package bus namespaces are registered
   * -- all before any services are started, and all gated by the same
   * dependency closure (see the class-level doc comment above).
   *
   * Single-use: calling this method twice on the same instance throws.
   *
   * The retained names are returned because filtering happens here and nowhere
   * else: a composition root that wants to diagnose what it handed in — an
   * operator config file for an extension this surface excludes, for example —
   * would otherwise have to restate the surface and environment rules and drift
   * from them. They are a result of this call rather than an accessor, so there
   * is no state in which they can be read as "nothing was retained" when in fact
   * nothing has been loaded yet.
   * @param packages - Extension manifests to register.
   * @param configDefaults - Optional map of extension name to default config values
   *   sourced from descriptor.json.
   * @returns The packages actually registered, in load order: the input minus
   *   the ones excluded by surface or environment filtering and their pruned
   *   dependents, with one entry per name — for an accepted core override
   *   (see {@link ExtensionCoordinatorOptions.frameworkPackageNames}), the
   *   overriding registration rather than the framework package it replaced.
   *   The manifests themselves rather than their names, because a caller
   *   matching names back against its own input would re-admit exactly the
   *   overridden registration this dropped.
   * @throws Error if called more than once, if two registrations collide on a
   *   name that is not an overridable framework package name, if a dependency
   *   cycle is detected, or if dependency sorting fails.
   */
  public load(
    packages: ReadonlyArray<KernelMakaioExtension>,
    configDefaults?: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  ): readonly KernelMakaioExtension[] {
    if (this.shutdownRequested) {
      throw new Error('ExtensionCoordinator.load() called after shutdown(). The coordinator is terminal.');
    }
    if (this.loaded) {
      throw new Error(
        'ExtensionCoordinator.load() called twice. ' +
          'The coordinator is single-use; create a new instance if needed.',
      );
    }

    const eligible = coalesceExtensionOverrides(
      filterEligibleExtensions(packages, this.surface, this.runtimeEnvironment),
      this.frameworkPackageNames,
    );

    // Resolve preference-enabled names before sorting: `topoSort` scopes its
    // fatal graph validation (missing dependency, incompatible version,
    // cycle) to this same set, so a disabled entry's own broken dependency
    // graph is recorded as a warning on that entry instead of aborting boot
    // for the rest of the fleet. See `resolveBootEnabledNames` and
    // `topoSort`'s `enabledNames` option.
    const { enabled: bootEnabledNames } = resolveBootEnabledNames(
      eligible,
      this.extensionManagedNames,
      this.loadEnabled,
    );
    const softValidationWarnings = new Map<string, string[]>();
    this.loadOrder = topoSort(eligible, {
      enabledNames: bootEnabledNames,
      onSoftValidationWarning: (name, message) => {
        const existing = softValidationWarnings.get(name);
        if (existing) existing.push(message);
        else softValidationWarnings.set(name, [message]);
      },
    });

    const retained: KernelMakaioExtension[] = [];
    const orderedEntries: Array<{ readonly name: string; readonly entry: ExtensionEntry }> = [];
    for (const name of this.loadOrder) {
      const pkg = eligible.find((p) => p.name === name)!;
      retained.push(pkg);
      const warningMessages = softValidationWarnings.get(name);
      const entry: ExtensionEntry = {
        pkg,
        identity: createExtensionIdentity(pkg.name),
        state: 'discovered',
        enabled: bootEnabledNames.has(name),
        extensionManaged: this.extensionManagedNames?.has(name) ?? true,
        warnings: [],
        // A disabled entry whose graph validation was downgraded from fatal
        // to a warning (see above) records it here so it is visible to a
        // re-enable attempt even before this entry reaches `'skipped'` at
        // `startAll()`. See `ExtensionEntry.error`'s own TSDoc.
        ...(warningMessages ? { error: warningMessages.join('; ') } : {}),
      };
      if (configDefaults) {
        const defaults = configDefaults.get(name);
        if (defaults) entry.configDefaults = defaults;
      }
      this.entries.set(name, entry);
      orderedEntries.push({ name, entry });
    }

    // Only collect static surfaces (windows, tray, CLI) and register bus
    // namespaces for entries whose preference-enabled state survives the
    // dependency closure. A disabled entry is registered so it is observable
    // and toggleable, but enabling it only ever takes effect on the next
    // process restart — see the persist-only `setEnabled` contract in
    // `extension-toggle.ts` — so there is no live path that ever needs its
    // surfaces collected or its namespace registered before then. A
    // preference-enabled entry whose required, non-optional dependency is
    // disabled is no different in outcome: `startExtensionEntry`'s own
    // dependency check refuses it before it ever reaches `active`, so
    // registering its windows/tray/CLI now would let e.g. `cli.execute`
    // dispatch into code that is guaranteed never to run this process, and
    // registering its namespace now would let its routing metadata collide
    // with — and abort boot for — an active entry's or framework namespace of
    // the same name, defeating disabling the excluded entry as a recovery
    // path. See {@link closeEnabledExtensionEntries} for the closure this
    // mirrors.
    const { closed: surfaceEligibleNames, exclusions } = closeEnabledExtensionEntries(orderedEntries);
    for (const { name, missingDependencies } of exclusions) {
      console.warn(
        '[ExtensionCoordinator] Excluding extension "%s" from static surface collection and namespace registration: required dependency %s is disabled',
        name,
        missingDependencies.join(', '),
      );
    }
    for (const { name, entry } of orderedEntries) {
      if (!surfaceEligibleNames.has(name)) continue;
      if (entry.pkg.namespaces) {
        this.bus.registerNamespaces(entry.pkg.namespaces);
      }
      collectExtensionSurfaces(
        {
          windowRegistry: this.windowRegistry,
          trayEntries: this._trayEntries,
          cliContributions: this._cliContributions,
        },
        entry.pkg,
      );
      entry.surfacesCollected = true;
    }

    this.registerRpcHandlers();
    this.loaded = true;
    return retained;
  }

  /**
   * Register the `kernel:extension.*` and `cli.*` RPC handlers on the bus.
   *
   * Extracted out of {@link load} purely to stay within that method's line
   * budget; it has no meaning independent of the single call site there.
   */
  private registerRpcHandlers(): void {
    this.rpcCleanups.push(
      ...registerCoordinatorRpcHandlers({
        bus: this.bus,
        entries: this.entries,
        cliContributions: this._cliContributions,
        list: () => this.list(),
        getInfo: (name) => this.getInfo(name),
        handleSetEnabled: (name, enabled) => this.handleSetEnabled(name, enabled),
      }),
    );
  }

  /**
   * Start all loaded packages in dependency order.
   *
   * For each package the state machine advances:
   * `discovered -> initializing -> active | failed | skipped`
   *
   * Failures are isolated: a package that throws during `create` or `init` is
   * set to `failed` and the error is captured, but remaining packages continue
   * to start unless the package declares `critical: true`.
   *
   * Single-use: calling this method twice on the same instance throws.
   * @throws Error if called more than once, before {@link load}, or when a
   *   critical package fails.
   */
  public async startAll(): Promise<void> {
    if (this.shutdownRequested) {
      throw new Error('ExtensionCoordinator.startAll() called after shutdown(). The coordinator is terminal.');
    }
    if (!this.loaded) {
      throw new Error('ExtensionCoordinator.startAll() called before load(). Call load() first.');
    }
    if (this.started) {
      throw new Error(
        'ExtensionCoordinator.startAll() called twice. ' +
          'The coordinator is single-use; create a new instance if needed.',
      );
    }
    this.started = true;

    await this.enqueueLifecycle(() => this.startAllInLifecycleLane());
  }

  /** Run the admitted startup transition in the coordinator lifecycle lane. */
  private async startAllInLifecycleLane(): Promise<void> {
    const bootProgress = new BootProgressObserver(this.bus, this.loadOrder.length);
    this.rpcCleanups.push(() => bootProgress.dispose());

    try {
      await runExtensionMigrations({
        loadOrder: this.loadOrder,
        entries: this.entries,
        runMigrations: this.runMigrations,
      });

      for (const name of this.loadOrder) {
        const entry = this.entries.get(name);
        if (!entry) continue;
        await startExtensionEntry(
          {
            bus: this.bus,
            db: this.db,
            entries: this.entries,
            contributionProcessors: this.contributionProcessors,
            contextHost: this.createExtensionContextHost(),
            bootProgress,
          },
          name,
          entry,
        );
      }

      const healthHost = this.createExtensionHealthHost();
      await Promise.all(
        this.loadOrder.map((name) => {
          const entry = this.entries.get(name);
          return entry?.state === 'active' ? runExtensionHealthCheck(healthHost, name) : undefined;
        }),
      );

      await emitWarnings({ bus: this.bus, entries: this.entries, warningActionMap: this.warningActionMap });
    } finally {
      bootProgress.complete();
    }
  }

  /**
   * Shut down all active packages in reverse dependency order.
   *
   * Calls each package's service `destroy()` method (if any). A teardown
   * failure does not stop remaining packages from shutting down, but it is
   * reported: once every package has been stopped, all failures are thrown
   * together so the caller can treat termination as unclean.
   *
   * Safe to call even if {@link startAll} was never called.
   * @returns A promise that settles after every admitted transition and teardown complete.
   * @throws An AggregateError when any package failed to shut down cleanly.
   */
  public shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    // Teardown must never overtake admitted lifecycle work: contribution
    // factories and service initialization can still own resources until that
    // work settles. Hosts may impose a hard process-exit deadline, while this
    // coordinator signals cooperative cancellation and preserves serialization.
    // Mark terminal and reserve the sole teardown promise before aborting.
    // Abort listeners run synchronously and can re-enter shutdown().
    this.shutdownRequested = true;
    const shutdownPromise = this.enqueueLifecycle(() => this.shutdownInLifecycleLane());
    this.shutdownPromise = shutdownPromise;
    // Signal all active packages to cancel long-running operations before
    // their services are destroyed. The queued callback cannot begin until the
    // current turn completes, so this still precedes teardown.
    this.shutdownController.abort();

    return shutdownPromise;
  }

  /** Run shutdown after every lifecycle transition admitted before shutdown. */
  private async shutdownInLifecycleLane(): Promise<void> {
    const failures: unknown[] = [];
    let extensionShutdownSummary: string | undefined;
    for (const cleanup of this.rpcCleanups) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    this.rpcCleanups = [];
    this.warningActionMap.clear();

    try {
      await shutdownExtensions({
        entries: this.entries,
        loadOrder: this.loadOrder,
        contributionProcessors: this.contributionProcessors,
        contextHost: this.createExtensionContextHost(),
      });
    } catch (error) {
      if (error instanceof AggregateError) {
        extensionShutdownSummary = error.message;
        failures.push(...error.errors);
      } else {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      const summary = extensionShutdownSummary === undefined ? '' : `; ${extensionShutdownSummary}`;
      throw new AggregateError(
        failures,
        `Extension coordinator shutdown failed with ${failures.length} error(s)${summary}`,
      );
    }
  }

  /**
   * Return the current state snapshot for all registered packages.
   * @returns Array of {@link ExtensionInfo} objects reflecting current observable states.
   */
  public list(): ExtensionInfo[] {
    return [...this.entries.values()].map((entry) => entryToExtensionInfo(entry, this.loadEnabled));
  }

  /**
   * Return the current state snapshot for a single named package.
   *
   * Backs the `kernel:extension.get` RPC (see `coordinator-rpc-handlers.ts`)
   * so that handler does not need its own access to {@link loadEnabled} to
   * populate `ExtensionInfo.persistedEnabled`.
   * @param name - Extension name to look up.
   * @returns The {@link ExtensionInfo} snapshot, or `null` when unknown.
   */
  public getInfo(name: string): ExtensionInfo | null {
    const entry = this.entries.get(name);
    return entry ? entryToExtensionInfo(entry, this.loadEnabled) : null;
  }

  /**
   * Retrieve the live service instance for a named extension.
   * @param tokenOrName - Extension token or extension name string.
   * @returns The active service instance, or `undefined`.
   */
  public getExtensionService<TService = ExtensionService>(
    tokenOrName: string | ExtensionToken<TService>,
  ): TService | undefined {
    const name = typeof tokenOrName === 'string' ? tokenOrName : tokenOrName.name;
    return this.entries.get(name)?.service as TService | undefined;
  }

  /**
   * Look up a loaded extension by name.
   * @param name - Extension name.
   * @returns The extension, or `undefined` if not loaded.
   */
  public getExtension(name: string): KernelMakaioExtension | undefined {
    return this.entries.get(name)?.pkg;
  }

  /**
   * Return the schema-parsed effective config for a loaded extension.
   *
   * Runs the same resolution path the kernel uses at activation, in `'observe'`
   * mode, so every schema transform (e.g. `.trim()`) is reflected in the
   * returned values. This is the correct source for building provenance
   * snapshots — never the raw operator layer, which may not match what the
   * extension actually received.
   *
   * Deliberately state-neutral. Resolution composes the configuration layers
   * and nothing else: it needs no live service, no context, and no running
   * lifecycle, so a disabled, stopped, failed, or not-yet-started extension
   * resolves exactly like a running one. A settings surface is precisely where
   * an extension gets toggled off, and it must not start reporting different
   * values the moment it does.
   * Reports how the configuration was reached, because the two outcomes are
   * not interchangeable for a settings surface: when the merged configuration
   * is rejected, resolution falls back to the schema's own defaults with every
   * layer discarded, and reporting those as effective values would attribute
   * schema defaults to whichever layer supplied them.
   * @param name - Extension name.
   * @returns The resolution, or `undefined` when no extension is loaded under
   *   `name`. Its `config` is `undefined` when the extension declares no
   *   `configSchema`, or when the merged configuration is rejected by the
   *   schema and the schema-default fallback parse fails as well.
   */
  public getResolvedConfig(name: string): ExtensionConfigResolution | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return resolveExtensionEntryConfigOutcome(this.createExtensionContextHost(), name, entry, 'observe');
  }

  /**
   * Collect provider definition IDs from extensions that can still provide them.
   *
   * Active entries are already visible through the contribution catalog.
   * Enabled `discovered` and `initializing` entries are still eligible to
   * activate later in the same boot or enablement pass, so adapters should
   * defer for their providers. Disabled and terminal inactive entries are
   * excluded so optional-provider adapters do not wait on providers that
   * cannot become catalog-visible.
   * @returns Set of provider definition IDs from active or activation-eligible extensions.
   */
  public getLoadedProviderDefinitionIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;
      if (entry.state === 'failed' || entry.state === 'skipped' || entry.state === 'stopped') continue;
      for (const provider of entry.pkg.providers ?? []) {
        ids.add(provider.id);
      }
    }
    return ids;
  }

  /**
   * Iterate all active extensions in dependency order with their contexts.
   *
   * Intended for host-owned integration code that needs a snapshot of active
   * packages after the coordinator has completed startup.
   *
   * Configuration is resolved in observe mode, so a configuration that has since
   * become invalid degrades that extension's `ctx.config` to schema defaults
   * rather than throwing and abandoning the rest of the iteration.
   * @param callback - Called once per active extension with its name, manifest,
   *   and a per-extension `NodeExtensionContext`.
   */
  public forEachActiveExtension(
    callback: (name: string, pkg: KernelMakaioExtension, ctx: KernelExtensionContext) => void,
  ): void {
    const contextHost = this.createExtensionContextHost();
    for (const name of this.loadOrder) {
      const entry = this.entries.get(name);
      if (!entry || entry.state !== 'active') continue;
      const config = resolveExtensionEntryConfig(contextHost, name, entry, 'observe');
      const pkgCtx = buildExtensionContext(contextHost, entry, config);
      callback(name, entry.pkg, pkgCtx);
    }
  }

  /**
   * Invoke a callback for a single active extension with its resolved context.
   *
   * Singular complement to {@link forEachActiveExtension} for targeted operations
   * after an extension is re-enabled, and resolves configuration in the same
   * non-throwing observe mode.
   * No-ops when the extension is not found or not in `active` state.
   * @param name - Name of the extension to target.
   * @param callback - Called with the extension name, manifest, and a
   *   per-extension `NodeExtensionContext` when the extension is active.
   */
  public forExtension(
    name: string,
    callback: (name: string, pkg: KernelMakaioExtension, ctx: KernelExtensionContext) => void,
  ): void {
    const entry = this.entries.get(name);
    if (!entry || entry.state !== 'active') return;
    const contextHost = this.createExtensionContextHost();
    const config = resolveExtensionEntryConfig(contextHost, name, entry, 'observe');
    const pkgCtx = buildExtensionContext(contextHost, entry, config);
    callback(name, entry.pkg, pkgCtx);
  }

  /**
   * Register an awaited contribution processor.
   *
   * The processor's `processActivated` method is called
   * (and awaited) each time an extension transitions to `active` — both during
   * {@link startAll} and on a coordinator-internal restart via
   * {@link applyExtensionTransition} (`true`).
   *
   * `processStopped` (when present) is called before
   * the extension's service is destroyed during {@link shutdown} or a
   * coordinator-internal restart via {@link applyExtensionTransition}
   * (`false`).
   *
   * Processors run in registration order during activation and reverse
   * registration order during deactivation. During activation, processor errors
   * cause the extension to transition to `failed` with rollback of
   * already-activated contributions. During deactivation, errors are caught and
   * logged (best-effort).
   * @param processor - Processor to register.
   * @returns Cleanup function that removes the processor from the registry.
   */
  public registerContributionProcessor(processor: ContributionProcessor): () => void {
    this.contributionProcessors.push(processor);
    return () => {
      const idx = this.contributionProcessors.indexOf(processor);
      if (idx >= 0) this.contributionProcessors.splice(idx, 1);
    };
  }

  /**
   * Handle the `kernel:extension.setEnabled` RPC by durably recording the
   * operator's enablement preference for an extension.
   *
   * This is the operator-preference seam, and it is **persist-only**: it
   * never runs a live state-machine transition. It persists the requested
   * preference (refusing outright to disable a `critical` extension, or when
   * this coordinator was constructed without a `persistEnabled` writer) and
   * reports whether the process's current runtime state already matches it.
   * See {@link handleSetEnabledImpl} for the full rationale — several package
   * contributions are composed exactly once at boot and cannot be replayed
   * for one package in isolation while the process keeps running.
   * Coordinator-internal or product-internal callers that need to actually
   * restart an already-started extension as part of their own mechanics
   * should call {@link applyExtensionTransition} instead.
   * @param name - Name of the extension to toggle.
   * @param enabled - `true` to enable, `false` to disable.
   * @returns A {@link SetEnabledResult}: `success` is `true` when the
   *   preference already matches the runtime state and `false` when the
   *   request was rejected or can only take effect on the next process
   *   restart; `outcome` always carries the underlying {@link TransitionOutcome}
   *   (`'applied'`, `'rejected'`, or `'restart-required'`) so callers can tell
   *   those two `false` cases apart.
   * @throws Error when `enabled` is `false` and the extension is `critical`,
   *   or when this coordinator has no durable `persistEnabled` writer.
   */
  public async handleSetEnabled(name: string, enabled: boolean): Promise<SetEnabledResult> {
    if (this.shutdownRequested) return { success: false, outcome: 'rejected' };

    return await this.enqueueLifecycle(() => handleSetEnabledImpl(this.createToggleHost(), name, enabled));
  }

  /**
   * Enable or disable an already-boot-started extension without touching
   * operator preference.
   *
   * This is the coordinator-internal lifecycle primitive: it does not persist
   * anything and does not refuse a `critical` extension, but it does run the
   * real state-machine transition (unlike {@link handleSetEnabled}, which is
   * persist-only). Use it when a restart is part of the coordinator's own
   * mechanics rather than an operator-originated request — for example a
   * dependency registry that restarts a `critical` extension built to survive
   * that gap (see the `automation-trigger` binding runtime package for the
   * canonical example). It refuses to activate an extension boot skipped
   * entirely (never started `create`/`init` this process) — see the
   * boot-skip guard in `enableExtension` — because that entry's boot-only
   * contribution surfaces were never composed in the first place.
   * @param name - Name of the extension to toggle.
   * @param enabled - `true` to enable, `false` to disable.
   * @returns The transition outcome: `'applied'` or `'rejected'`.
   */
  public async applyExtensionTransition(
    name: string,
    enabled: boolean,
  ): Promise<Exclude<TransitionOutcome, 'restart-required'>> {
    if (this.shutdownRequested) return 'rejected';

    return await this.enqueueLifecycle(() => applyExtensionTransitionImpl(this.createToggleHost(), name, enabled));
  }

  /**
   * Build the {@link ToggleHost} surface shared by {@link handleSetEnabled} and
   * {@link applyExtensionTransition}.
   *
   * Centralizing this avoids the two toggle entry points drifting out of sync
   * on which coordinator state the toggle helpers can see.
   * @returns Host surface for the toggle lifecycle helpers.
   */
  private createToggleHost(): ToggleHost {
    return {
      ...this.createExtensionContextHost(),
      db: this.db,
      entries: this.entries,
      persistEnabled: this.persistEnabled,
      contributionProcessors: this.contributionProcessors,
      runHealthCheck: (n) => runExtensionHealthCheck(this.createExtensionHealthHost(), n),
      emitWarningsForEntry: (n, entry) =>
        emitWarningsForEntry(
          { bus: this.bus, entries: this.entries, warningActionMap: this.warningActionMap },
          n,
          entry,
        ),
    };
  }

  /**
   * Schedule a lifecycle transition after every previously admitted transition.
   *
   * The tail recovers from failures so one rejected operation cannot strand
   * later shutdown or toggle work behind a rejected promise.
   * @param operation - Lifecycle transition to run exclusively.
   * @returns The operation's result.
   */
  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(
      () => operation(),
      () => operation(),
    );
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Create the shared extension-context helper host without exposing coordinator internals.
   * @returns Helper host for config resolution and ExtensionContext construction.
   */
  private createExtensionContextHost(): ExtensionContextHost {
    return {
      bus: this.bus,
      extensionContextBase: this.extensionContextBase,
      loadConfig: this.loadConfig,
      operatorConfig: this.operatorConfig,
      signal: this.shutdownController.signal,
      hasActiveExtension: (name: string): boolean => this.hasActiveExtension(name),
      getExtensionService: <T>(name: string): T | undefined => this.getExtensionService<T>(name),
    };
  }

  /**
   * Create the helper host for extension health checks.
   * @returns Coordinator state required by the health runner.
   */
  private createExtensionHealthHost(): ExtensionHealthHost {
    return {
      bus: this.bus,
      entries: this.entries,
    };
  }

  /**
   * Check whether an extension has reached active state.
   * @param name - Extension name to check.
   * @returns `true` when the extension is active.
   */
  private hasActiveExtension(name: string): boolean {
    return this.entries.get(name)?.state === 'active';
  }
}
