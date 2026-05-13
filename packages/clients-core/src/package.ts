import * as path from 'node:path';
import {
  extensionToken,
  type ClientDefinition,
  type MakaioExtension,
  type ExtensionServiceLifecycle,
} from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { ClientRuntimeService } from './client-runtime-service.js';
import { ClientBinaryManager } from './client-binary-manager.js';
import { ClientDefinitionRegistry } from './client-definition-registry.js';
import { registerDrizzleRuntimeStorage } from './storage/runtime-drizzle-handler.js';
import { registerDrizzleClientBinaryStorage } from './storage/client-binary-drizzle-handler.js';
import type { StrategyDependencies } from './binary-strategies/index.js';
import type { PostInstallHandler } from './client-binary-manager-types.js';

// ---------------------------------------------------------------------------
// Composite service
// ---------------------------------------------------------------------------

/**
 * Composite service that initialises and destroys both the
 * {@link ClientRuntimeService} and the {@link ClientBinaryManager} under a
 * single {@link ExtensionServiceLifecycle} handle.
 *
 * The host coordinator calls `init()` once and `destroy()` once; this class
 * ensures both services participate in the same lifecycle without either
 * requiring knowledge of the other.
 */
export class ClientsCoreService implements ExtensionServiceLifecycle {
  /**
   * @param runtimeService - Handles `client.*` runtime observation subjects
   * @param binaryManager - Handles `client.*` binary-management subjects
   */
  public constructor(
    private readonly runtimeService: ClientRuntimeService,
    private readonly binaryManager: ClientBinaryManager,
  ) {}

  /**
   * Initialize both sub-services in parallel.
   *
   * Uses {@link Promise.allSettled} so both services always attempt
   * initialisation — matching the resilience pattern used by {@link destroy}.
   * If either service fails, the first rejection is re-thrown after all
   * attempts have settled.
   */
  public async init(): Promise<void> {
    const results = await Promise.allSettled([this.runtimeService.init(), this.binaryManager.init()]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      if (failures.length > 1) {
        console.warn('[ClientsCoreService] Multiple init failures, secondary:', failures[1].reason);
      }
      throw failures[0].reason;
    }
  }

  /**
   * Destroy both sub-services in parallel.
   *
   * Uses {@link Promise.allSettled} to guarantee both cleanups run even when
   * one rejects. Any rejections are logged for observability — matching the
   * secondary-failure logging pattern used by {@link init}.
   */
  public async destroy(): Promise<void> {
    const results = await Promise.allSettled([this.runtimeService.destroy(), this.binaryManager.destroy()]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const failure of failures) {
      console.warn('[ClientsCoreService] destroy failure:', failure.reason);
    }
  }
}

/** Typed package token for retrieving the clients-core service. */
export const ClientsCoreToken = extensionToken<ClientsCoreService>('makaio.clients-core');

// ---------------------------------------------------------------------------
// Package options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link createClientsCorePackage}.
 *
 * Definitions supplied here are seeded into a {@link ClientDefinitionRegistry}
 * at construction time, before the coordinator calls `init()` on the returned
 * service. All definitions must be available before `init()` runs — there is
 * no post-start mutation path on the service surface.
 */
export interface ClientsCorePackageOptions {
  /**
   * Client definitions to register before service initialisation.
   *
   * Typically populated by the boot composition root from discovered client
   * packages via `loadMakaioExtensions` before calling `coordinator.load`.
   */
  readonly definitions?: readonly ClientDefinition[];

  /**
   * I/O dependency implementations for the binary install strategies.
   *
   * When omitted the manager uses a no-op implementation that throws on every
   * call — correct for framework-only test callers that do not exercise binary
   * management, but must be replaced before binary installation is functional.
   *
   * Host composition roots pass their concrete strategy dependency
   * implementation here on real boot paths.
   */
  readonly strategyDependencies?: StrategyDependencies;

  /**
   * Framework-owned handlers for declarative post-install descriptors.
   *
   * Client packages declare `postInstall.kind`; the host supplies the handler
   * implementation here. Missing handlers fail the install job rather than
   * silently skipping a declared lifecycle step.
   *
   * When omitted no post-install handlers are registered.
   */
  readonly postInstallHandlers?: ReadonlyMap<string, PostInstallHandler>;
}

