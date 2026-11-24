import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts/extension';
import { FrameworkContractNamespaces, FrameworkStorageNamespaces, WorkflowNamespace } from '@makaio/contracts';
import {
  ExtensionCoordinator,
  filterEligibleExtensions,
  type KernelMakaioExtension,
  KernelSubjects,
} from '@makaio/kernel';
import {
  canonicalModelPackage,
  sessionBridgePackage,
  sessionOrchestratorPackage,
  sessionPackage,
  createSubagentServicePackage,
  createToolContributionProcessor,
  ToolRegistryToken,
  toolRegistryPackage,
} from '@makaio/services-core';
import { AdapterSubsystemToken, orderAfterAdapterSubsystem } from '@makaio/subsystem-adapter';
import {
  ClientBinaryStorageNamespace,
  ClientProfileStorageNamespace,
  ClientRuntimeStorageNamespace,
  createClientsCorePackage,
} from '@makaio/subsystem-client';
import type { Toolset } from '@makaio/tools-core';
import {
  activateAdapterRuntimeIdentity,
  prepareAdapterRuntime,
  type PrepareAdapterRuntimeInput,
} from '../compose-adapter-runtime.js';
import { cliDetectionPackage } from '../cli-detection/package.js';
import {
  buildRuntimeEnvironment,
  registerExtensionBootContributions,
  shouldLoadDefaultSessionOrchestrator,
} from '../boot-extension-selection.js';
import type { ShutdownStep } from '../boot-phase.js';
import { createReverseShutdownRunner } from './reverse-shutdown-runner.js';
import { tryImport } from '../optional-package.js';
import { NodeCredentialProvider } from '../credential-provider.js';

const LOCAL_RUNTIME_SNAPSHOT_PRIORITY = 1;
const ISOLATED_SESSION_BASE_PACKAGES = [sessionBridgePackage, sessionPackage] as const;

type IsolatedWorkflowExtensionContext = IsolatedNodeExtensionContext<IMakaioBus>;

/** Connect an isolated runtime bus to its authenticated authority. */
export type WorkflowRuntimeAuthorityConnector = (bus: IMakaioBus) => Promise<void>;

/**
 * Discover runtime contributions after the authority connection is authenticated.
 * @param bus - Connected isolated runtime bus.
 * @returns Contributed manifests for isolated activation.
 */
export type WorkflowRuntimeContributionLoader = (
  bus: IMakaioBus,
) => Promise<readonly KernelMakaioExtension<IsolatedWorkflowExtensionContext>[]>;

/** Node host context supplied by the runtime composition root. */
export interface IsolatedWorkflowRuntimeContext {
  /** Working directory exposed to adapters and contributed packages. */
  readonly cwd: string;
  /** Current platform identifier. */
  readonly platform: NodeJS.Platform;
  /** User's home directory path. */
  readonly homedir: string;
  /** Resolved `.makaio` home directory. */
  readonly makaioHome: string;
  /** Current OS username. */
  readonly username: string;
  /** Stable runtime machine identity. */
  readonly machineId: string;
}

/** Inputs for composing an authority-backed isolated workflow runtime. */
export interface CreateIsolatedWorkflowRuntimeOptions {
  /** Connect the new bus to an already authenticated authority transport. */
  readonly connectAuthority: WorkflowRuntimeAuthorityConnector;
  /** Load authority-dependent contribution packages after authentication. */
  readonly loadContributedPackages?: WorkflowRuntimeContributionLoader;
  /** Exact extension packages contributed to this runtime. */
  readonly contributedPackages: readonly KernelMakaioExtension<IsolatedWorkflowExtensionContext>[];
  /** Adapter configuration persistence supplied by the authority host. */
  readonly configRepository: PrepareAdapterRuntimeInput['configRepository'];
  /** Trusted non-serializable adapter authentication preparer. */
  readonly prepareAuthRuntime?: PrepareAdapterRuntimeInput['prepareAuthRuntime'];
  /** Explicit Node host context for adapters and contributed packages. */
  readonly context: IsolatedWorkflowRuntimeContext;
  /** Toolsets explicitly authorized for this runtime. */
  readonly toolsets: readonly Toolset[];
}

