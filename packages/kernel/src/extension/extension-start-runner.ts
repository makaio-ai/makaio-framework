import type { IMakaioBus } from '@makaio/bus-core';
import { leaseNamespace, NamespaceOwnershipError, type NamespaceLease } from '@makaio/bus-core/kernel-api';
import type { CallContext } from '@makaio/core';
import { getErrorString } from '@makaio/utils';
import { cancellationRejection } from '../cancellation.js';
import { ServiceSkipError } from '../service-skip-error.js';
import type { BootProgressObserver } from './boot-progress-observer.js';
import { runContributionProcessors } from './contribution-processor-runner.js';
import {
  buildExtensionContext,
  checkExtensionNameAddressable,
  type ExtensionContextHost,
  releaseExtensionCarrierSubscriptions,
  reopenExtensionContext,
  resolveExtensionEntryConfig,
} from './extension-context-builder.js';
import { createAndInitService, releaseService } from './extension-shutdown-runner.js';
import { releaseExtensionNamespaces } from './namespace-capability.js';
import { registerPackageTrayMenuEntry } from './tray-menu-entry-bridge.js';
import { transitionPackageEntry } from './state-transition.js';
import type { ContributionProcessor, ExtensionEntry } from './types.js';

const manifestClaims = new WeakMap<ExtensionEntry, NamespaceLease[] | NamespaceOwnershipError>();

/**
 * Claim all manifest namespaces before collecting static surfaces or retrying activation.
 * @param bus - Bus whose namespace registry receives the claims.
 * @param entry - Extension entry making the claims.
 * @returns The ownership conflict that prevented the claims, if any.
 */
export function claimManifestNamespaces(bus: IMakaioBus, entry: ExtensionEntry): NamespaceOwnershipError | undefined {
  const existing = manifestClaims.get(entry);
  if (existing) return existing instanceof NamespaceOwnershipError ? existing : undefined;

  const holder = { kind: 'extension', extension: entry.identity.extensionName } as const;
  const leases: NamespaceLease[] = [];
  try {
    for (const definition of entry.pkg.namespaces ?? []) leases.push(leaseNamespace(bus, definition, holder));
  } catch (error) {
    for (const lease of leases) lease.release();
    if (!(error instanceof NamespaceOwnershipError)) throw error;
    // A load-time conflict skips static surfaces, which cannot be replayed by a live retry.
    if (!entry.surfacesCollected) manifestClaims.set(entry, error);
    return error;
  }
  manifestClaims.set(entry, leases);
  return undefined;
}

/**
 * Release the manifest and runtime claims after carrier teardown.
 * @param entry - Extension entry whose namespaces are released.
 */
export function releaseEntryNamespaces(entry: ExtensionEntry): void {
  const leases = manifestClaims.get(entry);
  if (Array.isArray(leases)) {
    for (const lease of leases) lease.release();
    manifestClaims.delete(entry);
  }
  releaseExtensionNamespaces(entry.identity);
}

/**
 * End carrier subscriptions now, retaining namespace claims for pending service teardown.
 * @param entry - Extension entry whose lifecycle has ended.
 */
export function closeEntryRegistration(entry: ExtensionEntry): void {
  releaseExtensionCarrierSubscriptions(entry.identity);
  if (entry.pendingService === undefined) releaseEntryNamespaces(entry);
}

/** Coordinator state required to start one extension entry. */
export interface ExtensionStartHost {
  /** Bus used for lifecycle events, storage registration, and tray bridging. */
  readonly bus: IMakaioBus;
  /** Optional database instance supplied to extension storage handlers. */
  readonly db: unknown;
  /** Loaded extension entries keyed by extension name. */
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  /** Awaited contribution processors registered with the coordinator. */
  readonly contributionProcessors: readonly ContributionProcessor[];
  /** Context host used to resolve config and build extension contexts. */
  readonly contextHost: ExtensionContextHost;
  /** Boot progress observer updated as the extension settles. */
  readonly bootProgress: BootProgressObserver;
  /**
   * Cancels the start. Handed to a service's `init()`, whose waits can end when
   * it aborts; an entry whose start it interrupted is not counted as a failure
   * of the extension, but ends the whole start with the signal's reason.
   */
  readonly signal?: AbortSignal;
}

/**
 * Start one extension entry and update boot progress.
 * @param host - Coordinator state required for startup.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry to start.
 * @throws Error when a critical extension fails.
 */
