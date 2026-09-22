/* eslint-disable max-lines -- composition root that aggregates all framework services */
/**
 * Makaio runtime boot sequence.
 *
 * Extracts the shared startup logic from the CLI serve composition root into
 * a reusable function that can be driven by any host (CLI, Electron, tests)
 * that already owns an HTTP server and Hono app.
 *
 * Startup sequence:
 *  0. Makaio home resolution + operator extension config snapshot (read once from
 *     `<makaioHome>/config/extensions/`; an unlistable directory fails boot here,
 *     before anything has started) + enablement store (read from
 *     `<makaioHome>/config/extensions.json`; missing or corrupt file defaults to
 *     all-extensions-enabled with a console warning)
 *  1. Config + identity resolution (including machineId mismatch guard)
 *  2. Bus creation (MakaioBus singleton) + namespace registration + busCreated phase event
 *  3. Transport — BusServerTransportProvider (WebSocket bus server on provided HTTP server)
 *  4. Storage — initializeNodeDatabase (SQLite file or Postgres URL) + RuntimeSubjects.database exposure
 *  5. Runtime resource bus handler registration
 *  6. Config handlers + framework package assembly
 *  7. Extension discovery and loading
 *  8. ExtensionCoordinator — all extensions (storage + services, surface-gated)
 *  9. Adapter runtime identity
 * 10. Host coordinator-ready broadcast
 * 11. E2E auth hot-swap (LAN mode only)
 * 12. Ready phase event
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MakaioBus } from '@makaio/bus-core';
import {
  ExtensionCoordinator,
  createShutdownSequence,
  BootNamespace,
  ExtensionNamespace,
  KernelNamespace,
  type KernelMakaioExtension,
} from '@makaio/kernel';
import { CliNamespace } from '@makaio/kernel/cli';
import { RuntimeSubjects, RuntimeNamespace } from './bus/runtime/namespace.js';
import { BusServerTransportProvider } from './bus-server-transport.js';
import { FileConfigStorage } from './file-config-storage.js';
import { NodeRuntimeProvider } from './node-runtime-provider.js';
import { loadOrCreateMachineIdentity } from '@makaio/machine-identity';
import { resolveExtensionOptions } from './resolve-extension-options.js';
import { type ShutdownStep } from './boot-phase.js';
import { initializeNodeDatabase } from './initialize-node-database.js';
import { KernelSubjects } from '@makaio/kernel/namespace';
import {
  AdapterSubsystemToken,
  FileAdapterConfigRepository,
  orderAfterAdapterSubsystem,
  type AdapterSubsystemService,
} from '@makaio/subsystem-adapter';
import {
  createModelRegistryPackage,
  createArtifactKindContributionProcessor,
  createArtifactLifecycleHookContributionProcessor,
  createFacetNamespaceContributionProcessor,
  createReactionContributionProcessor,
  createToolContributionProcessor,
  createTransitionContributionProcessor,
  createWorkflowBlockContributionProcessor,
  frameworkCorePackages,
  FrameworkServicesCoreNamespaces,
  ModelRegistryToken,
} from '@makaio/services-core';
import {
  AutomationCronSchedulerToken,
  createAutomationTriggerContributionProcessor,
  selectAutomationCronSchedulerPackage,
} from '@makaio/services-core/automation-trigger';
import {
  createArtifactViewBuilderContributionProcessor,
  createSurfaceBindingContributionProcessor,
} from '@makaio/services-core/materialization';
import { createLogImportContributionProcessor, logImportRegistryPackage } from '@makaio/services-log-import';
import { createWorkflowEnginePackage, WorkflowEngineToken } from '@makaio/subsystem-workflow-engine/package';
import { createPackageManagerPackage } from '@makaio/services-package-manager/package';
import { createHttpContributionProcessor } from './http-contribution-processor.js';
import { resolveMakaioHome } from './makaio-config.js';
import { preferencesStoragePackage } from '@makaio/preferences/package';
import { ClientsCoreToken, createClientsCorePackage } from '@makaio/subsystem-client';
import { createNodeClientBinaryStrategyDependencies } from './client-binary-strategy-dependencies.js';
import { cliDetectionPackage } from './cli-detection/package.js';
import { activateAdapterRuntimeIdentity, prepareAdapterRuntime } from './compose-adapter-runtime.js';
import { tryImport } from './optional-package.js';
import { registerRuntimeHandlers } from './register-runtime-handlers.js';
import {
  filterConfigDefaultsForLoadedPackages,
  mergePackageConfigDefaults,
  registerConfigHandlers,
} from './boot-config.js';
import {
  loadExtensionOperatorConfig,
  warnOnUnaddressableExtensionOperatorConfigNames,
  warnOnUnappliedExtensionOperatorConfig,
} from './extension-operator-config.js';
import { loadExtensionEnablementStore } from './extension-enablement-store.js';
import { createBootModelRegistryFetcher } from './boot-model-registry.js';
import { ensureFrameworkPackageLink } from './framework-package-link.js';
import {
  buildRuntimeEnvironment,
  collectHostCleanups,
  composeBootExtensionSelection,
  normalizeNodeHostCapabilities,
  parseSkipExtensions,
  registerExtensionBootContributions,
  selectEligibleAutomationCronSchedulerHostPackages,
  selectBootEligibleExtensionPackages,
  selectExtensionManagedEnabledPackages,
  selectFrameworkCorePackages,
} from './boot-extension-selection.js';
import { loadBootExtensions } from './boot-extension-loading.js';
import { readFrameworkVersion } from './read-framework-version.js';
import { runBootExtensionMigrations } from './boot-extension-migrations.js';
import { createBootE2EAuth } from './boot-e2e-auth.js';
import { attachUpstreamTelemetry } from './upstream-telemetry.js';
import { StoredCredentialProvider } from './credential-provider.js';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
  registerWorkerProvider,
  unregisterWorkerProvider,
} from '@makaio/contracts';
import {
  ThinWorkflowPiscinaRunner,
  PiscinaThinWorkflowProvider,
  createWorkflowLaunchResolver,
  resolveWorkflowWorkerEntry,
  createNodeWorkflowRunnerPackageOptions,
} from './workflow-worker/index.js';
import type {
  BootMakaioRuntimeOptions,
  CoreBootOptions,
  MakaioRuntime,
  ServerTransportProvider,
} from './boot-types.js';

export { filterConfigDefaultsForLoadedPackages, mergePackageConfigDefaults } from './boot-config.js';
export {
  buildRuntimeEnvironment,
  normalizeNodeHostCapabilities,
  registerExtensionBootContributions,
  selectFrameworkCorePackages,
} from './boot-extension-selection.js';
export type {
  BootCoordinatorSetupContext,
  BootMakaioRuntimeOptions,
  CoreBootOptions,
  MakaioRuntime,
  ServerTransportProvider,
  TransportReadyInfo,
  WorkflowRunnerBootOptions,
} from './boot-types.js';

/**
 * Compose dynamic extension workspace roots with an explicit host fallback.
 * @param resolveDynamicWorkspaceRoot - Late-bound resolver supplied by active extensions.
 * @param fallbackResolvers - Ordered explicit host resolvers retained as fallbacks.
 * @returns Resolver that prefers dynamic registrations and falls back to the host resolver.
 */