/** Active isolated workflow runtime and its owned lifecycle. */
export interface IsolatedWorkflowRuntime {
  readonly bus: IMakaioBus;
  readonly coordinator: ExtensionCoordinator<IsolatedWorkflowExtensionContext>;
  readonly machineId: string;
  /** Release all runtime-owned resources in reverse startup order. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Activate the adapter identity routes after the isolated coordinator starts.
 * @param bus - Isolated runtime bus that carries adapter identity requests.
 * @param coordinator - Started coordinator owning the live adapter subsystem.
 * @param machineId - Machine identity assigned to this isolated runtime.
 * @returns Active identity routes and their lifecycle cleanup.
 */
function activateIsolatedAdapterRuntimeIdentity(
  bus: IMakaioBus,
  coordinator: ExtensionCoordinator<IsolatedWorkflowExtensionContext>,
  machineId: string,
): ReturnType<typeof activateAdapterRuntimeIdentity> {
  return activateAdapterRuntimeIdentity({
    bus,
    currentMachineId: machineId,
    resolveLiveAdapterId: (adapterName) =>
      coordinator.getExtensionService(AdapterSubsystemToken)?.resolveLiveAdapterId(adapterName),
    resolveLiveAdapterIdentity: (adapterId) =>
      coordinator.getExtensionService(AdapterSubsystemToken)?.resolveLiveAdapterIdentity(adapterId),
    listLiveAdapterIdentities: () =>
      coordinator.getExtensionService(AdapterSubsystemToken)?.getLiveAdapterIdentities() ?? [],
  });
}

/**
 * Build the isolated extension coordinator without host database capabilities.
 * @param bus - Isolated runtime bus.
 * @param context - Worker host fields supplied to extension contexts.
 * @param runtimeEnvironment - Host identities and capabilities used for admission.
 * @returns Coordinator for the isolated Node context.
 */
function createIsolatedCoordinator(
  bus: IMakaioBus,
  context: IsolatedWorkflowRuntimeContext,
  runtimeEnvironment: ReturnType<typeof buildRuntimeEnvironment>,
): ExtensionCoordinator<IsolatedWorkflowExtensionContext> {
  return new ExtensionCoordinator<IsolatedWorkflowExtensionContext>(bus, {
    rights: 'refused',
    surface: 'headless',
    runtimeEnvironment,
    extensionContextBase: {
      cwd: context.cwd,
      platform: context.platform,
      homedir: context.homedir,
      makaioHome: context.makaioHome,
      username: context.username,
      machineId: context.machineId,
      tryImport,
      credentialsFor: () => new NodeCredentialProvider(),
      /**
       * Use the shared Node context fields for isolated extension activation.
       * @param base - Coordinator-provided extension context.
       * @returns Isolated extension context.
       */
      constructContext: (base) => base,
    },
  });
}

/**
 * Compose an isolated, authority-backed runtime for workflow agent steps.
 *
 * The runtime deliberately owns no database and installs no local storage
 * handlers. It owns the session turn orchestration required by local adapters,
 * while durable session storage and usage requests cross the supplied authenticated
 * authority connection. Product bootstrap, package discovery, relay policy, and
 * worker-pool concerns remain with the caller.
 * @param options - Authority connection, packages, adapter preparation, host context, and tools.
 * @returns A started runtime with an idempotent shutdown handle.
 */
export async function createIsolatedWorkflowRuntime(
  options: CreateIsolatedWorkflowRuntimeOptions,
): Promise<IsolatedWorkflowRuntime> {
  const bus = createBusInstance();
  // The runtime hosts the workflow contract for executor traffic without loading the workflow engine extension.
  bus.registerNamespaces([
    ...FrameworkContractNamespaces,
    ...FrameworkStorageNamespaces,
    WorkflowNamespace,
    ClientBinaryStorageNamespace,
    ClientProfileStorageNamespace,
    ClientRuntimeStorageNamespace,
  ]);

  const { context } = options;
  const runtimeEnvironment = buildRuntimeEnvironment(context.platform, ['node']);
  const coordinator = createIsolatedCoordinator(bus, context, runtimeEnvironment);

  const transportDisconnected = Promise.withResolvers<void>();
  const shutdownSteps: ShutdownStep[] = [
    () => {
      try {
        bus.disconnect();
      } finally {
        transportDisconnected.resolve();
      }
    },
  ];
  const shutdown = createReverseShutdownRunner(shutdownSteps);

  try {
    await options.connectAuthority(bus);

    const contributedPackages = filterEligibleExtensions(
      [...options.contributedPackages, ...((await options.loadContributedPackages?.(bus)) ?? [])],
      'headless',
      runtimeEnvironment,
    );

    const { adapterSubsystemPackage } = prepareAdapterRuntime({
      coordinator,
      configRepository: options.configRepository,
      platformDefaults: { cwd: context.cwd },
      // Runtime snapshots select the adapterId consumed by adapter execution
      // handlers. They must resolve on this runtime before an authority peer's
      // unscoped control-plane handler can claim the request.
      runtimeSnapshotHandlerPriority: LOCAL_RUNTIME_SNAPSHOT_PRIORITY,
      runtimeDefinitionHandlerPriority: LOCAL_RUNTIME_SNAPSHOT_PRIORITY,
      ...(options.prepareAuthRuntime !== undefined && { prepareAuthRuntime: options.prepareAuthRuntime }),
    });
    const clientsCorePackage = createClientsCorePackage<IsolatedWorkflowExtensionContext>({
      definitions: contributedPackages.flatMap((pkg) => pkg.clients ?? []),
      binaryResolutionPolicy: 'global-only',
    });

    coordinator.registerContributionProcessor(createToolContributionProcessor<IsolatedWorkflowExtensionContext>());
    const packagesToLoad = [
      ...ISOLATED_SESSION_BASE_PACKAGES,
      // Canonical-model initialization synchronously probes the local adapter subsystem.
      adapterSubsystemPackage,
      canonicalModelPackage,
      ...(shouldLoadDefaultSessionOrchestrator(contributedPackages) ? [sessionOrchestratorPackage] : []),
      createSubagentServicePackage<IsolatedWorkflowExtensionContext>(LOCAL_RUNTIME_SNAPSHOT_PRIORITY),
      toolRegistryPackage,
      cliDetectionPackage,
      clientsCorePackage,
      // Contributed packages may contribute adapters, which the subsystem must
      // already be running to process.
      ...orderAfterAdapterSubsystem(contributedPackages),
    ];
    // No `frameworkPackageNames`: this runtime replaces a base package by
    // omitting it (see `shouldLoadDefaultSessionOrchestrator`), never by
    // registering a second package under its name, so every name collision
    // here is an error the coordinator should refuse rather than resolve.
    //
    // Retained packages only: this runtime is headless, so a package declaring
    // an interactive surface never activates here, and configuring its boot
    // contribution would install behaviour for an extension that does not run.
    const retainedPackages = coordinator.load(packagesToLoad);
    shutdownSteps.push(...registerExtensionBootContributions(retainedPackages, bus, coordinator));
    shutdownSteps.push(() => coordinator.shutdown((release) => void transportDisconnected.promise.then(release)));
    await coordinator.startAll();

    const identity = activateIsolatedAdapterRuntimeIdentity(bus, coordinator, context.machineId);
    shutdownSteps.push(identity.cleanup);
    const toolRegistry = coordinator.getExtensionService(ToolRegistryToken);
    if (toolRegistry === undefined) {
      throw new Error('Isolated workflow tool registry did not start.');
    }
    for (const toolset of options.toolsets) {
      await toolRegistry.register(toolset);
    }

    // ORIGIN: Startup announces that the isolated runtime is ready.
    await bus.emit(bus.own('start'), KernelSubjects.ready, { machineId: context.machineId });
    return { bus, coordinator, machineId: context.machineId, shutdown };
  } catch (error) {
    // Best-effort cleanup must not replace the actionable startup error.
    await shutdown().catch(() => undefined);
    throw error;
  }
}
