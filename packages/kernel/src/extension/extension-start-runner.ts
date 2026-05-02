import type { IMakaioBus } from '@makaio/bus-core';
import { ServiceSkipError } from '../service-skip-error.js';
import type { BootProgressObserver } from './boot-progress-observer.js';
import { runContributionProcessors } from './contribution-processor-runner.js';
import {
  buildExtensionContext,
  type ExtensionContextHost,
  resolveExtensionEntryConfig,
} from './extension-context-builder.js';
import { registerPackageTrayMenuEntry } from './tray-menu-entry-bridge.js';
import { transitionPackageEntry } from './state-transition.js';
import type { ContributionProcessor, ExtensionEntry } from './types.js';

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
  if (!entry.enabled) {
    transitionPackageEntry(host.bus, entry, 'skipped');
    host.bootProgress.skipped(entry.pkg, 'disabled');
    return;
  }

  const inactiveDeps = (entry.pkg.dependencies ?? []).filter((dep) => {
    const depEntry = host.entries.get(dep);
    return depEntry?.state !== 'active';
  });
  if (inactiveDeps.length > 0) {
    const message = `Required dependencies not active: ${inactiveDeps.join(', ')}`;
    failEntry(host, name, entry, message);
    if (entry.pkg.critical) throw new Error(`Critical package "${name}" failed: ${message}`);
    return;
  }

  host.bootProgress.starting(entry.pkg);
  transitionPackageEntry(host.bus, entry, 'initializing');
  // Config resolution is non-throwing: loadConfig and schema parse failures
  // are logged and represented as absent config, so startup failure isolation
  // remains owned by storage/create/init below.
  const config = resolveExtensionEntryConfig(host.contextHost, name, entry);

  if (!registerEntryStorage(host, name, entry, config)) return;

  if (!entry.pkg.create) {
    await startEntryWithoutService(host, name, entry);
    return;
  }

  await startEntryWithService(host, name, entry, config);
}

/**
 * Run the no-create path for an entry that declares no service factory.
 * @param host - Coordinator state required for startup.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry to start.
 * @throws Error when a critical extension fails.
 */
async function startEntryWithoutService(host: ExtensionStartHost, name: string, entry: ExtensionEntry): Promise<void> {
  try {
    await runContributionProcessors(host.contributionProcessors, host.contextHost, name, entry, 'activated');
  } catch (err) {
    runStorageCleanup(name, entry);
    if (handleServiceSkipError(host, name, entry, err)) return;
    const message = err instanceof Error ? err.message : String(err);
    failEntry(host, name, entry, message);
    if (entry.pkg.critical) throw err;
    return;
  }
  transitionPackageEntry(host.bus, entry, 'active');
  host.bootProgress.ready(entry.pkg);
  await registerEntryTray(host.bus, name, entry);
}

/**
 * Run the service-factory path for an entry that declares a `create` function.
 * @param host - Coordinator state required for startup.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry to start.
 * @param config - Resolved extension configuration.
 * @throws Error when a critical extension fails.
 */
async function startEntryWithService(
  host: ExtensionStartHost,
  name: string,
  entry: ExtensionEntry,
  config: unknown,
): Promise<void> {
  let service: Awaited<ReturnType<NonNullable<typeof entry.pkg.create>>> | undefined;
  try {
    const pkgCtx = buildExtensionContext(host.contextHost, entry, config);
    service = await entry.pkg.create!(pkgCtx);
    await service.init?.();
    entry.service = service;
    // Contributions must succeed before the extension can become active.
    // On failure the catch block below destroys the service and transitions
    // the entry to failed, exactly the same path as a create/init failure.
    await runContributionProcessors(host.contributionProcessors, host.contextHost, name, entry, 'activated');
    transitionPackageEntry(host.bus, entry, 'active');
    host.bootProgress.ready(entry.pkg);
    await registerEntryTray(host.bus, name, entry);
  } catch (err) {
    try {
      await service?.destroy?.();
    } catch (destroyErr) {
      console.error(`[ExtensionCoordinator] Service cleanup error after failed start of "${name}":`, destroyErr);
    }
    entry.service = undefined;
    runStorageCleanup(name, entry);
    if (handleServiceSkipError(host, name, entry, err)) return;
    const message = err instanceof Error ? err.message : String(err);
    failEntry(host, name, entry, message);
    if (entry.pkg.critical) throw err;
  }
}

