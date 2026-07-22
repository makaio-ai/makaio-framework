import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { FrameworkContractNamespaces, FrameworkStorageNamespaces } from '@makaio/contracts';
import { ExtensionCoordinator, type KernelMakaioExtension, KernelSubjects } from '@makaio/kernel';
import {
  canonicalModelPackage,
  sessionBridgePackage,
  sessionOrchestratorPackage,
  sessionPackage,
  sessionStoragePackage,
  createSubagentServicePackage,
  createToolContributionProcessor,
  ToolRegistryToken,
  toolRegistryPackage,
} from '@makaio/services-core';
import { createClientsCorePackage } from '@makaio/subsystem-client';
import type { Toolset } from '@makaio/tools-core';
import {
  activateAdapterRuntimeIdentity,
  prepareAdapterRuntime,
  type PrepareAdapterRuntimeInput,
} from '../compose-adapter-runtime.js';
import {
  registerExtensionBootContributions,
  shouldLoadDefaultSessionOrchestrator,
} from '../boot-extension-selection.js';
import type { ShutdownStep } from '../boot-phase.js';
import { tryImport } from '../optional-package.js';

const LOCAL_RUNTIME_SNAPSHOT_PRIORITY = 1;
const ISOLATED_SESSION_BASE_PACKAGES = [sessionStoragePackage, sessionBridgePackage, sessionPackage] as const;

/** Connect an isolated runtime bus to its authenticated authority. */
export type WorkflowRuntimeAuthorityConnector = (bus: IMakaioBus) => Promise<void>;

/** Discover runtime contributions after the authority connection is authenticated. */
export type WorkflowRuntimeContributionLoader = (bus: IMakaioBus) => Promise<readonly KernelMakaioExtension[]>;

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
  readonly contributedPackages: readonly KernelMakaioExtension[];
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
  readonly coordinator: ExtensionCoordinator;
  readonly machineId: string;
  /** Release all runtime-owned resources in reverse startup order. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Create an idempotent reverse-order shutdown runner over a mutable startup stack.
 * @param steps - Startup-owned cleanup steps appended as resources activate.
 * @returns Idempotent shutdown function.
 */
function createShutdownRunner(steps: readonly ShutdownStep[]): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= (async () => {
      const errors: unknown[] = [];
      for (const step of [...steps].reverse()) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Isolated workflow runtime shutdown reported errors');
    })();
    return promise;
  };
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
  bus.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);

  const { context } = options;
  const coordinator = new ExtensionCoordinator(bus, {
    surface: 'headless',
    extensionContextBase: {
      cwd: context.cwd,
      platform: context.platform,
      homedir: context.homedir,
      makaioHome: context.makaioHome,
      username: context.username,
      machineId: context.machineId,
      tryImport,
    },
  });

  let identity: ReturnType<typeof activateAdapterRuntimeIdentity> | undefined;
  const shutdownSteps: ShutdownStep[] = [() => bus.disconnect()];
  const shutdown = createShutdownRunner(shutdownSteps);

  try {
    await options.connectAuthority(bus);

    const contributedPackages = [
      ...options.contributedPackages,
      ...((await options.loadContributedPackages?.(bus)) ?? []),
    ];

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
    const clientsCorePackage = createClientsCorePackage({
      definitions: contributedPackages.flatMap((pkg) => pkg.clients ?? []),
      binaryResolutionPolicy: 'global-only',
    });

    coordinator.registerContributionProcessor(createToolContributionProcessor());
    const packagesToLoad = [
      ...ISOLATED_SESSION_BASE_PACKAGES,
      // Canonical-model initialization synchronously probes the local adapter subsystem.
      adapterSubsystemPackage,
      canonicalModelPackage,
      ...(shouldLoadDefaultSessionOrchestrator(contributedPackages) ? [sessionOrchestratorPackage] : []),
      createSubagentServicePackage(LOCAL_RUNTIME_SNAPSHOT_PRIORITY),
      toolRegistryPackage,
      clientsCorePackage,
      ...contributedPackages,
    ];
    coordinator.load(packagesToLoad);
    shutdownSteps.push(...registerExtensionBootContributions(packagesToLoad, bus, coordinator));
    shutdownSteps.push(() => coordinator.shutdown());
    await coordinator.startAll();

    identity = activateAdapterRuntimeIdentity({ bus, currentMachineId: context.machineId });
    shutdownSteps.push(() => {
      identity?.cleanup();
      identity = undefined;
    });
    const toolRegistry = coordinator.getExtensionService(ToolRegistryToken);
    if (toolRegistry === undefined) {
      throw new Error('Isolated workflow tool registry did not start.');
    }
    for (const toolset of options.toolsets) {
      await toolRegistry.register(toolset);
    }

    await bus.emit(KernelSubjects.ready, { machineId: context.machineId });
    return { bus, coordinator, machineId: context.machineId, shutdown };
  } catch (error) {
    // Best-effort cleanup must not replace the actionable startup error.
    await shutdown().catch(() => undefined);
    throw error;
  }
}