export function createCompositeWorkspaceRootResolver(
  resolveDynamicWorkspaceRoot: (workspaceId: string) => Promise<string | undefined>,
  ...fallbackResolvers: ReadonlyArray<CoreBootOptions['piscinaWorkspaceRootResolver']>
): NonNullable<CoreBootOptions['piscinaWorkspaceRootResolver']> {
  return async (workspaceId) => {
    const dynamicRoot = await resolveDynamicWorkspaceRoot(workspaceId);
    if (dynamicRoot !== undefined) return dynamicRoot;
    for (const resolver of fallbackResolvers) {
      const fallbackRoot = await resolver?.(workspaceId);
      if (fallbackRoot !== undefined) return fallbackRoot;
    }
    return undefined;
  };
}

/**
 * Build the loopback URL child processes should use to connect to the host bus.
 * @param host - Bound server host from the composition root.
 * @param port - Bound server port.
 * @returns WebSocket URL for the runtime bus endpoint.
 */
export function buildLocalBusUrl(host: string, port: number): string {
  const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const urlHost = connectHost.includes(':') && !connectHost.startsWith('[') ? `[${connectHost}]` : connectHost;
  return `ws://${urlHost}:${port}/bus`;
}

// ---------------------------------------------------------------------------
// Boot functions
// ---------------------------------------------------------------------------

/**
 * Platform-agnostic Makaio runtime boot core.
 *
 * Runs the full startup sequence (steps 1–12) given a pre-constructed
 * transport provider and the bound address of the server it is attached to.
 * The transport must be constructed but NOT yet connected — this function
 * calls `transport.connect(bus, machineId)` internally once the bus and
 * machine ID are available (step 3).
 *
 * This function is the shared implementation reused by both
 * {@link bootMakaioRuntime} (Node.js) and the Bun platform wrapper in
 * `@makaio/runtime-bun`.
 * @param transport - Pre-constructed (not yet connected) server transport provider.
 * @param boundPort - TCP port the server is listening on.
 * @param boundHost - Host address the server is bound to.
 * @param options - Platform-agnostic boot options.
 * @returns Runtime handle with `port`, `machineId`, and `shutdown()`.
 */