/**
 * Apply the shared {@link ServiceSkipError} startup contract.
 * @param host - Coordinator state required for startup.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry being started.
 * @param err - Error raised during startup.
 * @returns `true` when the error was handled as a skip.
 * @throws Error when a critical extension attempts to skip startup.
 */
function handleServiceSkipError(host: ExtensionStartHost, name: string, entry: ExtensionEntry, err: unknown): boolean {
  if (!(err instanceof ServiceSkipError)) return false;

  if (entry.pkg.critical) {
    const message = `Critical package cannot skip startup: ${err.reason}`;
    failEntry(host, name, entry, message);
    throw new Error(`Critical package "${name}" failed: ${message}`, { cause: err });
  }

  entry.error = err.reason;
  console.info(`[ExtensionCoordinator] Package "${name}" skipped: ${err.reason}`);
  transitionPackageEntry(host.bus, entry, 'skipped');
  host.bootProgress.skipped(entry.pkg, err.reason);
  return true;
}

/**
 * Register storage handlers for one extension entry.
 * @param host - Coordinator state required for storage registration.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry whose storage should be registered.
 * @param config - Parsed extension config.
 * @returns `true` when startup should continue.
 * @throws Error when a critical storage registration fails.
 */
function registerEntryStorage(host: ExtensionStartHost, name: string, entry: ExtensionEntry, config: unknown): boolean {
  if (!entry.pkg.storage?.registerHandlers || host.db === undefined) return true;
  try {
    const pkgCtx = buildExtensionContext(host.contextHost, entry, config);
    const cleanup = entry.pkg.storage.registerHandlers(host.bus, host.db, pkgCtx);
    if (cleanup) entry.storageCleanup = cleanup;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ExtensionCoordinator] Package "${name}" storage registration failed:`, err);
    failEntry(host, name, entry, message);
    if (entry.pkg.critical) throw err;
    return false;
  }
}

/**
 * Run the storage cleanup callback for an extension entry (best-effort).
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry whose storage should be cleaned up.
 */
function runStorageCleanup(name: string, entry: ExtensionEntry): void {
  if (!entry.storageCleanup) return;
  try {
    entry.storageCleanup();
  } catch (cleanupErr) {
    console.error(`[ExtensionCoordinator] Storage cleanup error after failed start of "${name}":`, cleanupErr);
  } finally {
    entry.storageCleanup = undefined;
  }
}

/**
 * Mark an extension entry failed and update boot progress.
 * @param host - Coordinator state required for failure recording.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry to fail.
 * @param message - Human-readable failure reason.
 */
function failEntry(host: ExtensionStartHost, name: string, entry: ExtensionEntry, message: string): void {
  entry.error = message;
  console.error(`[ExtensionCoordinator] Package "${name}" failed:`, message);
  transitionPackageEntry(host.bus, entry, 'failed');
  host.bootProgress.failed(entry.pkg, message);
}

/**
 * Bridge one extension's static tray manifest into the tray menu service.
 * @param bus - Bus used to register the tray entry.
 * @param name - Extension name used for log messages.
 * @param entry - Extension entry whose tray manifest should be registered.
 */
async function registerEntryTray(bus: IMakaioBus, name: string, entry: ExtensionEntry): Promise<void> {
  try {
    await registerPackageTrayMenuEntry(bus, entry.pkg);
  } catch (err) {
    console.warn(`[ExtensionCoordinator] Failed to register tray entry for ${name}:`, err);
  }
}