export async function startExtensionEntry(
  host: ExtensionStartHost,
  name: string,
  entry: ExtensionEntry,
): Promise<void> {
  // ORIGIN: The coordinator starts an entry as the host.
  const call = host.bus.own('start');
  if (!entry.enabled) {
    closeEntryRegistration(entry);
    transitionPackageEntry(call, host.bus, entry, 'skipped');
    host.bootProgress.skipped(entry.pkg, 'disabled');
    return;
  }

  const claim = entry.surfacesCollected ? claimManifestNamespaces(host.bus, entry) : manifestClaims.get(entry);
  if (claim instanceof NamespaceOwnershipError) {
    failEntry(call, host, name, entry, `${claim.code}: ${claim.message}`);
    if (entry.pkg.critical) throw claim;
    return;
  }

  const inactiveDeps = (entry.pkg.dependencies ?? []).filter((dep) => {
    if (dep.optional) return false;
    const depEntry = host.entries.get(dep.name);
    return depEntry?.state !== 'active';
  });
  if (inactiveDeps.length > 0) {
    const details = inactiveDeps.map(({ name: dependency }) => {
      const error = host.entries.get(dependency)?.error;
      return error ? `${dependency} (${error})` : dependency;
    });
    const message = `Required dependencies not active: ${details.join(', ')}`;
    failEntry(call, host, name, entry, message);
    if (entry.pkg.critical) throw new Error(`Critical package "${name}" failed: ${message}`);
    return;
  }

  // Validate name addressability eagerly, before any lifecycle transition.
  //
  // buildExtensionContext throws for an unencodable name, but it is only called
  // on the create-factory and storage-registration code paths. An extension
  // with no `create`, no `storage`, and no contribution processors would skip
  // all three and reach `active` with an unencodable name. A subsequent
  // forEachActiveExtension or forExtension call would then invoke
  // buildExtensionContext outside per-extension isolation and abort the caller.
  // Checking here ensures the failure is always contained as a per-extension
  // `failed` transition regardless of which lifecycle hooks are declared.
  //
  // `enableExtension` (the internal restart primitive) is the other seam
  // that can move an entry toward `active`; it runs this exact same check via
  // the shared `checkExtensionNameAddressable` predicate so the two paths
  // cannot drift apart.
  const addressabilityError = checkExtensionNameAddressable(entry.identity.extensionName);
  if (addressabilityError !== undefined) {
    failEntry(call, host, name, entry, addressabilityError);
    if (entry.pkg.critical) throw new Error(`Critical package "${name}" failed: ${addressabilityError}`);
    return;
  }

  host.bootProgress.starting(entry.pkg);
  reopenExtensionContext(entry.identity);
  entry.error = undefined;
  transitionPackageEntry(call, host.bus, entry, 'initializing');
  // Config resolution fails only when an operator-supplied layer cannot be
  // honoured; loadConfig and stored-config parse failures stay non-throwing and
  // are represented as absent config. An operator failure is an activation
  // failure and takes the same criticality path as storage/create/init below.
  let config: unknown;
  try {
    config = resolveExtensionEntryConfig(host.contextHost, name, entry, 'activate');
  } catch (err) {
    failEntry(call, host, name, entry, getErrorString(err));
    if (entry.pkg.critical) throw err;
    return;
  }

  if (!registerEntryStorage(call, host, name, entry, config)) return;

  if (!entry.pkg.create) {
    await startEntryWithoutService(call, host, name, entry);
    return;
  }

  await startEntryWithService(call, host, name, entry, config);
}

/**
 * Run the no-create path for an entry that declares no service factory.
 * @param call - Call responsible for starting the extension.
 * @param host - Coordinator state required for startup.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry to start.
 * @throws Error when a critical extension fails.
 */
async function startEntryWithoutService(
  call: CallContext,
  host: ExtensionStartHost,
  name: string,
  entry: ExtensionEntry,
): Promise<void> {
  try {
    await runContributionProcessors(host.contributionProcessors, host.contextHost, name, entry, 'activated');
  } catch (err) {
    runStorageCleanup(name, entry);
    if (handleServiceSkipError(call, host, name, entry, err)) return;
    const message = err instanceof Error ? err.message : String(err);
    failEntry(call, host, name, entry, message);
    if (entry.pkg.critical) throw err;
    return;
  }
  transitionPackageEntry(call, host.bus, entry, 'active');
  host.bootProgress.ready(entry.pkg);
  await registerEntryTray(call, host.bus, name, entry);
}

/**
 * Run the service-factory path for an entry that declares a `create` function.
 * @param call - Call responsible for starting the extension.
 * @param host - Coordinator state required for startup.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry to start.
 * @param config - Resolved extension configuration.
 * @throws Error when a critical extension fails.
 */
