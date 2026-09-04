import type { Server as HttpServer } from 'node:http';
import type { BusTransport, IMakaioBus, SubjectTelemetryProjectorRegistry } from '@makaio/bus-core';
import type { RegistrableBusNamespaceDefinition } from '@makaio/core';
import type { FrameworkModuleResolver } from './framework-module-resolver.js';
import type { DispatchingAuth, TransportAuth } from '@makaio/bus-transport-websocket';
import type { BridgeBrowserOptions } from './create-static-mount.js';
import type {
  ExtensionConfigProvider,
  MakaioNodeExtension,
  TrayManifest,
  WorkerContributionManifest,
  WorkerDispatch,
  WorkerRequirements,
  WorkflowRunResult,
} from '@makaio/contracts';
import type {
  ExecutionAttemptRepository,
  WorkflowMaterializationSpecResolver,
} from '@makaio/subsystem-workflow-engine';
import type { PersistedMachineIdentity } from '@makaio/machine-identity';
import type { ConfigProvider } from '@makaio/providers';
import type { IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import type { PostInstallHandler, StrategyDependencies } from '@makaio/subsystem-client';
import type {
  ContributionProcessor,
  ExtensionCoordinator,
  ExtensionRuntimeSurface,
  KernelExtensionContext,
  KernelMakaioExtension,
  TransportProvider,
  WindowRegistry,
} from '@makaio/kernel';
import type { ShutdownStep } from './boot-phase.js';
import type { HostCapabilityDeclaration } from './boot-extension-selection.js';
import type { DatabaseBootOptions } from './initialize-node-database.js';
import type { ExtensionDiscovery } from './extension-discovery.js';
import type { HttpRouteGraphBuilder } from './http-route-graph-builder.js';
import type { WorkflowWorkerEntryMode } from './workflow-worker/worker-entry-resolver.js';
import type { WorkspaceRootResolver } from './workflow-worker/local-directory-materializer.js';

/** Dev-mode map from npm package name to absolute workspace package directory. */
export type DevPortalMap = ReadonlyMap<string, string>;

/**
 * Public handle for the adapter subsystem service methods exposed during host
 * coordinator wiring.
 */
export interface AdapterSubsystemServiceHandle {
  /**
   * Process adapter contributions for one active extension package.
   * @param packageName - Package that transitioned to active.
   * @param pkg - Extension manifest.
   * @param ctx - Per-extension context.
   */
  processAdapterContributions(
    packageName: string,
    pkg: KernelMakaioExtension,
    ctx: KernelExtensionContext,
  ): Promise<void>;

  /**
   * Stop adapter contributions for one stopped extension package.
   * @param packageName - Package that stopped or was disabled.
   */
  stopAdapterContributions(packageName: string): Promise<void>;
}

/**
 * Runtime boot configuration for the workflow-level runner.
 *
 * When omitted, the workflow engine uses its built-in runner default.
 * Explicit `{ mode: 'in-process' }` installs the Node runtime's concrete
 * in-process runner.
 * Set `mode: 'piscina'` to dispatch each full workflow execution to a
 * Piscina worker-thread pool running the workflow worker entry.
 */
export type WorkflowRunnerBootOptions =
  | {
      /** Use the Node runtime's concrete in-process workflow runner. */
      readonly mode?: 'in-process';
    }
  | {
      /** Dispatch full workflow executions to a Piscina worker-thread pool. */
      readonly mode: 'piscina';
      /** Contribution manifest loaded inside isolated workers. */
      readonly manifest?: WorkerContributionManifest;
      /** Host-owned resolver for portable local-directory workspace IDs. */
      readonly resolveWorkspaceRoot?: WorkspaceRootResolver;
      /** Explicit worker entry path. Overrides workerEntryMode resolution. */
      readonly workerEntry?: string;
      /** Source/dist worker entry mode used when workerEntry is omitted. */
      readonly workerEntryMode?: WorkflowWorkerEntryMode;
      /** Maximum concurrent worker threads. */
      readonly maxConcurrency?: number;
      /** Idle timeout before worker threads are reaped. */
      readonly idleTimeoutMs?: number;
    }
  | {
      /**
       * Delegate workflow executions to a product-owned Worker dispatch seam.
       *
       * The dispatch function is supplied by the host composition root and
       * typically wired to `workerPool.dispatch`. Framework code remains
       * decoupled from any pool implementation details.
       */
      readonly mode: 'worker';
      /**
       * Worker dispatch function injected by the host composition root.
       *
       * Called once per workflow execution with the full worker config and
       * manifest. Product hosts may wire this to `workerPool.dispatch`.
       * When omitted, the Node runtime dispatches through the framework
       * `worker.dispatch` bus subject and requires a bus instance.
       */
      readonly dispatch?: WorkerDispatch;
      /**
       * Contribution manifest forwarded to each dispatch call.
       *
       * When omitted, no explicit manifest is forwarded. Product hosts that
       * resolve project-level manifests in the dispatch function can leave this
       * empty so the dispatch layer can perform resolution.
       */
      readonly manifest?: WorkerContributionManifest;
      /**
       * Optional resource requirements forwarded to pool dispatch.
       *
       * When provided, the pool uses these to select a compatible provider.
       * Omit to accept any available pool with no constraints.
       */
      readonly requirements?: WorkerRequirements;
    };

/**
 * Bound address info passed to {@link BootMakaioRuntimeOptions.onTransportReady}.
 */
export interface TransportReadyInfo {
  /** Bound TCP port. */
  port: number;
  /** Bound host address (e.g. `'127.0.0.1'` or `'0.0.0.0'`). */
  host: string;
}

/**
 * Extension of {@link TransportProvider} that exposes an optional
 * {@link DispatchingAuth} handle for E2E auth hot-swap.
 *
 * Both Node and Bun transport providers implement this interface so the core
 * boot sequence can install E2E auth without depending on a concrete provider
 * class.
 */
export interface ServerTransportProvider extends TransportProvider {
  /**
   * The {@link DispatchingAuth} instance if the caller passed one.
   *
   * Exposed so boot can hot-swap E2E auth after machine identity becomes
   * available. Returns `undefined` when auth was not provided or is not a
   * {@link DispatchingAuth}.
   */
  readonly dispatchingAuth?: DispatchingAuth;
}

/**
 * Boot-time configuration for the optional projected upstream telemetry transport.
 */
export interface UpstreamTelemetryBootOptions {
  /**
   * Inner transport connected to the upstream collector.
   *
   * Raw application messages are never sent to it directly — only sanitized
   * `subject-telemetry.fact` events are forwarded by the projection layer.
   */
  readonly transport: BusTransport;
  /**
   * Registry name for the projected transport.
   *
   * Defaults to `'upstream-telemetry'`. Must be unique within the bus
   * transport registry.
   */
  readonly name?: string;
  /**
   * Optional sidecar projector registry for namespace-owned attribute extraction.
   *
   * When provided, sidecar projectors registered for a message's namespace and
   * subject take precedence over schema-driven attribute projection inside the
   * projected transport.
   */
  readonly projectorRegistry?: SubjectTelemetryProjectorRegistry;
}

/**
 * Platform-agnostic boot options shared by all runtime platforms.
 *
 * The Node-specific {@link BootMakaioRuntimeOptions} adds `httpServer` on top
 * of this base. Alternative platform boots (e.g. Bun) construct their own
 * transport and pass it alongside these options to `bootMakaioRuntimeCore`.
 */
export interface CoreBootOptions {
  /**
   * Optional route graph builder for dynamic HTTP route management.
   *
   * When provided, an {@link HttpContributionProcessor} is registered that
   * adds/removes extension HTTP routes on enable/disable, triggering a
   * Hono app rebuild via {@link HonoRouteGraph.replaceApp}. When absent
   * (e.g. Vite dev mode), extension HTTP routes are not mounted by boot.
   */
  routeGraphBuilder?: HttpRouteGraphBuilder;

  /**
   * Pre-built auth strategy (HMAC, DispatchingAuth, or undefined for dev).
   *
   * When `undefined` the bus server runs with no authentication — safe only
   * in dev mode (loopback-only binding).
   */
  auth?: TransportAuth;

  /**
   * Loopback transport registry name for in-process cross-client relay.
   *
   * Defaults to `'node'`.
   */
  loopbackName?: string;

  /**
   * Enable E2E auth hot-swap after machine identity loads.
   *
   * When `true` and `auth` is a {@link DispatchingAuth}, the E2E strategy is
   * installed into the dispatching auth instance after machine identity
   * becomes available. Set this when binding on all interfaces (LAN mode).
   */
  lanBind?: boolean;

  /**
   * Resolve a peer device's signing public key for E2E relay authentication.
   *
   * Required when `lanBind` is enabled — boot fails fast if missing. The
   * resolver is invoked during E2E handshakes to verify the identity of a
   * connecting peer. Returning `null` rejects the peer as unknown or revoked.
   *
   * Providing this at the composition root keeps the boot layer free of any
   * host device-registry dependency.
   * @param peerId - Device ID of the connecting peer.
   * @returns CryptoKey for signature verification, or `null` for unknown/revoked peers.
   */
  peerSigningKeyResolver?: (peerId: string) => Promise<CryptoKey | null>;

  /**
   * Hosted surface category for extension gating.
   *
   * Defaults to `'headless'`. Interactive surfaces like Vite dev server or
   * Electron should pass `'interactive'` so UI-bound extensions can load.
   */
  surface?: ExtensionRuntimeSurface;

  /**
   * Filesystem path to the framework central Drizzle migrations directory.
   *
   * Normal source builds omit this and use the package-local
   * `@makaio/storage-migrations/drizzle` folder. Bundled hosts pass the copied
   * runtime asset path explicitly because the original package directory may
   * not exist in the deployed image.
   */
  readonly centralMigrationsDir?: string;

  /**
   * Database backend configuration. Resolution order for the connection target
   * (empty and whitespace-only values count as unset):
   * 1. `database.url`  2. env `MAKAIO_DATABASE_URL`  3. the `dbPath` option of
   * direct `initializeNodeDatabase` callers  4. env `MAKAIO_DATABASE_PATH`
   * 5. `<makaioHome>/makaio.db`
   *
   * A `postgres://` / `postgresql://` URL selects the Postgres backend.
   */
  readonly database?: DatabaseBootOptions;

  /**
   * Host-provided runtime config provider.
   *
   * When omitted, boot uses the default Node runtime provider backed by
   * `FileConfigStorage` under {@link CoreBootOptions.makaioHome}. Custom
   * providers own effective config resolution, persisted config updates, env
   * overlays, and the machine-id string returned by `getMachineId()`.
   *
   * The returned machine ID must match the resolved runtime machine identity:
   * either {@link CoreBootOptions.machineIdentity} when supplied, or the
   * default identity loaded from `{makaioHome}/keys` when omitted.
   */
  readonly configProvider?: ConfigProvider;

  /**
   * Host-provided adapter/provider config repository.
   *
   * When omitted, boot uses `FileAdapterConfigRepository` under
   * `{makaioHome}/adapters` and `{makaioHome}/provider-configs`. Custom
   * repositories must implement the full canonical adapter/provider config
   * persistence contract.
   */
  readonly adapterConfigRepository?: IAdapterConfigRepository;

  /**
   * Host-selected automation cron scheduler provider package.
   *
   * `makaio.cron` bindings own no timers: they delegate to the single provider
   * registered under `AutomationCronSchedulerToken`. Supply this option when the
   * host schedules somewhere other than in-process — for example centrally,
   * through a relay — so exactly one host decides when a cron binding fires.
   *
   * When omitted, boot registers the framework's local in-process provider,
   * unless a loaded extension already registers one. Boot fails when the
   * supplied package does not register the scheduler service, and when two
   * providers would be active at once.
   */
  readonly automationCronSchedulerPackage?: MakaioNodeExtension<IMakaioBus>;

  /**
   * Host-provided persisted runtime machine identity.
   *
   * When omitted, boot loads or creates the default identity from
   * `{makaioHome}/keys`. This is the crypto-bearing runtime identity used by
   * `RuntimeSubjects.machineIdentity` and LAN E2E auth, not the narrower kernel
   * `MachineIdentity` shape.
   */
  readonly machineIdentity?: PersistedMachineIdentity;

  /**
   * Host launcher command embedded into client wiring installed from warning actions.
   *
   * Defaults to `'makaio'`. Prefer `makaio.config.*` when a user/workspace
   * needs a different launcher identity.
   */
  readonly launcherCommand?: string;

  /**
   * Enable the extension package-manager service.
   *
   * Defaults to `true` for interactive/dev hosts. Bundled cloud hosts can set
   * this to `false` because their extension set is fixed at image build time
   * and the Yarn package-management service is not part of the runtime surface.
   */
  readonly enablePackageManager?: boolean;

  /**
   * Called when the bus WebSocket transport is attached and accepting
   * connections, before service boot begins.
   *
   * This is the earliest safe moment for external clients to connect to
   * the bus. Composition roots use this to announce the bound address
   * (e.g. `MAKAIO_PORT=<n>` on stdout) or to unblock dependent processes.
   * @param info - Bound host and port from the server.
   */
  onTransportReady?: (info: TransportReadyInfo) => void;

  /**
   * Custom extension discovery strategy.
   *
   * When provided, replaces the default `FilesystemDescriptorDiscovery`
   * instance. Use `ExplicitDescriptorDiscovery` to supply pre-scanned
   * extension descriptors in tests or host-owned discovery flows.
   */
  discovery?: ExtensionDiscovery;

  /**
   * Framework version used for extension `makaio.framework` range gating.
   *
   * When omitted, the version is read from `@makaio/runtime-node`'s
   * `package.json` at boot time. Pass an explicit value in tests or host
   * builds where the package.json may not be on disk.
   */
  frameworkVersion?: string;

  /**
   * Capability facts declared by the host composition root.
   *
   * Passed to the coordinator as the host capability set, with object-form
   * entries preserving concrete versions for versioned `requires` checks.
   * Runtime tokens such as `'node'` must be included here by Node-based hosts;
   * the boot layer no longer injects them automatically so that Bun and future
   * platforms can declare their own tokens.
   * @example
   * ```ts
   * ['node', 'workspace-host', { id: 'storage.drizzle', version: '1.2.0' }]
   * ```
   */
  readonly hostCapabilities?: readonly HostCapabilityDeclaration[];

  /**
   * Host-owned bus namespace definitions registered during the core bus boot
   * phase before any handlers, services, or remote clients can use them.
   *
   * Use this for surface-specific contracts owned outside runtime-node, such as
   * desktop UI namespaces, without making the generic runtime depend on those
   * packages.
   */
  readonly hostNamespaces?: readonly RegistrableBusNamespaceDefinition[];

  /**
   * Host-provided package config defaults keyed by package name.
   *
   * Merged with descriptor defaults before stored config is loaded. Prefer
   * `makaio.config.*` for user/workspace runtime defaults; this seam remains
   * for composition roots that need to inject process-local defaults.
   */
  readonly packageConfigDefaults?: ReadonlyMap<string, Readonly<Record<string, unknown>>>;

  /**
   * Host-provided handlers for client binary post-install descriptors.
   *
   * Client packages declare declarative `postInstall.kind` values; composition
   * roots provide the concrete handler map here so `@makaio/runtime-node` stays free
   * of host-specific post-install logic.
   */
  readonly clientBinaryPostInstallHandlers?: ReadonlyMap<string, PostInstallHandler>;

  /**
   * Workflow-level runner for dispatching full workflow executions.
   *
   * Omit to use the workflow engine's built-in default runner. Set to
   * `{ mode: 'in-process' }` to install the Node runtime's concrete in-process
   * runner, or `piscina` to dispatch each execution to a worker-thread pool
   * that runs the workflow worker entry end-to-end.
   */
  readonly workflowRunner?: WorkflowRunnerBootOptions;

  /**
   * Host-owned allowed-root resolver for local Piscina execution.
   *
   * This is intentionally a boot seam rather than persisted workflow state:
   * it maps the portable workspace ID to a directory that this host is
   * permitted to realize.
   */
  readonly piscinaWorkspaceRootResolver?: WorkspaceRootResolver;

  /** Host-owned resolvers that create portable specs for path-backed workflow starts. */
  readonly workflowMaterializationSpecResolvers?: readonly WorkflowMaterializationSpecResolver[];

  /**
   * Injected execution attempt persistence port for Worker dispatch.
   *
   * Required when `workflowRunner.mode` is `'worker'`. The consuming
   * Factory provides the concrete implementation that owns durable attempt
   * records and accept/duplicate/conflict/fence decisions.
   *
   * When omitted, framework-only, in-process, and Piscina modes operate
   * without attempt tracking. Worker mode fails fast at boot when this
   * is not provided.
   */
  readonly executionAttemptRepository?: ExecutionAttemptRepository<WorkflowRunResult>;

  /**
   * Runtime data home for config, database, machine identity, and installed
   * extensions. Defaults to the `MAKAIO_HOME` environment override when set,
   * otherwise `~/.makaio`.
   */
  readonly makaioHome?: string;

  /**
   * Host-provided fallback model-registry seed candidates.
   *
   * These are tried after the CDN cache source and before the runtime's
   * boot-relative seed path. Desktop package surfaces use this to pass
   * resource directories that are known only to the app shell, keeping
   * runtime-node free of Electron/Electrobun globals while preserving CDN
   * freshness whenever the network source is available.
   */
  readonly modelRegistryFallbackSeedPaths?: readonly string[];

  /**
   * Optional runtime module resolver for `@makaio/framework/*` subpath imports.
   *
   * When provided, installed before extension loading so published extensions
   * resolve framework imports to the packaged dist. Not needed in dev mode
   * where workspace resolution handles framework imports.
   */
  readonly frameworkModuleResolver?: FrameworkModuleResolver;

  /**
   * Host-provided `@makaio/framework` package root.
   *
   * Packaged hosts can pass the app-bundled framework package here so installed
   * extensions and package-manager installs resolve framework imports to the
   * same physical package instance as the host process.
   */
  readonly frameworkPackagePath?: string;

  /**
   * Host-provided managed-binary I/O implementation.
   *
   * The shared boot core only wires the seam through. Concrete hosts supply
   * their own filesystem, network, archive, and subprocess implementation so
   * Node, Bun, and future runtimes do not inherit Node-shaped I/O implicitly.
   */
  readonly clientBinaryStrategyDependencies?: StrategyDependencies;

  /**
   * Dev-mode workspace package map used to rewrite extension install specs to
   * Yarn `portal:` ranges.
   *
   * When provided and non-empty, the package-manager service wraps its
   * dependency resolver so that installs for known workspace packages link
   * directly to local source directories instead of fetching from npm. This is
   * the same `portal:` mechanism used for `frameworkPackagePath`, extended to
   * the full set of extension packages available in the host workspace.
   *
   * Has no effect when `enablePackageManager` is `false`.
   */
  readonly devPortalPackages?: DevPortalMap;

  /**
   * Optional provider for persisted extension configuration and enablement state.
   *
   * When present, the coordinator consults this provider during {@link ExtensionCoordinator.startAll}
   * and `ExtensionCoordinator.enableExtension` to load stored configuration and
   * skip packages that were previously disabled. When absent, all extensions
   * start enabled with default (Zod-schema) configuration only.
   */
  readonly extensionConfigProvider?: ExtensionConfigProvider;

  /**
   * Host-owned coordinator wiring invoked after framework processors are registered
   * and before {@link ExtensionCoordinator.startAll}.
   *
   * Concrete hosts use this seam for contribution processors and bus services
   * that must observe active extension contributions without importing
   * host-owned packages into the framework boot layer.
   * @param context - Coordinator setup context.
   * @returns Optional cleanup callbacks collected into runtime shutdown.
   */
  readonly configureCoordinator?: (
    context: BootCoordinatorSetupContext,
  ) => void | ShutdownStep | readonly ShutdownStep[];

  /**
   * Optional projected upstream telemetry transport.
   *
   * Boot wraps this transport with a projector that only sends
   * `subject-telemetry.fact` events upstream. The raw transport is never
   * registered directly on the bus.
   */
  readonly upstreamTelemetry?: UpstreamTelemetryBootOptions;

  /**
   * Static mount factory for extension browser bundles.
   *
   * Node hosts default to `@hono/node-server/serve-static`; Bun hosts pass
   * their Bun-native `hono/bun` implementation through this seam.
   *
   * When omitted, the platform-default factory is used (Node: `@hono/node-server/serve-static`).
   */
  readonly createMount?: BridgeBrowserOptions['createMount'];
}

/** Context passed to host-owned coordinator setup. */
export interface BootCoordinatorSetupContext {
  /** Runtime bus. */
  readonly bus: IMakaioBus;
  /** Extension coordinator being configured before startup. */
  readonly coordinator: ExtensionCoordinator;
  /** Register an awaited contribution processor. */
  readonly registerContributionProcessor: (processor: ContributionProcessor) => void;
  /** Read the active adapter subsystem service when it exists. */
  readonly getAdapterSubsystemService: () => AdapterSubsystemServiceHandle | undefined;
}

/**
 * Options for `bootMakaioRuntime` (Node.js platform).
 *
 * Extends the platform-agnostic {@link CoreBootOptions} with the Node HTTP
 * server required for transport attachment.
 */
export interface BootMakaioRuntimeOptions extends CoreBootOptions {
  /**
   * HTTP server, already listening.
   *
   * The bus transport attaches its WebSocket upgrade handler to this server.
   */
  httpServer: HttpServer;
}

/**
 * Handle returned by `bootMakaioRuntime` on successful startup.
 */
export interface MakaioRuntime {
  /**
   * Bound TCP port (read from httpServer).
   */
  port: number;

  /**
   * Bound host address (e.g. `'127.0.0.1'` or `'0.0.0.0'`).
   */
  host: string;

  /**
   * Machine identifier (UUID).
   */
  machineId: string;

  /**
   * The booted bus instance.
   *
   * Exposed so host composition roots can pass the live bus to seams that
   * need a direct reference after boot (e.g. in-process workflow runner,
   * test harnesses, host-owned contribution processors).
   */
  bus: IMakaioBus;

  /**
   * Tray manifest entries collected from all loaded packages.
   *
   * Each entry includes the owning `packageName` so the Electron shell can
   * resolve the fully-qualified window registration ID
   * (`{packageName}:{opensWindow}`) when building the tray menu.
   *
   * Populated during the extension coordinator's {@link ExtensionCoordinator.load}
   * phase, before services start. Available immediately after `bootMakaioRuntime`
   * resolves.
   */
  trayEntries: ReadonlyArray<TrayManifest & { readonly packageName: string }>;

  /**
   * Window registry populated from package manifests during the extension
   * coordinator {@link ExtensionCoordinator.load} phase.
   *
   * The Electron shell passes this to `WindowManager` so window
   * creation uses the registry that was actually populated during boot,
   * rather than an independent empty instance.
   *
   * Available immediately after `bootMakaioRuntime` resolves.
   */
  windowRegistry: WindowRegistry;

  /**
   * Extension coordinator that manages the lifecycle of all loaded packages.
   *
   * Exposed so integration tests and host composition roots can inspect the
   * active service graph (e.g. via `getExtensionService`) after boot.
   */
  readonly coordinator: ExtensionCoordinator;

  /**
   * Shut down all services in reverse startup order.
   *
   * Every step is attempted even when an earlier one fails, and the failures
   * are then reported together. A host that owns process termination must
   * treat the rejection as an unclean exit — something the runtime started is
   * still holding resources it could not release — rather than logging it and
   * exiting as if the drain had completed.
   * @returns Promise that settles once every step has been attempted, resolving
   *   on success and rejecting with an AggregateError when any step fails.
   * @throws An AggregateError when any shutdown step failed.
   */
  shutdown(): Promise<void>;
}
