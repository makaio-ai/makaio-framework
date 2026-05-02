/* eslint max-lines: ["error", { "max": 490, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import type {
  MakaioExtension,
  ExtensionService,
  ExtensionToken,
  NodeExtensionContext,
  TrayManifest,
} from '@makaio/contracts';
import type { ExtensionWarningAction } from '@makaio/contracts/extension';
import type { CliContribution } from '../cli/types.js';
import { BootProgressObserver } from './boot-progress-observer.js';
import { registerWarningActionHandler } from './warning-action-dispatcher.js';
import { registerCoordinatorRpcHandlers } from './coordinator-rpc-handlers.js';
import { emitWarnings, emitWarningsForEntry } from './health-warning-emitter.js';
import { entryToExtensionInfo } from './extension-info.js';
import { createExtensionIdentity } from './extension-identity-builder.js';
import { handleSetEnabled as handleSetEnabledImpl } from './extension-toggle.js';
import { coalesceExtensionOverrides, filterEligibleExtensions } from './extension-selection.js';
import { WindowRegistry } from '../window/window-registry.js';
import { topoSort } from './topo-sort.js';
import type {
  ContributionProcessor,
  ExtensionCoordinatorOptions,
  ExtensionEntry,
  ExtensionRuntimeSurface,
} from './types.js';
import type { ExtensionInfo } from '../observability/shared-schemas.js';
import {
  buildExtensionContext,
  type ExtensionContextHost,
  resolveExtensionEntryConfig,
} from './extension-context-builder.js';
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
 * During {@link load}, window manifests are registered into
 * {@link windowRegistry}, tray entries are collected into {@link trayEntries},
 * and CLI contributions are collected into {@link cliContributions}. Static
 * tray entries are bridged to the tray menu bus service after each extension
 * starts so the tray service can be supplied by the same extension graph.
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
    | Omit<NodeExtensionContext, 'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'>
    | undefined;
  private readonly capabilities: ReadonlySet<string> | undefined;

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
  private readonly runMigrations: ExtensionMigrationRunner | undefined;

  /**
   * @param bus - Bus instance for emitting lifecycle events and serving the list RPC.
   * @param options - Coordinator configuration.
   */
  public constructor(bus: IMakaioBus, options: ExtensionCoordinatorOptions = {}) {
    this.bus = bus;
    this.surface = options.surface ?? 'headless';
    this.db = options.db;
    this.extensionContextBase = options.extensionContextBase;
    this.capabilities = options.capabilities;
    this.persistEnabled = options.persistEnabled;
    this.loadEnabled = options.loadEnabled;
    this.loadConfig = options.loadConfig;
    this.runMigrations = options.runMigrations;
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
   * are collected into {@link trayEntries}, and CLI contributions are collected
   * into {@link cliContributions} -- all before any services are started.
   *
   * Single-use: calling this method twice on the same instance throws.
   * @param packages - Extension manifests to register.
   * @param configDefaults - Optional map of extension name to default config values
   *   sourced from descriptor.json.
   * @throws Error if called more than once, if a dependency cycle is detected,
   *   or if dependency sorting fails.
   */
  public load(
    packages: ReadonlyArray<MakaioExtension>,
    configDefaults?: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  ): void {
    if (this.loaded) {
      throw new Error(
        'ExtensionCoordinator.load() called twice. ' +
          'The coordinator is single-use; create a new instance if needed.',
      );
    }

    const eligible = coalesceExtensionOverrides(filterEligibleExtensions(packages, this.surface, this.capabilities));
    this.loadOrder = topoSort(eligible);

    for (const name of this.loadOrder) {
      const pkg = eligible.find((p) => p.name === name)!;
      const entry: ExtensionEntry = {
        pkg,
        identity: createExtensionIdentity(pkg.name),
        state: 'discovered',
        enabled: this.loadEnabled?.(name) !== false,
        warnings: [],
      };
      if (configDefaults) {
        const defaults = configDefaults.get(name);
        if (defaults) entry.configDefaults = defaults;
      }
      this.entries.set(name, entry);
      collectExtensionSurfaces(
        {
          windowRegistry: this.windowRegistry,
          trayEntries: this._trayEntries,
          cliContributions: this._cliContributions,
        },
        pkg,
      );
    }

    this.rpcCleanups.push(
      ...registerCoordinatorRpcHandlers({
        bus: this.bus,
        entries: this.entries,
        cliContributions: this._cliContributions,
        list: () => this.list(),
        handleSetEnabled: (name, enabled) => this.handleSetEnabled(name, enabled),
      }),
    );
    this.loaded = true;
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
   * Calls each package's service `destroy()` method (if any). Errors are
   * logged but do not stop remaining packages from shutting down.
   *
   * Safe to call even if {@link startAll} was never called.
   */
  public async shutdown(): Promise<void> {
    // Signal all active packages to cancel long-running operations before
    // their services are destroyed.
    this.shutdownController.abort();

    for (const cleanup of this.rpcCleanups) {
      cleanup();
    }
    this.rpcCleanups = [];
    this.warningActionMap.clear();

    await shutdownExtensions({
      entries: this.entries,
      loadOrder: this.loadOrder,
      contributionProcessors: this.contributionProcessors,
      contextHost: this.createExtensionContextHost(),
    });
  }

  /**
   * Return the current state snapshot for all registered packages.
   * @returns Array of {@link ExtensionInfo} objects reflecting current observable states.
   */
  public list(): ExtensionInfo[] {
    return [...this.entries.values()].map((entry) => entryToExtensionInfo(entry));
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
  public getExtension(name: string): MakaioExtension | undefined {
    return this.entries.get(name)?.pkg;
  }

  /**
   * Iterate all active extensions in dependency order with their contexts.
   *
   * Intended for host-owned integration code that needs a snapshot of active
   * packages after the coordinator has completed startup.
   * @param callback - Called once per active extension with its name, manifest,
   *   and a per-extension `NodeExtensionContext`.
   */
  public forEachActiveExtension(
    callback: (name: string, pkg: MakaioExtension, ctx: NodeExtensionContext) => void,
  ): void {
    const contextHost = this.createExtensionContextHost();
    for (const name of this.loadOrder) {
      const entry = this.entries.get(name);
      if (!entry || entry.state !== 'active') continue;
      const config = resolveExtensionEntryConfig(contextHost, name, entry);
      const pkgCtx = buildExtensionContext(contextHost, entry, config);
      callback(name, entry.pkg, pkgCtx);
    }
  }

  /**
   * Invoke a callback for a single active extension with its resolved context.
   *
   * Singular complement to {@link forEachActiveExtension} for targeted operations
   * after an extension is re-enabled.
   * No-ops when the extension is not found or not in `active` state.
   * @param name - Name of the extension to target.
   * @param callback - Called with the extension name, manifest, and a
   *   per-extension `NodeExtensionContext` when the extension is active.
   */
  public forExtension(
    name: string,
    callback: (name: string, pkg: MakaioExtension, ctx: NodeExtensionContext) => void,
  ): void {
    const entry = this.entries.get(name);
    if (!entry || entry.state !== 'active') return;
    const contextHost = this.createExtensionContextHost();
    const config = resolveExtensionEntryConfig(contextHost, name, entry);
    const pkgCtx = buildExtensionContext(contextHost, entry, config);
    callback(name, entry.pkg, pkgCtx);
  }

  /**
   * Register an awaited contribution processor.
   *
   * The processor's `processActivated` method is called
   * (and awaited) each time an extension transitions to `active` — both during
   * {@link startAll} and on re-enable via `kernel:extension.setEnabled(true)`.
   *
   * `processStopped` (when present) is called before
   * the extension's service is destroyed during {@link shutdown} or
   * `kernel:extension.setEnabled(false)`.
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
   * Handle the `kernel:extension.setEnabled` RPC by enabling or disabling an extension.
   *
   * Public so the extracted RPC handler module can call it. Delegates to the
   * shared toggle lifecycle helper.
   * @param name - Name of the extension to toggle.
   * @param enabled - `true` to enable, `false` to disable.
   * @returns `true` on success, `false` when the state machine rejects.
   */
  public async handleSetEnabled(name: string, enabled: boolean): Promise<boolean> {
    return handleSetEnabledImpl(
      {
        bus: this.bus,
        db: this.db,
        entries: this.entries,
        extensionContextBase: this.extensionContextBase,
        loadConfig: this.loadConfig,
        signal: this.shutdownController.signal,
        hasActiveExtension: (n: string): boolean => this.hasActiveExtension(n),
        persistEnabled: this.persistEnabled,
        contributionProcessors: this.contributionProcessors,
        getExtensionService: <T>(n: string) => this.getExtensionService<T>(n),
        runHealthCheck: (n) => runExtensionHealthCheck(this.createExtensionHealthHost(), n),
        emitWarningsForEntry: (n, entry) =>
          emitWarningsForEntry(
            { bus: this.bus, entries: this.entries, warningActionMap: this.warningActionMap },
            n,
            entry,
          ),
      },
      name,
      enabled,
    );
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
