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
import { createFixedOperationHost } from './workflow-worker/fixed-operation-host.js';
import { MakaioBus } from '@makaio/bus-core';
import {
  ExtensionCoordinator,
  createShutdownSequence,
  createCoordinatorRights,
  runBoundedShutdownSteps,
  type BoundedShutdownStep,
  cancellationRejection,
  readCancellation,
  BootNamespace,
  DuplicateCredentialResolverError,
  ExtensionNamespace,
  ExtensionSubjects,
  KernelNamespace,
  type KernelMakaioExtension,
  type KernelExtensionContext,
} from '@makaio/kernel';
import { createHostDatabase } from '@makaio/storage-drizzle';
import {
  createJournalCapability,
  JournalContributionProcessor,
  JournalReaderService,
  SubjectDirectory,
} from '@makaio/services-core/journal';
import { bindWorkerDispatch } from './worker-dispatch-host-binding.js';
import { JournalStartBarrier } from './journal-start-barrier.js';
import { setupWriteJournal } from './write-journal-boot.js';
import { CliNamespace } from '@makaio/kernel/cli';
import { RuntimeSubjects, RuntimeNamespace } from './bus/runtime/namespace.js';
import { BusServerTransportProvider } from './bus-server-transport.js';
import { FileConfigStorage } from './file-config-storage.js';
import { NodeRuntimeProvider } from './node-runtime-provider.js';
import { loadOrCreateMachineIdentity } from '@makaio/machine-identity';
import { resolveExtensionOptions } from './resolve-extension-options.js';
import { initializeNodeDatabase } from './initialize-node-database.js';
import { MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
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
  createRuleContributionProcessor,
  createRuleContributionsPackage,
  createRuleContributionsBuiltinsPackage,
  ReactionRegistry,
  ReactionRegistryToken,
  type RuleContributionsService,
  RuleContributionsToken,
  RuleEvaluator,
  createRuleJournalReader,
  startRuleJournalEvaluation,
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
import type { WorkflowWorkspaceRootResolver } from '@makaio/subsystem-workflow-engine';
import {
  createNativeSessionSupervisorPackage,
  NATIVE_SESSION_SUPERVISOR_PACKAGE_NAME,
} from '@makaio/subsystem-native-session-supervisor/package';
import { busContextOf, mintCallContext } from '@makaio/bus-core/kernel-api';
import { createPackageManagerPackage } from '@makaio/services-package-manager/package';
import { createInstalledExtensionCatalogSource } from './installed-extension-catalog-source.js';
import { createHttpContributionProcessor } from './http-contribution-processor.js';
import { resolveMakaioHome } from './makaio-config.js';
import { preferencesStoragePackage } from '@makaio/preferences/package';
import { clientStoragePackage, ClientsCoreToken, createClientsCorePackage } from '@makaio/subsystem-client';
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
  assertFileAccessPackagesNotOverridden,
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
import { processStopBudgetMs } from '@makaio/subprocess';
import { bootCancellationBudgetMs, extensionsStep, localStep, resourceStep } from './runtime-stop-budget.js';
import { readFrameworkVersion } from './read-framework-version.js';
import { runBootExtensionMigrations } from './boot-extension-migrations.js';
import { createBootE2EAuth } from './boot-e2e-auth.js';
import { attachUpstreamTelemetry } from './upstream-telemetry.js';
import { createCredentialBinder } from './credential-provider.js';
import { FrameworkContractNamespaces, FrameworkStorageNamespaces } from '@makaio/contracts';
import { createNodeWorkflowRunnerPackageOptions } from './workflow-worker/index.js';
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
  resolveDynamicWorkspaceRoot: WorkflowWorkspaceRootResolver,
  ...fallbackResolvers: ReadonlyArray<WorkflowWorkspaceRootResolver | undefined>
): WorkflowWorkspaceRootResolver {
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
 * calls `transport.connect(bus, options)` internally once the bus and
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
  // Shutdown steps are pushed in startup order. On normal shutdown they run
  // in reverse; on startup failure the same array is iterated in reverse as a
  // rollback, tearing down only what was successfully started. Every step runs
  // inside a window of its own, so the shutdown and the rollback are bounded by
  // the windows of the steps that exist when they run.
  const shutdownSteps: BoundedShutdownStep[] = [];
  // Reported before the first await: a phase that never reaches a checkpoint can be
  // the first one.
  options.onCancellationBudget?.(() => bootCancellationBudgetMs(shutdownSteps));

  // A cancelled boot leaves through the failure path below, so the rollback that
  // tears down a failed startup also tears down a cancelled one. The checkpoints
  // sit after the phases that register a shutdown step, never in the middle of one,
  // and before the phases that acquire something the rollback would then have to undo.
  const checkpoint = (): void => options.signal?.throwIfAborted();

  const makaioHome = options.makaioHome ?? resolveMakaioHome();

  // Operator-owned extension config is read here, once, from the home this
  // core already resolves. Every host reaches this function, so none of them
  // carries a loader of its own and none of them can drift from the others.
  const operatorConfig = options.operatorConfig ?? (await loadExtensionOperatorConfig({ makaioHome }));
  let reportOperatorConfig: (() => void) | undefined = () =>
    warnOnUnappliedExtensionOperatorConfig(operatorConfig, undefined);

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

  const startGate = new JournalStartBarrier(options.journalStartupWaitTimeoutMs);
  const rights = createCoordinatorRights(MakaioBus, 'host');
  /** Reject inbound work as soon as boot is cancelled. */
  const closeOnAbort = (): void => {
    rights.closeBoundary();
    startGate.close(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', closeOnAbort, { once: true });
  try {
    // Nothing is acquired yet: a boot that was cancelled before it began leaves at once.
    checkpoint();

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
    checkpoint();

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
      shutdownSteps.push(localStep('bus debug hook', disposeDebugHook));
    }
    if (options.upstreamTelemetry) {
      const attachedTelemetry = await attachUpstreamTelemetry(bus, machineId, options.upstreamTelemetry);
      shutdownSteps.push(resourceStep('upstream telemetry', attachedTelemetry.shutdown));
    }

    // ORIGIN: Startup announces that the bus namespaces are registered.
    await bus.emit(bus.own('start'), KernelSubjects.phase.busCreated, { machineId });

    // The transport is the first thing that accepts connections: a cancelled boot must not open it.
    checkpoint();

    // -----------------------------------------------------------------------
    // 3. Transport (Phase 0 — resolves in ~50ms)
    // -----------------------------------------------------------------------
    const boundaryCheck = rights.checkBoundaryAccess;
    const subscriptionAvailabilityListeners = new Set<() => Promise<void>>();
    const notifySubscriptionAvailability = async (): Promise<void> => {
      await Promise.all([...subscriptionAvailabilityListeners].map((retry) => retry()));
    };
    const hostCaller = bus.own('observer').caller;
    const stopActivationObserver = bus.on(ExtensionSubjects.stateChanged, ({ call, payload }) => {
      if (
        rights.isBoundaryReady() &&
        payload.to === 'active' &&
        call.caller.kind === hostCaller.kind &&
        call.caller.id === hostCaller.id
      ) {
        return notifySubscriptionAvailability();
      }
    });
    const { registrationListeners } = busContextOf(bus).namespaceRegistry;
    registrationListeners.add(notifySubscriptionAvailability);
    shutdownSteps.push(
      localStep('subscription availability observers', () => {
        stopActivationObserver();
        registrationListeners.delete(notifySubscriptionAvailability);
      }),
    );
    boundaryCheck.watchSubscriptionAvailability = (retry) => {
      subscriptionAvailabilityListeners.add(retry);
      return () => {
        subscriptionAvailabilityListeners.delete(retry);
      };
    };
    await transport.connect(bus, { machineId, checkBoundaryAccess: boundaryCheck });
    const transportDisconnected = Promise.withResolvers<void>();
    shutdownSteps.push(
      resourceStep('bus transport', async () => {
        try {
          await transport.disconnect();
        } finally {
          transportDisconnected.resolve();
        }
      }),
    );
    checkpoint();

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
    const database = createHostDatabase(db);
    const workerDispatch = bindWorkerDispatch(options.workerDispatch, database, shutdownSteps, () =>
      databaseClient.close(),
    );
    checkpoint();

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
    shutdownSteps.push(
      localStep('runtime resource handlers', () => {
        runtimeReady = false;
        isReadyCleanup();
        for (const cleanup of runtimeResourceCleanups) {
          cleanup();
        }
      }),
    );

    // ORIGIN: Startup announces that the core is ready.
    await bus.emit(bus.own('start'), KernelSubjects.phase.coreReady, { machineId });
    console.info('[boot] Core ready (machineId=%s)', machineId);

    // -----------------------------------------------------------------------
    // 6. Boot-owned config handlers + framework package assembly
    // -----------------------------------------------------------------------
    const srcDir = path.dirname(fileURLToPath(import.meta.url));

    const configCleanup = registerConfigHandlers(bus, resolvedConfigProvider);
    shutdownSteps.push(localStep('config handlers', configCleanup));
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
      shutdownSteps.push(localStep('framework module resolver', () => frameworkModuleResolver.uninstall()));
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
    checkpoint();
    const runtimeEnvironment = buildRuntimeEnvironment(process.platform, [
      ...(options.hostCapabilities ?? []),
      { id: 'storage.drizzle' },
    ]);
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
    const nativeSessionSupervisorPackage = createNativeSessionSupervisorPackage({
      observeConnectionClosed: (transportName, onClosed) =>
        busContextOf(bus).transportRegistry.getTransport(transportName)?.onConnectionClosed?.(onClosed),
    });
    const frameworkPackageNames = new Set<string>([
      preferencesStoragePackage.name,
      cliDetectionPackage.name,
      clientStoragePackage.name,
      ClientsCoreToken.name,
      ...(options.enablePackageManager !== false ? [createPackageManagerPackage().name] : []),
      AdapterSubsystemToken.name,
      NATIVE_SESSION_SUPERVISOR_PACKAGE_NAME,
      ...frameworkCorePackages.map((pkg) => pkg.name),
      RuleContributionsToken.name,
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
    assertFileAccessPackagesNotOverridden(mergeableExtensionPackages, {
      fileAccessRuleProvider: options.fileAccessRuleProvider,
    });

    const busUrl = buildLocalBusUrl(boundHost, boundPort);

    const credentialBinder = createCredentialBinder();
    const writeJournal = setupWriteJournal(
      database,
      bus,
      rights.hostRights,
      () => coordinator.credentials.activeResolver(),
      options.writeJournal,
    );
    if (writeJournal) shutdownSteps.push(resourceStep('write journal', () => writeJournal.destroy()));

    const getRuleContributions = () =>
      coordinator.getExtensionService<RuleContributionsService>(RuleContributionsToken.name);
    const getReactionRegistry = () => {
      const service = coordinator.getExtensionService(ReactionRegistryToken.name);
      return service instanceof ReactionRegistry ? service : undefined;
    };
    const coordinator: ExtensionCoordinator<KernelExtensionContext> = new ExtensionCoordinator(bus, {
      enableCredentialResolver: true,
      onRuleSourceRegistered: (): void => journalReaders.wake(),
      validateRules: async (input) => {
        const service = getRuleContributions();
        if (!service) throw new Error('Rule contributions are unavailable');
        return service.validate(coordinator.ruleRights, input);
      },
      rights,
      surface: options.surface ?? 'headless',
      // An extension that declares no stop window of its own may own a child
      // process, so it gets the window of one bounded stop of one.
      defaultStopBudgetMs: processStopBudgetMs(),
      db,
      runInStartScope: (extension, start) => startGate.runInStartScope(extension, start),
      extensionContextBase: {
        cwd: process.cwd(),
        platform: process.platform,
        homedir: os.homedir(),
        makaioHome,
        username: bootUsername,
        machineId: machineIdentity.machineId,
        busUrl,
        tryImport,
        credentialsFor: credentialBinder.credentialsFor,
        /**
         * @param context - Shared fields and carrier bound by the coordinator.
         * @returns Full context for the extension.
         */
        constructContext(context): KernelExtensionContext {
          const extension = context.identity.extensionName;
          return {
            ...context,
            database,
            workerDispatch: workerDispatch?.capability,
            ...(writeJournal && {
              writes: writeJournal.bind(extension, context.bus, () => context.hasExtension(extension)),
            }),
            journal: createJournalCapability({
              extension,
              bus: context.bus,
              host: database,
              subjects: directory,
              contributions: journalContributions,
              isActive: () => context.hasExtension(extension),
              startGate,
            }),
          };
        },
      },
      runtimeEnvironment,
      launcherCommand: options.launcherCommand,
      loadConfig: options.extensionConfigProvider
        ? (name) => options.extensionConfigProvider!.loadConfig(name)
        : undefined,
      loadEnabled: (name) => enablementStore.loadEnabled(name),
      persistEnabled: (name, enabled) => enablementStore.persistEnabled(name, enabled),
      // The host's own installed-package view, taken through the very
      // discovery this boot resolved above, so the catalog describes the roots
      // and filters this host is configured with rather than a second,
      // independently assembled filesystem view. It is strictly larger than
      // what this boot loaded: discovery answers with descriptors, and surface
      // affinity, unmet requirements or boot-time suppression all leave a
      // discovered descriptor unloaded. Exposing it over the bus is what lets
      // a client that cannot read this machine's filesystem enumerate and
      // toggle those names instead of guessing from its own.
      installedCatalog: createInstalledExtensionCatalogSource({
        discovery: ext.extensions,
        ...(frameworkModuleResolver?.frameworkDistPath
          ? { frameworkDistPath: frameworkModuleResolver.frameworkDistPath }
          : {}),
      }),
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

    const directory = new SubjectDirectory(bus, coordinator);
    const journalContributions = new JournalContributionProcessor(directory);
    shutdownSteps.push(resourceStep('subject directory', () => directory.destroy()));
    await directory.init();
    coordinator.registerContributionProcessor(journalContributions);
    let ruleEvaluator: RuleEvaluator | undefined;
    const rulesParty = { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND };
    const journalReaders = new JournalReaderService({
      hostReader: {
        contribution: createRuleJournalReader(() => ruleEvaluator),
        call: mintCallContext({ caller: rulesParty, principal: rulesParty }),
        canSelect: () => coordinator.getRuleSourceRegistration() !== undefined,
      },
      bus,
      host: database,
      directory,
      ...coordinator.hostRights,
      bindCall: (caller, { principal, attestedBy }) =>
        mintCallContext({ caller, principal, ...(attestedBy === undefined ? {} : { attestedBy }) }),
    });
    const unregisterJournalReaders = coordinator.registerContributionProcessor(journalReaders);
    if (writeJournal) coordinator.registerContributionProcessor(writeJournal.contributions);

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
      clientStoragePackage,
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
    const resolveDynamicPiscinaWorkspaceRoot: WorkflowWorkspaceRootResolver = async (workspaceId) => {
      const workflowEngine = coordinator.getExtensionService(WorkflowEngineToken);
      return workflowEngine?.resolveWorkspaceRoot(workspaceId);
    };
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
      workflowMaterializationSpecResolvers: options.workflowMaterializationSpecResolvers,
    });

    const { adapterSubsystemPackage } = prepareAdapterRuntime({
      coordinator,
      configRepository: adapterConfigRepository,
      platformDefaults,
    });

    frameworkPackages.push(
      adapterSubsystemPackage,
      nativeSessionSupervisorPackage,
      ...selectFrameworkCorePackages(effectiveEnabledBootPackages, {
        fileAccessRuleProvider: options.fileAccessRuleProvider,
      }),
      createRuleContributionsPackage(getReactionRegistry),
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
    const coreRulesPackage = createRuleContributionsBuiltinsPackage(bus, coordinator.ruleRights);
    const packagesToLoad = [
      ...frameworkPackages.map((pkg) => (pkg.name === coreRulesPackage.name ? coreRulesPackage : pkg)),
      ...orderAfterAdapterSubsystem(mergeableExtensionPackages),
    ];
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
    reportOperatorConfig = () =>
      warnOnUnappliedExtensionOperatorConfig(
        operatorConfig,
        coordinator.list().map((extension) => ({
          ...extension,
          configSchema: coordinator.getExtension(extension.name)?.configSchema,
        })),
      );
    const retainedPackages = coordinator.load(packagesToLoad, configDefaults);
    // Diagnose unaddressable names only for packages retained on this surface.
    warnOnUnaddressableExtensionOperatorConfigNames(retainedPackages);

    // -----------------------------------------------------------------------
    // Contribution processors are registered before startAll() so extension
    // contributions are awaited during coordinator activation/deactivation.
    // Framework processors are boot-owned; host/domain processors are
    // declared by loaded packages through MakaioExtension.runtimeBoot.
    // -----------------------------------------------------------------------
    // The adapter contribution processor is registered by prepareAdapterRuntime()
    // (above, before load) so the adapter subsystem composes as one unit.
    if (workerDispatch) coordinator.registerContributionProcessor(workerDispatch.contributionProcessor);
    coordinator.registerContributionProcessor(createLogImportContributionProcessor());
    coordinator.registerContributionProcessor(createArtifactKindContributionProcessor());
    coordinator.registerContributionProcessor(createArtifactLifecycleHookContributionProcessor());
    coordinator.registerContributionProcessor(createFacetNamespaceContributionProcessor());
    coordinator.registerContributionProcessor(createSurfaceBindingContributionProcessor());
    coordinator.registerContributionProcessor(createArtifactViewBuilderContributionProcessor());
    coordinator.registerContributionProcessor(createToolContributionProcessor());
    const fixedOperations = createFixedOperationHost<KernelExtensionContext>(
      () => coordinator.list().map(({ name }) => name),
      (name) => coordinator.extensionStopBudgetMs(name),
    );
    coordinator.registerContributionProcessor(fixedOperations.processor);
    coordinator.registerContributionProcessor(createWorkflowBlockContributionProcessor());
    coordinator.registerContributionProcessor(createTransitionContributionProcessor());
    coordinator.registerContributionProcessor(
      createReactionContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    coordinator.registerContributionProcessor(createRuleContributionProcessor(getRuleContributions));
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
    collectHostCleanups(
      shutdownSteps,
      'extension boot contribution',
      registerExtensionBootContributions(enabledRetainedPackages, bus, coordinator),
    );
    // Close the credential channel before the bus/transport tears down. In
    // reverse shutdown order this runs after coordinator.shutdown() (which
    // stops all extension activity) and before transport.disconnect().
    shutdownSteps.push(resourceStep('credentials channel', () => credentialBinder.close()));
    shutdownSteps.push(extensionsStep(coordinator, (release) => void transportDisconnected.promise.then(release)));
    collectHostCleanups(
      shutdownSteps,
      'host coordinator cleanup',
      options.configureCoordinator?.({
        bus,
        coordinator,
        registerContributionProcessor: (processor) => {
          coordinator.registerContributionProcessor(processor);
        },
        getAdapterSubsystemService: () => coordinator.getExtensionService(AdapterSubsystemToken),
      }),
    );
    shutdownSteps.push(resourceStep('journal readers', () => journalReaders.destroy()));
    // Activation hooks stage a generation before the coordinator publishes its rights and active state.
    const stopReaderActivationWake = bus.on(ExtensionSubjects.stateChanged, ({ payload, transport }) => {
      if (transport === undefined && payload.to === 'active') journalReaders.wake();
    });
    shutdownSteps.push(
      localStep('journal reader activation', () => {
        stopReaderActivationWake();
        unregisterJournalReaders();
      }),
    );
    await journalReaders.init();

    // -----------------------------------------------------------------------
    // 8. ExtensionCoordinator.startAll — storage + services, surface-gated
    // -----------------------------------------------------------------------
    // HTTP route mounting is handled by the HttpContributionProcessor registered
    // above when routeGraphBuilder is provided. The processor adds/removes routes
    // dynamically as extensions activate/deactivate, so no imperative mount loop
    // is needed here.
    await coordinator.startAll({ signal: options.signal });
    const contributions = getRuleContributions();
    const reactions = getReactionRegistry();
    if (!contributions || !reactions) {
      throw new Error('Rule evaluation requires the host rule contributions and reaction registry');
    }
    ruleEvaluator = new RuleEvaluator(
      database,
      contributions,
      reactions.invoke.bind(reactions),
      coordinator.getRuleSourceRegistration,
    );
    const reportStartedConfig = reportOperatorConfig;
    reportOperatorConfig = undefined;
    reportStartedConfig();
    checkpoint();
    const stopRuleEvaluation = startRuleJournalEvaluation(database, ruleEvaluator);
    shutdownSteps.push(resourceStep('rule journal evaluation', stopRuleEvaluation));
    journalReaders.start();
    startGate.open();
    rights.openBoundary();
    await notifySubscriptionAvailability();
    // ORIGIN: Startup announces that the extension start phase is complete.
    await bus.emit(bus.own('start'), KernelSubjects.phase.servicesReady, { machineId });
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

    shutdownSteps.push(
      localStep(
        'runtime handlers',
        registerRuntimeHandlers(
          bus,
          () => adapterServiceRef.current?.getLoadedAdapters() ?? [],
          () => adapterServiceRef.current?.getAdapterInstances() ?? new Map(),
          (name) => coordinator.getExtension(name),
          (name) => operatorConfig.get(name),
          (name) => coordinator.getResolvedConfig(name),
        ),
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
    shutdownSteps.push(localStep('adapter runtime identity', adapterRuntimeIdentity.cleanup));

    // -----------------------------------------------------------------------
    // 10. Host coordinator-ready broadcast
    //
    // This is a typed lifecycle barrier only. Host integrations query concrete
    // runtime seams (extension contribution catalog, runtime resources, etc.)
    // through dedicated bus requests instead of receiving opaque objects here.
    // -----------------------------------------------------------------------
    // ORIGIN: Startup announces that the host coordinator is ready.
    await bus.broadcast(bus.own('start'), KernelSubjects.phase.coordinatorReady, {
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
    checkpoint();
    runtimeReady = true;
    // ORIGIN: Startup announces that the runtime is ready.
    await bus.emit(bus.own('start'), KernelSubjects.ready, { machineId });
    console.info('[boot] Runtime ready (machineId=%s)', machineId);

    const shutdownSequence = createShutdownSequence([...shutdownSteps].reverse());
    return {
      port: boundPort,
      host: boundHost,
      machineId,
      bus,
      coordinator,
      ruleEvaluator,
      fixedOperations: fixedOperations.host,
      trayEntries: coordinator.trayEntries,
      windowRegistry: coordinator.windowRegistry,
      /**
       * Close inbound admission before tearing down extensions and storage.
       * @returns Completion of the runtime shutdown sequence.
       */
      shutdown() {
        rights.closeBoundary();
        startGate.close(new Error('The journal host is shutting down.'));
        return shutdownSequence.run();
      },
      stopBudgetMs: shutdownSequence.budgetMs,
    };
  } catch (err) {
    rights.closeBoundary();
    startGate.close(err);
    reportOperatorConfig?.();
    // A cancellation reaches here as the signal's reason, or as an aggregate of the
    // cleanup failures it set off (see `cancellationRejection`).
    const startFailures = readCancellation(err, options.signal);
    const cancelled = startFailures !== undefined;
    if (cancelled) {
      console.info('[boot] Startup cancelled — rolling back started resources');
    } else {
      const code =
        err instanceof DuplicateCredentialResolverError ? 'DuplicateCredentialResolverError' : 'BOOT_STARTUP_FAILED';
      console.error('[boot] Startup failed (%s) — rolling back started resources', code);
    }
    // Roll back in reverse order, collecting what fails to unwind.
    const rollbackFailures = await runBoundedShutdownSteps([...shutdownSteps].reverse());
    for (const cleanupErr of rollbackFailures) console.warn('[boot] Rollback step error:', cleanupErr);
    // A failed startup is what the caller asked about, so the secondary failures
    // of unwinding a half-built runtime are reported rather than substituted for
    // it. A cancellation says nothing but "stop", so there the cleanup is the
    // news: failures of the phase that was cancelled and of the rollback are
    // reported apart from the reason, because swallowing them would let the
    // caller treat a stop that left resources behind as a clean one.
    if (cancelled) {
      throw cancellationRejection(
        options.signal?.reason,
        [...startFailures, ...rollbackFailures],
        '[boot] Startup cancelled, but rolling back the started resources failed',
      );
    }
    throw err;
  } finally {
    options.signal?.removeEventListener('abort', closeOnAbort);
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