// eslint-disable-next-line max-lines-per-function, complexity
export async function bootMakaioRuntimeCore(
  transport: ServerTransportProvider,
  boundPort: number,
  boundHost: string,
  options: CoreBootOptions,
): Promise<MakaioRuntime> {
  const makaioHome = options.makaioHome ?? resolveMakaioHome();

  // Operator-owned extension config is read here, once, from the home this
  // core already resolves. Every host reaches this function, so none of them
  // carries a loader of its own and none of them can drift from the others.
  const operatorConfig = options.operatorConfig ?? (await loadExtensionOperatorConfig({ makaioHome }));

  // Framework-owned enablement store — the single source of truth for which
  // extensions have been explicitly disabled. Read once before coordinator
  // creation; writes are atomic (temp-file rename). A missing or corrupt file
  // defaults to all-extensions-enabled and records a diagnostic on the store.
  const enablementStore = await loadExtensionEnablementStore(makaioHome);
  if (enablementStore.readFailure) {
    console.warn('[boot] Extension enablement file could not be read:', enablementStore.readFailure.diagnostic);
  }

  // Resolve discovery strategies and module-loader overrides once up-front
  // so the boot sequence body is free of repeated `?? new Filesystem*()` guards.
  const ext = resolveExtensionOptions(options, makaioHome);

  const skipExtensions = parseSkipExtensions();
  const peerSigningKeyResolver = options.peerSigningKeyResolver;

  // Shutdown steps are pushed in startup order. On normal shutdown they run
  // in reverse; on startup failure the same array is iterated in reverse as a
  // rollback, tearing down only what was successfully started.
  const shutdownSteps: ShutdownStep[] = [];

  try {
    // -----------------------------------------------------------------------
    // 1. Config
    // -----------------------------------------------------------------------
    if (options.lanBind && transport.dispatchingAuth && !peerSigningKeyResolver) {
      throw new Error('[boot] peerSigningKeyResolver is required when lanBind is enabled');
    }

    const configProvider = options.configProvider;
    const resolvedConfigProvider =
      configProvider ?? new NodeRuntimeProvider(new FileConfigStorage(makaioHome), makaioHome);
    const config = await resolvedConfigProvider.getConfig({ mode: 'local' });
    const machineIdentity =
      options.machineIdentity ?? (await loadOrCreateMachineIdentity(path.join(makaioHome, 'keys')));
    const machineId = configProvider ? await configProvider.getMachineId() : machineIdentity.machineId;
    if (machineIdentity.machineId !== machineId) {
      throw new Error(
        `[boot] Config provider machineId '${machineId}' does not match runtime machine identity '${machineIdentity.machineId}'`,
      );
    }

    console.info('[boot] Config resolved (mode=%s)', config.mode);

    // -----------------------------------------------------------------------
    // 2. Bus — namespace registration + busCreated phase
    //
    // Namespaces are registered before any bus operation so that schema
    // validation, local-subject routing, and extendSubject() are active
    // from the first emit/on call. Storage namespace definitions carry
    // Zod schemas; their runtime handlers are wired by storage packages.
    // -----------------------------------------------------------------------
    const bus = MakaioBus;

    bus.registerNamespaces(FrameworkContractNamespaces);
    bus.registerNamespaces(FrameworkStorageNamespaces);
    bus.registerNamespaces([BootNamespace, CliNamespace, ExtensionNamespace, KernelNamespace, RuntimeNamespace]);
    bus.registerNamespaces(FrameworkServicesCoreNamespaces);
    bus.registerNamespaces(options.hostNamespaces ?? []);

    if (process.env['MAKAIO_DEBUG'] === 'true') {
      const disposeDebugHook = bus.__onAny((context) => {
        let payload: string;
        try {
          payload = JSON.stringify(context.payload);
        } catch {
          payload = '[unserializable payload]';
        }
        console.debug(`[bus-server] subject: ${context.subject}, payload: ${payload}`);
      });
      shutdownSteps.push(disposeDebugHook);
    }
    if (options.upstreamTelemetry) {
      const attachedTelemetry = await attachUpstreamTelemetry(bus, machineId, options.upstreamTelemetry);
      shutdownSteps.push(attachedTelemetry.shutdown);
    }

    await bus.emit(KernelSubjects.phase.busCreated, { machineId });

    // -----------------------------------------------------------------------
    // 3. Transport (Phase 0 — resolves in ~50ms)
    // -----------------------------------------------------------------------
    await transport.connect(bus, machineId);
    shutdownSteps.push(() => transport.disconnect());

    console.info('[boot] Transport ready on %s:%d', boundHost, boundPort);
    try {
      options.onTransportReady?.({ port: boundPort, host: boundHost });
    } catch (callbackErr: unknown) {
      console.warn('[boot] onTransportReady callback failed:', callbackErr);
    }

    // -----------------------------------------------------------------------
    // 4. Storage — initialize the database (SQLite file or Postgres URL)
    //    and expose it through RuntimeSubjects.database for consumers that
    //    need the concrete handle.
    //
    //    Boot-ordering contract: storage engine registration precedes database
    //    creation and migrations by construction — initializeNodeDatabase
    //    first registers every engine passed via `database.engines`, then
    //    resolves URL targets against the engine registry, auto-resolving
    //    hinted engine packages (e.g. @makaio/storage-pg for postgres:// /
    //    postgresql:// URLs) before any client is created. Direct
    //    initializeNodeDatabase callers and the Bun runtime (which delegates
    //    to bootMakaioRuntimeCore) inherit the same contract; the storage
    //    conformance harness registers its engines explicitly instead.
    // -----------------------------------------------------------------------
    const { databaseClient } = await initializeNodeDatabase({
      makaioHome,
      migrationsDir: options.centralMigrationsDir,
      database: options.database,
    });
    const db = databaseClient.db;
    console.info('[boot] Database initialized');
    shutdownSteps.push(() => databaseClient.close());

    // -----------------------------------------------------------------------
    // 5. Runtime resource bus handlers
    // -----------------------------------------------------------------------
    const runtimeResourceCleanups: Array<() => void> = [
      bus.on(RuntimeSubjects.database, (ctx) => {
        ctx.setResult({ db });
      }),
      bus.on(RuntimeSubjects.machineIdentity, (ctx) => {
        ctx.setResult({ identity: machineIdentity });
      }),
      bus.on(RuntimeSubjects.busPort, (ctx) => {
        ctx.setResult({ port: boundPort });
      }),
    ];
    let runtimeReady = false;
    const isReadyCleanup = bus.on(KernelSubjects.isReady, (ctx) => {
      ctx.setResult({ ready: runtimeReady, machineId });
    });
    shutdownSteps.push(() => {
      runtimeReady = false;
      isReadyCleanup();
      for (const cleanup of runtimeResourceCleanups) {
        cleanup();
      }
    });

    await bus.emit(KernelSubjects.phase.coreReady, { machineId });
    console.info('[boot] Core ready (machineId=%s)', machineId);

    // -----------------------------------------------------------------------
    // 6. Boot-owned config handlers + framework package assembly
    // -----------------------------------------------------------------------
    const srcDir = path.dirname(fileURLToPath(import.meta.url));

    const configCleanup = registerConfigHandlers(bus, resolvedConfigProvider);
    shutdownSteps.push(configCleanup);
    console.info('[boot] Config handlers registered');

    // -----------------------------------------------------------------------
    // 6.5. Framework module resolver (published extension support)
    // -----------------------------------------------------------------------
    if (options.frameworkPackagePath) {
      await ensureFrameworkPackageLink({ makaioHome, frameworkPackagePath: options.frameworkPackagePath });
      console.info('[boot] Framework package linked for extension resolution');
    }

    const frameworkModuleResolver = options.frameworkModuleResolver;
    if (frameworkModuleResolver) {
      try {
        await frameworkModuleResolver.install();
      } catch (error) {
        await Promise.resolve(frameworkModuleResolver.uninstall()).catch(() => undefined);
        throw error;
      }
      shutdownSteps.push(() => frameworkModuleResolver.uninstall());
      console.info('[boot] Framework module resolver installed');
    }

    // adapterServiceRef is populated after coordinator.startAll() below.
    // Provides the loaded adapter list to runtime bus handlers.
    const adapterServiceRef: { current: AdapterSubsystemService | undefined } = { current: undefined };

    const modelRegistryFetcher = createBootModelRegistryFetcher({
      makaioHome,
      srcDir,
      fallbackSeedPaths: options.modelRegistryFallbackSeedPaths,
    });

    // -----------------------------------------------------------------------
    // 7. Extension discovery + loading
    //
    // Runs before coordinator construction so the merged extension list and
    // config defaults are assembled before the coordinator registers storage
    // handlers and starts services.
    // -----------------------------------------------------------------------
    let bootUsername = process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
    try {
      bootUsername = os.userInfo().username;
    } catch {
      /* Fallback for environments without OS user record (e.g. Docker with unmapped UID) */
    }

    const runtimeFrameworkVersion = options.frameworkVersion ?? (await readFrameworkVersion());
    const { extensionLoadResult, browserOnlyResult, extensionsWithCli, allExtensionPackages } =
      await loadBootExtensions({
        extensionOptions: ext,
        skipExtensions,
        frameworkVersion: runtimeFrameworkVersion,
        createMount: options.createMount,
      });
    const runtimeEnvironment = buildRuntimeEnvironment(process.platform, options.hostCapabilities);
    const bootEligibleExtensionPackages = selectBootEligibleExtensionPackages({
      packages: allExtensionPackages,
      configProvider: enablementStore,
      surface: options.surface ?? 'headless',
      runtimeEnvironment,
    });

    // -----------------------------------------------------------------------
    // Framework package name universe for collision resolution.
    //
    // `composeBootExtensionSelection`'s Stage 2 needs every package name this
    // boot loads unconditionally, regardless of extension state — but
    // assembling the real `frameworkPackages` array needs the extension
    // closure result for two entries (`clientsCorePackage`'s client
    // definitions, and the ownership-conditional session-orchestrator
    // package). Building that array first and composing the closure second
    // would recreate the exact ordering bug this composition fixes. Every
    // framework package name is, however, static and extension-independent:
    // `selectFrameworkCorePackages` only ever REMOVES a name already present
    // in the static `frameworkCorePackages` list, and every scheduler
    // candidate registers under the single, fixed
    // `AutomationCronSchedulerToken.name` regardless of which package wins
    // that slot. So the full name universe is assembled from static package
    // identities and host-option-gated (never extension-gated) names, ahead
    // of and independent of the extension-closure result below.
    // -----------------------------------------------------------------------
    let platformMacOSPackage: KernelMakaioExtension | undefined;
    if (process.platform === 'darwin') {
      ({ platformMacOSPackage } = await import('@makaio/platform-macos'));
    }
    const frameworkPackageNames = new Set<string>([
      preferencesStoragePackage.name,
      cliDetectionPackage.name,
      ClientsCoreToken.name,
      ...(options.enablePackageManager !== false ? [createPackageManagerPackage().name] : []),
      AdapterSubsystemToken.name,
      ...frameworkCorePackages.map((pkg) => pkg.name),
      WorkflowEngineToken.name,
      ModelRegistryToken.name,
      logImportRegistryPackage.name,
      AutomationCronSchedulerToken.name,
      ...(platformMacOSPackage ? [platformMacOSPackage.name] : []),
    ]);

    // Single composition seam: every downstream consumer below (client
    // definitions, runtime ownership, scheduler policy selection,
    // `packagesToLoad`, `registerExtensionBootContributions`, warning
    // diagnostics) reads its sets from this one result instead of
    // recomputing any stage independently — see `composeBootExtensionSelection`.
    const selection = composeBootExtensionSelection({
      bootEligibleExtensionPackages,
      configProvider: enablementStore,
      frameworkPackageNames,
    });
    const { effectiveEnabledBootPackages, effectiveEnabledPackageNames, mergeableExtensionPackages } = selection;

    const busUrl = buildLocalBusUrl(boundHost, boundPort);

    const credentialsProvider = new StoredCredentialProvider(bus);

    const coordinator = new ExtensionCoordinator(bus, {
      surface: options.surface ?? 'headless',
      db,
      extensionContextBase: {
        cwd: process.cwd(),
        platform: process.platform,
        homedir: os.homedir(),
        makaioHome,
        username: bootUsername,
        machineId: machineIdentity.machineId,
        busUrl,
        tryImport,
        credentials: credentialsProvider,
      },
      runtimeEnvironment,
      launcherCommand: options.launcherCommand,
      loadConfig: options.extensionConfigProvider
        ? (name) => options.extensionConfigProvider!.loadConfig(name)
        : undefined,
      loadEnabled: (name) => enablementStore.loadEnabled(name),
      persistEnabled: (name, enabled) => enablementStore.persistEnabled(name, enabled),
      operatorConfig,
      runMigrations: (sources) => runBootExtensionMigrations(db, sources),
      // Names of the post-collision extension package pool (Stage 2 of
      // `composeBootExtensionSelection`) — the kernel uses this to enforce
      // that framework/core packages are never toggleable through the
      // enablement store, independent of the boot-time sets derived from it.
      extensionManagedNames: selection.extensionManagedPackageNames,
      // The names the host loads unconditionally below. An extension package
      // that registers under one of them is the supported core override and
      // wins the name; a collision under any other name is an extension
      // identity collision the coordinator refuses outright.
      frameworkPackageNames,
    });

    // Framework-level packages load unconditionally — they provide core
    // infrastructure (e.g. preferences storage) that the shell and framework
    // layer depend on regardless of whether a host descriptor is present.
    const adapterConfigRepository =
      options.adapterConfigRepository ??
      new FileAdapterConfigRepository({
        providerConfigsDir: path.join(makaioHome, 'provider-configs'),
        adaptersDir: path.join(makaioHome, 'adapters'),
      });
    const clientDefinitions = effectiveEnabledBootPackages.flatMap((pkg) => pkg.clients ?? []);

    const frameworkPackages = [
      preferencesStoragePackage,
      cliDetectionPackage,
      createClientsCorePackage({
        definitions: clientDefinitions,
        strategyDependencies: options.clientBinaryStrategyDependencies,
        postInstallHandlers: options.clientBinaryPostInstallHandlers,
      }),
    ];

    if (options.enablePackageManager !== false) {
      frameworkPackages.push(
        createPackageManagerPackage({
          frameworkPeerRange: `^${runtimeFrameworkVersion}`,
          frameworkPackagePath: options.frameworkPackagePath,
          // `frameworkDistPath` is `''` for `NoopFrameworkModuleResolver` (dev
          // mode, Bun-based hosts) — only forward it when a
          // `NodeFrameworkModuleResolver` actually installed the main-thread
          // hook this empowers the package manager's import worker to mirror
          // (see `resolveCriticalFlag`'s `frameworkDistPath` parameter).
          frameworkDistPath: frameworkModuleResolver?.frameworkDistPath || undefined,
          devPortalPackages: options.devPortalPackages,
        }),
      );
    }

    const platformDefaults = { cwd: process.cwd() };
    const resolveDynamicPiscinaWorkspaceRoot = async (workspaceId: string): Promise<string | undefined> => {
      const workflowEngine = coordinator.getExtensionService(WorkflowEngineToken);
      return workflowEngine?.resolveWorkspaceRoot(workspaceId);
    };
    const resolveBuiltInPiscinaWorkspaceRoot = createCompositeWorkspaceRootResolver(
      resolveDynamicPiscinaWorkspaceRoot,
      options.piscinaWorkspaceRootResolver,
    );
    const resolveWorkflowPiscinaWorkspaceRoot = createCompositeWorkspaceRootResolver(
      resolveDynamicPiscinaWorkspaceRoot,
      options.workflowRunner?.mode === 'piscina' ? options.workflowRunner.resolveWorkspaceRoot : undefined,
      options.piscinaWorkspaceRootResolver,
    );
    const workflowRunner =
      options.workflowRunner?.mode === 'piscina'
        ? { ...options.workflowRunner, resolveWorkspaceRoot: resolveWorkflowPiscinaWorkspaceRoot }
        : options.workflowRunner;
    const workflowRunnerPackageOptions = createNodeWorkflowRunnerPackageOptions({
      busUrl,
      runtimeModuleDir: srcDir,
      platformDefaults,
      workflowRunner,
      makaioHome,
      bus,
      executionAttemptRepository: options.executionAttemptRepository,
      executionAttemptBootstrapTimeoutMs: options.executionAttemptBootstrapTimeoutMs,
      workflowMaterializationSpecResolvers: options.workflowMaterializationSpecResolvers,
    });

    const { adapterSubsystemPackage } = prepareAdapterRuntime({
      coordinator,
      configRepository: adapterConfigRepository,
      platformDefaults,
    });

    frameworkPackages.push(
      adapterSubsystemPackage,
      ...selectFrameworkCorePackages(effectiveEnabledBootPackages),
      createWorkflowEnginePackage(workflowRunnerPackageOptions),
      createModelRegistryPackage(modelRegistryFetcher),
      logImportRegistryPackage,
    );

    if (platformMacOSPackage) {
      frameworkPackages.push(platformMacOSPackage);
    }

    // `makaio.cron` bindings delegate to the single registered cron scheduler
    // provider. Resolve that provider against everything this boot is about to
    // load, so a duplicate or mis-registered provider fails here rather than
    // leaving cron bindings silently unscheduled: framework-only boot falls back
    // to the framework's local in-process provider. `loadedPackages` uses the
    // dependency-closed enabled set (`effectiveEnabledBootPackages`), not the
    // eligibility-only set: a disabled extension still reaches the coordinator
    // (soft-skipped, so status/listing still know about it and a preference
    // change takes effect on the next boot) but never runs, so it must not count as
    // a provider here either — otherwise it would suppress the local fallback
    // while the coordinator soft-skips it, leaving cron bindings unscheduled.
    // The same reasoning applies to a preference-enabled extension whose own
    // required dependency is disabled: the coordinator will never start it
    // either. `selectEligibleAutomationCronSchedulerHostPackages` is handed
    // `selection.effectiveEnabledBootPackages` directly here instead of
    // recomputing its own closure, so the scheduler-eligibility stage reads
    // from the same single composed result as every other consumer.
    const automationCronSchedulerPackage = selectAutomationCronSchedulerPackage({
      hostPackages: [
        ...(options.automationCronSchedulerPackage ? [options.automationCronSchedulerPackage] : []),
        ...selectEligibleAutomationCronSchedulerHostPackages(
          extensionLoadResult.automationCronSchedulerHostPolicies,
          {
            packages: allExtensionPackages,
            configProvider: enablementStore,
            surface: options.surface ?? 'headless',
            runtimeEnvironment,
          },
          effectiveEnabledBootPackages,
        ),
      ],
      loadedPackages: [...frameworkPackages, ...effectiveEnabledBootPackages],
    });
    if (automationCronSchedulerPackage) {
      frameworkPackages.push(automationCronSchedulerPackage);
    }

    // Merge server-entry, browser-only, and CLI-only config defaults. Name
    // collisions are structurally impossible across these three sources:
    // - extensionLoadResult: server-entry extensions only
    // - browserOnlyResult: extensions with browser but no server entrypoint
    // - extensionsWithCli: CLI-only extensions (no server, no browser)
    // The merge order is irrelevant by design.
    // Discovered extensions that contribute adapters or providers are processed
    // by the adapter subsystem the moment they activate, so they must start
    // after it. Stamped here rather than declared by each extension: a
    // contributed package names adapters, not framework packages.
    //
    // `mergeableExtensionPackages`/`extensionManagedPackageNames` come from
    // `selection` (composed once, above, from `frameworkPackageNames`) — not
    // recomputed here. A disabled extension package (or an enabled one whose
    // own required dependency is disabled — see `effectiveEnabledPackageNames`)
    // never reaches `active`, so it must not be allowed to win the
    // coordinator's own name-collision coalescing against a framework package
    // that otherwise loads unconditionally: see `excludeIneffectiveCoreNameOverrides`.
    const packagesToLoad = [...frameworkPackages, ...orderAfterAdapterSubsystem(mergeableExtensionPackages)];
    const loadedPackageNames = new Set(packagesToLoad.map((pkg) => pkg.name));
    const configDefaults = filterConfigDefaultsForLoadedPackages(
      mergePackageConfigDefaults(
        extensionLoadResult.configDefaults,
        browserOnlyResult.configDefaults,
        extensionsWithCli.configDefaults,
        options.packageConfigDefaults,
      ),
      loadedPackageNames,
    );
    // The coordinator applies surface and environment filtering of its own, so
    // the set it retained — not the set handed to it — is what decides whether
    // an operator file will ever be read. Diagnosing before the call would count
    // a file for an interactive-only extension as consumed during a headless
    // boot and then drop it silently.
    const retainedPackages = coordinator.load(packagesToLoad, configDefaults);
    warnOnUnappliedExtensionOperatorConfig(operatorConfig, retainedPackages);
    warnOnUnaddressableExtensionOperatorConfigNames(retainedPackages);

    // -----------------------------------------------------------------------
    // Contribution processors are registered before startAll() so extension
    // contributions are awaited during coordinator activation/deactivation.
    // Framework processors are boot-owned; host/domain processors are
    // declared by loaded packages through MakaioExtension.runtimeBoot.
    // -----------------------------------------------------------------------
    // The adapter contribution processor is registered by prepareAdapterRuntime()
    // (above, before load) so the adapter subsystem composes as one unit.
    coordinator.registerContributionProcessor(createLogImportContributionProcessor());
    coordinator.registerContributionProcessor(createArtifactKindContributionProcessor());
    coordinator.registerContributionProcessor(createArtifactLifecycleHookContributionProcessor());
    coordinator.registerContributionProcessor(createFacetNamespaceContributionProcessor());
    coordinator.registerContributionProcessor(createSurfaceBindingContributionProcessor());
    coordinator.registerContributionProcessor(createArtifactViewBuilderContributionProcessor());
    coordinator.registerContributionProcessor(createToolContributionProcessor());
    coordinator.registerContributionProcessor(createWorkflowBlockContributionProcessor());
    coordinator.registerContributionProcessor(createTransitionContributionProcessor());
    coordinator.registerContributionProcessor(
      createReactionContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    coordinator.registerContributionProcessor(
      createAutomationTriggerContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    if (options.routeGraphBuilder) {
      coordinator.registerContributionProcessor(createHttpContributionProcessor(options.routeGraphBuilder));
    }
    // Retained + enabled packages only: a coordinator-filtered package never
    // activates, and a persistently-disabled package starts in skipped state, so
    // neither should have its runtimeBoot.configure callback invoked. Calling it
    // for a disabled package would install boot-time state (e.g. contribution
    // processors, global counters) for an extension that does not run. An
    // extension-managed package (one that survived collision resolution and
    // was merged into the boot composition — see `extensionManagedPackageNames`
    // above) additionally needs the dependency closure above: a
    // preference-enabled extension whose required dependency is disabled will
    // never reach `active` either, so its runtimeBoot.configure must not run.
    // A retained package outside `extensionManagedPackageNames` is, by
    // construction, an unconditionally-loaded framework package — including
    // one that just won a name collision against a disabled extension
    // override — and is never subject to the enablement store; see
    // `selectExtensionManagedEnabledPackages` for why the store must not be
    // consulted by name here.
    const enabledRetainedPackages = selectExtensionManagedEnabledPackages(
      retainedPackages,
      selection.extensionManagedPackageNames,
      effectiveEnabledPackageNames,
    );
    collectHostCleanups(shutdownSteps, registerExtensionBootContributions(enabledRetainedPackages, bus, coordinator));
    // Close the credential channel before the bus/transport tears down. In
    // reverse shutdown order this runs after coordinator.shutdown() (which
    // stops all extension activity) and before transport.disconnect().
    shutdownSteps.push(() => credentialsProvider.close());
    shutdownSteps.push(() => coordinator.shutdown());
    collectHostCleanups(
      shutdownSteps,
      options.configureCoordinator?.({
        bus,
        coordinator,
        registerContributionProcessor: (processor) => {
          coordinator.registerContributionProcessor(processor);
        },
        getAdapterSubsystemService: () => coordinator.getExtensionService(AdapterSubsystemToken),
      }),
    );

    // -----------------------------------------------------------------------
    // 8. ExtensionCoordinator.startAll — storage + services, surface-gated
    // -----------------------------------------------------------------------
    // HTTP route mounting is handled by the HttpContributionProcessor registered
    // above when routeGraphBuilder is provided. The processor adds/removes routes
    // dynamically as extensions activate/deactivate, so no imperative mount loop
    // is needed here.
    await coordinator.startAll();
    await bus.emit(KernelSubjects.phase.servicesReady, { machineId });
    const allExtensions = coordinator.list();
    const activeExtensions = allExtensions.filter((e) => e.state === 'active');
    console.info('[boot] Extensions started: %d active', activeExtensions.length);
    if (process.env['MAKAIO_DEBUG']) {
      const failed = allExtensions.filter((e) => e.state === 'failed');
      for (const ext of activeExtensions) {
        console.info('[boot]   ✓ %s (%s)', ext.displayName, ext.name);
      }
      for (const ext of failed) {
        console.warn('[boot]   ✗ %s (%s): %s', ext.displayName, ext.name, ext.error ?? 'unknown');
      }
    }

    adapterServiceRef.current = coordinator.getExtensionService(AdapterSubsystemToken);

    // -----------------------------------------------------------------------
    // Built-in thin Piscina workflow provider
    //
    // Register a PiscinaThinWorkflowProvider backed by a dedicated
    // ThinWorkflowPiscinaRunner so that the worker-pool dispatch path can
    // resolve 'piscina' environments without any external provider package.
    // This path isolates workflow orchestration only; it is not the
    // self-contained external Worker Runtime model.
    // Registration happens after coordinator.startAll() so that
    // CapabilityService has registered its capability.register handler.
    // The provider uses the same worker-entry resolution logic as the
    // workflow-level runner.
    // -----------------------------------------------------------------------
    const workflowAttemptAuthority = coordinator.getExtensionService(WorkflowEngineToken)?.executionAttemptAuthority;
    if (workflowAttemptAuthority === undefined) {
      console.info('[boot] Piscina workflow provider not registered: no ExecutionAttemptAuthority configured');
    } else {
      const piscinaWorkerEntry = resolveWorkflowWorkerEntry({
        moduleDir: srcDir,
        mode: path.basename(srcDir) === 'src' ? 'source' : 'dist',
      });
      const piscinaRunner = new ThinWorkflowPiscinaRunner({
        workerEntry: piscinaWorkerEntry,
        manifest: { contributionRefs: [] },
        resolveWorkspaceRoot: resolveBuiltInPiscinaWorkspaceRoot,
      });
      const piscinaProvider = new PiscinaThinWorkflowProvider({
        id: BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
        displayName: 'Local (Piscina)',
        runner: piscinaRunner,
        bus,
        launchResolver: createWorkflowLaunchResolver((input) => workflowAttemptAuthority.getInstruction(input)),
      });
      try {
        await registerWorkerProvider(bus, piscinaProvider);
      } catch (error) {
        await piscinaRunner.dispose().catch(() => undefined);
        throw error;
      }
      shutdownSteps.push(async () => {
        try {
          await unregisterWorkerProvider(bus, piscinaProvider.id);
        } finally {
          await piscinaRunner.dispose().catch(() => undefined);
        }
      });
      console.info('[boot] Piscina thin workflow provider registered (id=%s)', piscinaProvider.id);
    }

    shutdownSteps.push(
      registerRuntimeHandlers(
        bus,
        () => adapterServiceRef.current?.getLoadedAdapters() ?? [],
        () => adapterServiceRef.current?.getAdapterInstances() ?? new Map(),
        (name) => coordinator.getExtension(name),
        (name) => operatorConfig.get(name),
        (name) => coordinator.getResolvedConfig(name),
      ),
    );

    // -----------------------------------------------------------------------
    // 9. Adapter runtime identity
    // -----------------------------------------------------------------------
    const adapterRuntimeIdentity = activateAdapterRuntimeIdentity({
      bus,
      currentMachineId: machineId,
      resolveLiveAdapterId: (adapterName) => adapterServiceRef.current?.resolveLiveAdapterId(adapterName),
      resolveLiveAdapterIdentity: (adapterId) => adapterServiceRef.current?.resolveLiveAdapterIdentity(adapterId),
      listLiveAdapterIdentities: () => adapterServiceRef.current?.getLiveAdapterIdentities() ?? [],
    });
    shutdownSteps.push(adapterRuntimeIdentity.cleanup);

    // -----------------------------------------------------------------------
    // 10. Host coordinator-ready broadcast
    //
    // This is a typed lifecycle barrier only. Host integrations query concrete
    // runtime seams (extension contribution catalog, runtime resources, etc.)
    // through dedicated bus requests instead of receiving opaque objects here.
    // -----------------------------------------------------------------------
    await bus.broadcast(KernelSubjects.phase.coordinatorReady, {
      machineId,
    });

    // -----------------------------------------------------------------------
    // 11. E2E auth hot-swap (LAN mode)
    // -----------------------------------------------------------------------
    if (options.lanBind && transport.dispatchingAuth && peerSigningKeyResolver) {
      const e2eAuth = createBootE2EAuth(machineIdentity, peerSigningKeyResolver);
      transport.dispatchingAuth.setE2EAuth(e2eAuth);
      console.info('[boot] E2E auth enabled (LAN mode, machineId=%s)', machineId);
    }

    // -----------------------------------------------------------------------
    // 12. Ready
    // -----------------------------------------------------------------------
    runtimeReady = true;
    await bus.emit(KernelSubjects.ready, { machineId });
    console.info('[boot] Runtime ready (machineId=%s)', machineId);

    const shutdown = createShutdownSequence([...shutdownSteps].reverse());
    return {
      port: boundPort,
      host: boundHost,
      machineId,
      bus,
      coordinator,
      trayEntries: coordinator.trayEntries,
      windowRegistry: coordinator.windowRegistry,
      shutdown,
    };
  } catch (err) {
    console.error('[boot] Startup failed — rolling back started resources', err);
    // Roll back in reverse order. The startup failure is what the caller asked
    // about, so the secondary failures of unwinding a half-built runtime are
    // reported rather than substituted for it.
    for (const step of [...shutdownSteps].reverse()) {
      try {
        await step();
      } catch (cleanupErr) {
        console.warn('[boot] Rollback step error:', cleanupErr);
      }
    }
    throw err;
  }
}

/**
 * Boot the full Makaio runtime against a pre-existing Node.js HTTP server.
 *
 * Thin Node.js wrapper around {@link bootMakaioRuntimeCore}. Creates a
 * {@link BusServerTransportProvider} from the provided HTTP server, resolves
 * the bound address via `httpServer.address()`, then delegates all startup
 * logic to the platform-agnostic core.
 *
 * The caller owns the HTTP server and Hono app lifecycle. This function owns
 * everything from step 1 (Config) through step 12 (Ready) and returns a
 * {@link MakaioRuntime} handle that the caller uses to shut down.
 * @param options - Boot configuration including the pre-bound HTTP server.
 * @returns Runtime handle with `port`, `machineId`, and `shutdown()`.
 */
export async function bootMakaioRuntime(options: BootMakaioRuntimeOptions): Promise<MakaioRuntime> {
  const transport = new BusServerTransportProvider({
    httpServer: options.httpServer,
    auth: options.auth,
    loopbackName: options.loopbackName ?? 'node',
  });

  const addr = options.httpServer.address();
  if (typeof addr !== 'object' || addr === null) {
    throw new Error('HTTP server is not bound to a TCP address');
  }

  return bootMakaioRuntimeCore(transport, addr.port, addr.address, {
    ...options,
    hostCapabilities: normalizeNodeHostCapabilities(options.hostCapabilities),
    clientBinaryStrategyDependencies:
      options.clientBinaryStrategyDependencies ?? createNodeClientBinaryStrategyDependencies(),
  });
}