async function startEntryWithService(
  call: CallContext,
  host: ExtensionStartHost,
  name: string,
  entry: ExtensionEntry,
  config: unknown,
): Promise<void> {
  try {
    const pkgCtx = buildExtensionContext(host.contextHost, entry, config);
    await createAndInitService(name, entry, pkgCtx, host.signal);
    // Contributions must succeed before the extension can become active.
    // On failure the catch block below destroys the service and transitions
    // the entry to failed, exactly the same path as a create/init failure.
    await runContributionProcessors(host.contributionProcessors, host.contextHost, name, entry, 'activated');
    transitionPackageEntry(call, host.bus, entry, 'active');
    host.bootProgress.ready(entry.pkg);
    await registerEntryTray(call, host.bus, name, entry);
  } catch (err) {
    const cleanupFailures: unknown[] = await releaseService(name, entry, 'start');
    cleanupFailures.push(...runStorageCleanup(name, entry));
    if (handleServiceSkipError(call, host, name, entry, err)) return;
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = host.signal?.aborted === true;
    failEntry(call, host, name, entry, cancelled ? `Start cancelled: ${message}` : message);
    // A start the host cancelled is not the extension's failure, whatever its
    // criticality: it ends the whole start with the reason the host gave, which
    // is what lets the boot treat it as a cancellation. Cleanup that failed on
    // the way is the one thing the cancellation must not hide: this entry is
    // `failed` now, so the coordinator's rollback will not stop its service again.
    if (cancelled) {
      throw cancellationRejection(
        host.signal.reason,
        cleanupFailures,
        `Start of "${name}" cancelled, but releasing what it had started failed`,
      );
    }
    if (entry.pkg.critical) throw err;
  }
}

/**
 * Apply the shared {@link ServiceSkipError} startup contract.
 * @param call - Call responsible for starting the extension.
 * @param host - Coordinator state required for startup.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry being started.
 * @param err - Error raised during startup.
 * @returns `true` when the error was handled as a skip.
 * @throws Error when a critical extension attempts to skip startup.
 */
function handleServiceSkipError(
  call: CallContext,
  host: ExtensionStartHost,
  name: string,
  entry: ExtensionEntry,
  err: unknown,
): boolean {
  if (!(err instanceof ServiceSkipError)) return false;

  if (entry.pkg.critical) {
    const message = `Critical package cannot skip startup: ${err.reason}`;
    failEntry(call, host, name, entry, message);
    throw new Error(`Critical package "${name}" failed: ${message}`, { cause: err });
  }

  closeEntryRegistration(entry);
  entry.error = err.reason;
  console.info(`[ExtensionCoordinator] Package "${name}" skipped: ${err.reason}`);
  transitionPackageEntry(call, host.bus, entry, 'skipped');
  host.bootProgress.skipped(entry.pkg, err.reason);
  return true;
}

/**
 * Register storage handlers for one extension entry.
 * @param call - Call responsible for starting the extension.
 * @param host - Coordinator state required for storage registration.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry whose storage should be registered.
 * @param config - Parsed extension config.
 * @returns `true` when startup should continue.
 * @throws Error when a critical storage registration fails.
 */
function registerEntryStorage(
  call: CallContext,
  host: ExtensionStartHost,
  name: string,
  entry: ExtensionEntry,
  config: unknown,
): boolean {
  if (!entry.pkg.storage?.registerHandlers || host.db === undefined) return true;
  try {
    const pkgCtx = buildExtensionContext(host.contextHost, entry, config);
    const cleanup = entry.pkg.storage.registerHandlers(pkgCtx.bus, host.db, pkgCtx);
    if (cleanup) entry.storageCleanup = cleanup;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ExtensionCoordinator] Package "${name}" storage registration failed:`, err);
    failEntry(call, host, name, entry, message);
    if (entry.pkg.critical) throw err;
    return false;
  }
}

/**
 * Run the storage cleanup callback for an extension entry. A failure is logged
 * and returned, never thrown: the start that is being undone decides what to do
 * with it.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry whose storage should be cleaned up.
 * @returns The failures of the cleanup; empty when it was clean.
 */
function runStorageCleanup(name: string, entry: ExtensionEntry): unknown[] {
  if (!entry.storageCleanup) return [];
  try {
    entry.storageCleanup();
    return [];
  } catch (cleanupErr) {
    console.error(`[ExtensionCoordinator] Storage cleanup error after failed start of "${name}":`, cleanupErr);
    return [cleanupErr];
  } finally {
    entry.storageCleanup = undefined;
  }
}

/**
 * Mark an extension entry failed and update boot progress.
 * A service retained for shutdown keeps its namespaces until teardown.
 * @param call - Call responsible for starting the extension.
 * @param host - Coordinator state required for failure recording.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry to fail.
 * @param message - Human-readable failure reason.
 */
function failEntry(
  call: CallContext,
  host: ExtensionStartHost,
  name: string,
  entry: ExtensionEntry,
  message: string,
): void {
  closeEntryRegistration(entry);
  entry.error = message;
  console.error(`[ExtensionCoordinator] Package "${name}" failed:`, message);
  transitionPackageEntry(call, host.bus, entry, 'failed');
  host.bootProgress.failed(entry.pkg, message);
}

/**
 * Bridge one extension's static tray manifest into the tray menu service.
 * @param call - Call responsible for starting the extension.
 * @param bus - Bus used to register the tray entry.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry whose tray manifest should be registered.
 */
async function registerEntryTray(
  call: CallContext,
  bus: IMakaioBus,
  name: string,
  entry: ExtensionEntry,
): Promise<void> {
  try {
    await registerPackageTrayMenuEntry(call, bus, entry.pkg);
  } catch (err) {
    console.warn(`[ExtensionCoordinator] Failed to register tray entry for ${name}:`, err);
  }
}