/**
 * Run storage handler registrations and return one cleanup that unwinds every
 * successful registration in reverse order.
 *
 * If any registration throws, previously registered handlers are immediately
 * rolled back so package startup remains retry-safe.
 * @param registrations - Ordered storage registration callbacks
 * @returns Cleanup function for all successful registrations
 */
export function registerStorageHandlersWithRollback(registrations: ReadonlyArray<() => () => void>): () => void {
  const cleanups: Array<() => void> = [];
  const rollback = (): void => {
    for (const cleanup of [...cleanups].reverse()) {
      cleanup();
    }
  };

  try {
    for (const register of registrations) {
      cleanups.push(register());
    }
  } catch (error) {
    rollback();
    throw error;
  }

  return rollback;
}

// ---------------------------------------------------------------------------
// Package factory
// ---------------------------------------------------------------------------

/**
 * Create the MakaioExtension manifest for the in-memory client runtime service
 * and the client binary manager.
 *
 * `@makaio/runtime-node` calls this factory after loading client packages and passes
 * the resulting manifest to the extension coordinator. Definitions supplied
 * via {@link ClientsCorePackageOptions.definitions} are seeded into a
 * {@link ClientDefinitionRegistry} before `init()` runs, so
 * `client.list` returns managed clients immediately after service startup.
 * @example
 * ```ts
 * const clientPackages = await loadMakaioExtensions(discoveredClients, { importModule });
 * const pkg = createClientsCorePackage({
 *   definitions: clientPackages.flatMap((p) => p.clients ?? []),
 * });
 * coordinator.load([pkg, ...otherPackages], configDefaults);
 * await coordinator.startAll();
 * ```
 * @param options - Package options including pre-seeded client definitions,
 *   strategy I/O dependencies, and post-install handlers
 * @returns Configured MakaioExtension manifest
 */
export function createClientsCorePackage(options: ClientsCorePackageOptions = {}): MakaioExtension {
  const { definitions = [], strategyDependencies, postInstallHandlers } = options;
  const definitionSnapshot = [...definitions];

  return {
    name: 'makaio.clients-core',
    displayName: 'Clients Core',
    version: '0.1.0',
    critical: true,
    storage: {
      /**
       * Register all persistence handlers (runtime + client binary) on the bus.
       * @param bus - Application bus instance
       * @param db - Drizzle database instance
       * @returns Cleanup function that unregisters all storage handlers
       */
      registerHandlers: registerDrizzleHandlers((bus, db, _ctx) => {
        return registerStorageHandlersWithRollback([
          () => registerDrizzleRuntimeStorage(bus, db, _ctx),
          () => registerDrizzleClientBinaryStorage(bus, db, _ctx),
        ]);
      }),
    },
    /**
     * Create the composite service bound to the runtime bus.
     *
     * The binary manager's base path is resolved to `{makaioHome}/binaries/`
     * from the package context so installations land in the user's Makaio data
     * directory without requiring additional configuration.
     *
     * The manager receives a {@link ClientDefinitionRegistry} pre-seeded with
     * the definitions supplied to {@link createClientsCorePackage}, so
     * `client.list` returns correct results immediately after `init()` without
     * any post-start mutation.
     *
     * When {@link ClientsCorePackageOptions.strategyDependencies} is supplied,
     * it is forwarded to the {@link ClientBinaryManager} so that real I/O
     * operations (downloads, archive extraction, checksums, subprocess execution)
     * are available immediately after `init()`. Without it the manager falls
     * back to a no-op implementation that throws on the first I/O call.
     * @param ctx - Runtime package context
     * @returns Uninitialized composite service
     */
    create: (ctx) => {
      const registry = new ClientDefinitionRegistry(definitionSnapshot);
      const binaryManager = new ClientBinaryManager(
        ctx.bus,
        {
          basePath: path.join(ctx.makaioHome, 'binaries'),
          configBasePath: path.join(ctx.makaioHome, 'clients'),
          postInstallHandlers,
        },
        registry,
        strategyDependencies,
      );
      return new ClientsCoreService(new ClientRuntimeService(ctx.bus), binaryManager);
    },
  };
}
