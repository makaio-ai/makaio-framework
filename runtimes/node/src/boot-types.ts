import type { Server as HttpServer } from 'node:http';
import type { IMakaioBus } from '@makaio/bus-core';
import type { RegistrableBusNamespaceDefinition } from '@makaio/core';
import type { FrameworkModuleResolver } from './framework-module-resolver.js';
import type { DispatchingAuth, TransportAuth } from '@makaio/bus-transport-websocket';
import type {
  ExtensionConfigProvider,
  TrayManifest,
  WorkerContributionManifest,
  WorkerNodeDispatch,
  WorkerNodeRequirements,
} from '@makaio/contracts';
import type { AdapterSubsystemService } from '@makaio/subsystem-adapter';
import type { PostInstallHandler, StrategyDependencies } from '@makaio/subsystem-client';
import type { DevPortalMap } from '@makaio/services-package-manager';
import type {
  ContributionProcessor,
  ExtensionCoordinator,
  ExtensionRuntimeSurface,
  TransportProvider,
  WindowRegistry,
} from '@makaio/kernel';
import type { ShutdownStep } from './boot-phase.js';
import type { HostCapabilityDeclaration } from './boot-extension-selection.js';
import type { ExtensionDiscovery } from './extension-discovery.js';
import type { HttpRouteGraphBuilder } from './http-route-graph-builder.js';
import type { WorkflowWorkerEntryMode } from './workflow-worker/worker-entry-resolver.js';

/**
 * Runtime boot configuration for the workflow-level runner.
 *
 * Defaults to `in-process` (in-process DAG scheduler) when omitted.
 * Set `mode: 'piscina'` to dispatch each full workflow execution to a
 * Piscina worker-thread pool running the workflow worker entry.
 */
export type WorkflowRunnerBootOptions =
  | {
      /** Use the workflow engine's in-process DAG scheduler (default). */
      readonly mode?: 'in-process';
    }
  | {
      /** Dispatch full workflow executions to a Piscina worker-thread pool. */
      readonly mode: 'piscina';
      /** Contribution manifest loaded inside isolated workers. */
      readonly manifest?: WorkerContributionManifest;
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
       * Delegate workflow executions to a product-owned WorkerNode dispatch seam.
       *
       * The dispatch function is supplied by the host composition root and
       * typically wired to `workerPool.dispatch`. Framework code remains
       * decoupled from any pool implementation details.
       */
      readonly mode: 'worker-node';
      /**
       * WorkerNode dispatch function injected by the host composition root.
       *
       * Called once per workflow execution with the full worker config and
       * manifest. Product hosts wire this to `workerPool.dispatch`.
       */
      readonly dispatch: WorkerNodeDispatch;
      /**
       * Contribution manifest forwarded to each dispatch call.
       *
       * When omitted, an empty manifest is used. Product hosts that resolve
       * project-level manifests in the dispatch function can leave this empty.
       */
      readonly manifest?: WorkerContributionManifest;
      /**
       * Optional resource requirements forwarded to pool dispatch.
       *
       * When provided, the pool uses these to select a compatible provider.
       * Omit to accept any available pool with no constraints.
       */
      readonly requirements?: WorkerNodeRequirements;
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
   * Defaults to `in-process` (uses the engine's built-in DAG scheduler).
   * Set to `piscina` to dispatch each execution to a worker-thread pool
   * that runs the workflow worker entry end-to-end.
   */
  readonly workflowRunner?: WorkflowRunnerBootOptions;

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
  readonly getAdapterSubsystemService: () => AdapterSubsystemService | undefined;
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
   * Shut down all services in reverse startup order.
   */
  shutdown(): Promise<void>;
}
