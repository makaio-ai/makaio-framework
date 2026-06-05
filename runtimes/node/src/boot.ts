/* eslint-disable max-lines -- composition root that aggregates all framework services */
/**
 * Makaio runtime boot sequence.
 *
 * Extracts the shared startup logic from the CLI serve composition root into
 * a reusable function that can be driven by any host (CLI, Electron, tests)
 * that already owns an HTTP server and Hono app.
 *
 * Startup sequence:
 *  1. Config resolution via FileConfigStorage + NodeRuntimeProvider
 *  2. Bus creation (MakaioBus singleton) + namespace registration + busCreated phase event
 *  3. Transport — BusServerTransportProvider (WebSocket bus server on provided HTTP server)
 *  4. Storage — initializeNodeDatabase (SQLite init) + RuntimeSubjects.database exposure
 *  5. Identity — loadOrCreateMachineIdentity + platform bus handler registration
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
  type AdapterSubsystemService,
} from '@makaio/subsystem-adapter';
import {
  createModelRegistryPackage,
  createArtifactKindContributionProcessor,
  createToolContributionProcessor,
  createTransitionContributionProcessor,
  createWorkflowBlockContributionProcessor,
  FrameworkServicesCoreNamespaces,
} from '@makaio/services-core';
import { createLogImportContributionProcessor, logImportRegistryPackage } from '@makaio/services-log-import';
import { createWorkflowEnginePackage } from '@makaio/subsystem-workflow-engine/package';
import { createPackageManagerPackage } from '@makaio/services-package-manager/package';
import { createHttpContributionProcessor } from './http-contribution-processor.js';
import { resolveMakaioHome } from './makaio-config.js';
import { preferencesStoragePackage } from '@makaio/preferences/package';
import { createClientsCorePackage } from '@makaio/subsystem-client';
import { createNodeClientBinaryStrategyDependencies } from './client-binary-strategy-dependencies.js';
import { activateAdapterRuntimeIdentity, prepareAdapterRuntime } from './compose-adapter-runtime.js';
import { tryImport } from './optional-package.js';
import { registerRuntimeHandlers } from './register-runtime-handlers.js';
import {
  filterConfigDefaultsForLoadedPackages,
  mergePackageConfigDefaults,
  registerConfigHandlers,
} from './boot-config.js';
import { createBootModelRegistryFetcher } from './boot-model-registry.js';
import { ensureFrameworkPackageLink } from './framework-package-link.js';
import {
  buildRuntimeEnvironment,
  collectHostCleanups,
  normalizeNodeHostCapabilities,
  parseSkipExtensions,
  registerExtensionBootContributions,
  selectBootEligibleExtensionPackages,
  selectFrameworkCorePackages,
} from './boot-extension-selection.js';
import { loadBootExtensions } from './boot-extension-loading.js';
import { readFrameworkVersion } from './read-framework-version.js';
import { runBootExtensionMigrations } from './boot-extension-migrations.js';
import { createBootE2EAuth } from './boot-e2e-auth.js';
import { attachUpstreamTelemetry } from './upstream-telemetry.js';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
  registerWorkerNodeProvider,
  unregisterWorkerNodeProvider,
} from '@makaio/contracts';
import {
  ThinWorkflowPiscinaRunner,
  PiscinaThinWorkflowProvider,
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

  // Resolve discovery strategies and module-loader overrides once up-front
  // so the boot sequence body is free of repeated `?? new Filesystem*()` guards.
  const ext = resolveExtensionOptions(options, makaioHome);

  const skipExtensions = parseSkipExtensions();

  // Shutdown steps are pushed in startup order. On normal shutdown they run
  // in reverse; on startup failure the same array is iterated in reverse as a
  // rollback, tearing down only what was successfully started.
  const shutdownSteps: ShutdownStep[] = [];

  try {
    // -----------------------------------------------------------------------
    // 1. Config
    // -----------------------------------------------------------------------
    const configStorage = new FileConfigStorage(makaioHome);
    const configProvider = new NodeRuntimeProvider(configStorage, makaioHome);
    const config = await configProvider.getConfig({ mode: 'local' });
    const machineId = await configProvider.getMachineId();

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
    // Validate LAN mode prerequisites before connecting the transport.
    const peerSigningKeyResolver = options.peerSigningKeyResolver;
    if (options.lanBind && transport.dispatchingAuth && !peerSigningKeyResolver) {
      throw new Error('[boot] peerSigningKeyResolver is required when lanBind is enabled');
    }

    await transport.connect(bus, machineId);
    shutdownSteps.push(() => transport.disconnect());

    console.info('[boot] Transport ready on %s:%d', boundHost, boundPort);
    try {
      options.onTransportReady?.({ port: boundPort, host: boundHost });
    } catch (callbackErr: unknown) {
      console.warn('[boot] onTransportReady callback failed:', callbackErr);
    }

    // -----------------------------------------------------------------------
    // 4. Storage — initialize SQLite database and expose it through
    //    RuntimeSubjects.database for consumers that need the concrete handle.
    // -----------------------------------------------------------------------
    const { databaseClient } = await initializeNodeDatabase({
      makaioHome,
      migrationsDir: options.centralMigrationsDir,
    });
    const db = databaseClient.db;
    console.info('[boot] Database initialized');
    shutdownSteps.push(() => databaseClient.close());

    // -----------------------------------------------------------------------
    // 5. Identity + runtime resource bus handlers
    // -----------------------------------------------------------------------
    const machineIdentity = await loadOrCreateMachineIdentity(path.join(makaioHome, 'keys'));

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

    const configCleanup = registerConfigHandlers(bus, configProvider);
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
      });
    const runtimeEnvironment = buildRuntimeEnvironment(process.platform, options.hostCapabilities);
    const bootEligibleExtensionPackages = selectBootEligibleExtensionPackages({
      packages: allExtensionPackages,
      configProvider: options.extensionConfigProvider,
      surface: options.surface ?? 'headless',
      runtimeEnvironment,
    });

    const busUrl = buildLocalBusUrl(boundHost, boundPort);

    const coordinator = new ExtensionCoordinator(bus, {
      surface: options.surface ?? 'headless',
      db,
      extensionContextBase: {
        platform: process.platform,
        homedir: os.homedir(),
        makaioHome,
        username: bootUsername,
        machineId: machineIdentity.machineId,
        busUrl,
        tryImport,
      },
      runtimeEnvironment,
      launcherCommand: options.launcherCommand,
      loadConfig: options.extensionConfigProvider
        ? (name) => options.extensionConfigProvider!.loadConfig(name)
        : undefined,
      loadEnabled: options.extensionConfigProvider
        ? (name) => options.extensionConfigProvider!.loadEnabled(name)
        : undefined,
      runMigrations: (sources) => runBootExtensionMigrations(db, sources),
    });

    // Framework-level packages load unconditionally — they provide core
    // infrastructure (e.g. preferences storage) that the shell and framework
    // layer depend on regardless of whether a host descriptor is present.
    const adapterConfigRepository = new FileAdapterConfigRepository({
      providerConfigsDir: path.join(makaioHome, 'provider-configs'),
      adaptersDir: path.join(makaioHome, 'adapters'),
    });
    const clientDefinitions = bootEligibleExtensionPackages.flatMap((pkg) => pkg.clients ?? []);

    const frameworkPackages = [
      preferencesStoragePackage,
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
          devPortalPackages: options.devPortalPackages,
        }),
      );
    }

    const platformDefaults = { cwd: process.cwd() };
    const workflowRunnerPackageOptions = createNodeWorkflowRunnerPackageOptions({
      busUrl,
      runtimeModuleDir: srcDir,
      platformDefaults,
      workflowRunner: options.workflowRunner,
      makaioHome,
      bus,
    });

    const { adapterSubsystemPackage } = prepareAdapterRuntime({
      coordinator,
      configRepository: adapterConfigRepository,
      platformDefaults,
    });

    frameworkPackages.push(
      adapterSubsystemPackage,
      ...selectFrameworkCorePackages(bootEligibleExtensionPackages),
      createWorkflowEnginePackage(workflowRunnerPackageOptions),
      createModelRegistryPackage(modelRegistryFetcher),
      logImportRegistryPackage,
    );

    if (process.platform === 'darwin') {
      const { platformMacOSPackage } = await import('@makaio/platform-macos');
      frameworkPackages.push(platformMacOSPackage);
    }

    // Merge server-entry, browser-only, and CLI-only config defaults. Name
    // collisions are structurally impossible across these three sources:
    // - extensionLoadResult: server-entry extensions only
    // - browserOnlyResult: extensions with browser but no server entrypoint
    // - extensionsWithCli: CLI-only extensions (no server, no browser)
    // The merge order is irrelevant by design.
    const packagesToLoad = [...frameworkPackages, ...bootEligibleExtensionPackages];
    const loadedPackageNames = new Set(packagesToLoad.map((pkg) => pkg.name));
    const configDefaults = filterConfigDefaultsForLoadedPackages(
      mergePackageConfigDefaults(
        extensionLoadResult.configDefaults,
        browserOnlyResult.configDefaults,
        extensionsWithCli.configDefaults,
        options.packageConfigDefaults ?? new Map(),
      ),
      loadedPackageNames,
    );
    coordinator.load(packagesToLoad, configDefaults);

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
    coordinator.registerContributionProcessor(createToolContributionProcessor());
    coordinator.registerContributionProcessor(createWorkflowBlockContributionProcessor());
    coordinator.registerContributionProcessor(createTransitionContributionProcessor());
    if (options.routeGraphBuilder) {
      coordinator.registerContributionProcessor(createHttpContributionProcessor(options.routeGraphBuilder));
    }
    collectHostCleanups(shutdownSteps, registerExtensionBootContributions(packagesToLoad, bus, coordinator));
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
    // self-contained external WorkerNode runtime model.
    // Registration happens after coordinator.startAll() so that
    // CapabilityService has registered its capability.register handler.
    // The provider uses the same worker-entry resolution logic as the
    // workflow-level runner.
    // -----------------------------------------------------------------------
    const piscinaWorkerEntry = resolveWorkflowWorkerEntry({
      packageRoot: path.resolve(srcDir, '..'),
      mode: path.basename(srcDir) === 'src' ? 'source' : 'dist',
    });
    const piscinaRunner = new ThinWorkflowPiscinaRunner({
      workerEntry: piscinaWorkerEntry,
      manifest: { packages: [] },
    });
    const piscinaProvider = new PiscinaThinWorkflowProvider({
      id: BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
      displayName: 'Local (Piscina)',
      runner: piscinaRunner,
    });
    try {
      await registerWorkerNodeProvider(bus, piscinaProvider);
    } catch (error) {
      await piscinaRunner.dispose().catch(() => undefined);
      throw error;
    }
    shutdownSteps.push(async () => {
      try {
        await unregisterWorkerNodeProvider(bus, piscinaProvider.id);
      } finally {
        await piscinaRunner.dispose().catch(() => undefined);
      }
    });
    console.info('[boot] Piscina thin workflow provider registered (id=%s)', piscinaProvider.id);

    shutdownSteps.push(
      registerRuntimeHandlers(
        bus,
        () => adapterServiceRef.current?.getLoadedAdapters() ?? [],
        () => adapterServiceRef.current?.getAdapterInstances() ?? new Map(),
        (name) => coordinator.getExtension(name),
      ),
    );

    // -----------------------------------------------------------------------
    // 9. Adapter runtime identity
    // -----------------------------------------------------------------------
    const adapterRuntimeIdentity = activateAdapterRuntimeIdentity({ bus, currentMachineId: machineId });
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
      trayEntries: coordinator.trayEntries,
      windowRegistry: coordinator.windowRegistry,
      shutdown,
    };
  } catch (err) {
    console.error('[boot] Startup failed — rolling back started resources', err);
    // Roll back in reverse order, mirroring createShutdownSequence error tolerance.
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
