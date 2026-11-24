import type { CallContext } from '@makaio/core';
import { boundedWait, isNonNegativeFinite, nonNegativeOption, outerBoundMs } from '@makaio/utils';
import { runContributionProcessors } from './contribution-processor-runner.js';
import { releaseExtensionCarrierSubscriptions, type ExtensionContextHost } from './extension-context-builder.js';
import { transitionPackageEntry } from './state-transition.js';
import type { ExtensionService } from '@makaio/contracts';
import type { ContributionProcessor, ExtensionEntry } from './types.js';

/**
 * Stop window of an extension that declares none, for a host that supplies no
 * default of its own: one bounded stop of one child process (kill grace, exit
 * observation and output drain of the subprocess package's defaults). A host
 * that owns processes passes the value its subprocess stop timing derives
 * ({@link ExtensionShutdownHost.defaultStopBudgetMs}) instead of relying on this.
 */
export const DEFAULT_EXTENSION_STOP_BUDGET_MS = 12_000;

/** Coordinator state required to shut down active extensions. */
export interface ExtensionShutdownHost {
  /** Loaded extension entries keyed by extension name. */
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  /** Dependency-sorted extension names from boot-time load. */
  readonly loadOrder: readonly string[];
  /** Awaited contribution processors registered with the coordinator. */
  readonly contributionProcessors: readonly ContributionProcessor[];
  /** Context host used by contribution processors during deactivation. */
  readonly contextHost: ExtensionContextHost;
  /**
   * Stop window of an extension whose service declares none
   * (see {@link ExtensionServiceLifecycle.stopBudgetMs}), in milliseconds.
   */
  readonly defaultStopBudgetMs: number;
}

/**
 * Accept a freshly created service and own it from this moment on.
 *
 * The service is recorded as the entry's {@link ExtensionEntry.pendingService}
 * first, so that whatever happens next (the declared stop window is refused, the
 * `init` is cancelled, the `init` fails) the entry still owns it and it is
 * destroyed by the path that created it, or else by the shutdown. The stop window
 * it declares counts towards the stop budget from then on.
 *
 * A window that is negative, infinite or `NaN` would corrupt every sum and
 * timer that is built from it, so it is refused where the service enters the
 * coordinator, as a failed start of that extension, instead of surfacing while
 * a shutdown is already running.
 * @param name - Extension name used in the error.
 * @param entry - Extension entry the service was created for.
 * @param service - The service `create` returned.
 * @throws RangeError when the declared window is not a non-negative finite number.
 */
export function adoptCreatedService(name: string, entry: ExtensionEntry, service: ExtensionService): void {
  entry.pendingService = service;
  nonNegativeOption(`Extension "${name}" stopBudgetMs`, service.stopBudgetMs, 0);
}

/**
 * The stop window a service declares, when it is one the coordinator accepts.
 *
 * A service whose window was refused ({@link adoptCreatedService}) stays owned by
 * its entry, so the shutdown still destroys it, and its declaration is still
 * readable there. Every read of the window goes through here, so a refused value
 * never reaches a sum or a timer: the service is stopped within the default instead.
 * @param service - The service, if the entry holds one.
 * @returns The declared window, or `undefined` when none was declared or it was refused.
 */
function acceptedStopBudgetMs(service: ExtensionService | undefined): number | undefined {
  const declared = service?.stopBudgetMs;
  return declared !== undefined && isNonNegativeFinite(declared) ? declared : undefined;
}

/**
 * Create the service of an entry and initialise it: the one place every path
 * that brings a service up (startup, re-enable) does it, so none of them can
 * forget what the others do.
 *
 * The service is owned by the entry from the moment `create` returns
 * ({@link adoptCreatedService}). `init` receives `signal`, the cancellation that
 * applies to the path at that moment (the boot signal during startup, the
 * coordinator's shutdown signal afterwards), because a service's waits can only
 * end when that signal aborts. On success the service moves to
 * {@link ExtensionEntry.service}; on failure it stays pending, and the caller
 * hands it to {@link releaseService}.
 * @param name - Extension name used in errors.
 * @param entry - Extension entry whose `create` factory is run.
 * @param pkgCtx - Context handed to `create`.
 * @param signal - Cancellation handed to `init`.
 * @throws Whatever `create` or `init` rejects with, or a RangeError for a refused stop window.
 */
export async function createAndInitService(
  name: string,
  entry: ExtensionEntry,
  pkgCtx: Parameters<NonNullable<ExtensionEntry['pkg']['create']>>[0],
  signal: AbortSignal | undefined,
): Promise<void> {
  const service = await entry.pkg.create!(pkgCtx);
  adoptCreatedService(name, entry, service);
  await service.init?.({ signal });
  entry.service = service;
  entry.pendingService = undefined;
}

/**
 * Destroy the service an entry owns after a start or enable that did not
 * complete. The entry keeps owning it until it is destroyed successfully: a
 * `destroy` that fails leaves it as {@link ExtensionEntry.pendingService}, where
 * the shutdown destroys it again and reports the failure, instead of dropping the
 * only reference to something that may still be running.
 * @param name - Extension name used in log messages.
 * @param entry - Extension entry whose service is released.
 * @param what - Which path is being undone, for log messages.
 * @returns The failures of the release; empty when it was clean.
 */
export async function releaseService(
  name: string,
  entry: ExtensionEntry,
  what: 'start' | 'enable',
): Promise<unknown[]> {
  const service = entry.service ?? entry.pendingService;
  entry.service = undefined;
  if (service === undefined) return [];
  try {
    await service.destroy?.();
    entry.pendingService = undefined;
    return [];
  } catch (destroyErr) {
    console.error(`[ExtensionCoordinator] Service cleanup error after failed ${what} of "${name}":`, destroyErr);
    entry.pendingService = service;
    return [destroyErr];
  }
}

/**
 * Validate the stop window a host supplies for extensions that declare none.
 * @param defaultStopBudgetMs - The host's default, or `undefined` for the documented one.
 * @returns The window to use, in milliseconds.
 * @throws RangeError when the value is not a non-negative finite number.
 */
export function resolveDefaultStopBudgetMs(defaultStopBudgetMs: number | undefined): number {
  return nonNegativeOption('defaultStopBudgetMs', defaultStopBudgetMs, DEFAULT_EXTENSION_STOP_BUDGET_MS);
}

/**
 * The stop window of one extension: what its service declares, else the host's
 * default. A service that is still initialising counts as well, since a start
 * that is cancelled destroys it.
 * @param entry - Extension entry about to be stopped.
 * @param defaultStopBudgetMs - Window of an extension whose service declares none.
 * @returns The window, in milliseconds.
 */
function extensionStopBudgetMs(entry: ExtensionEntry, defaultStopBudgetMs: number): number {
  return acceptedStopBudgetMs(entry.service ?? entry.pendingService) ?? defaultStopBudgetMs;
}

/**
 * The window the coordinator holds the stop of one extension to: what the
 * extension declares for its own stop code plus the headroom of an outer bound.
 * The extension's stop usually bounds itself (a detached extension declares
 * the sum of its own limits), and the coordinator's timer is armed before that
 * work arms its own, so the declared window alone would close first.
 * @param entry - Extension entry about to be stopped.
 * @param defaultStopBudgetMs - Window of an extension whose service declares none.
 * @returns The window, in milliseconds.
 */
function extensionStopBoundMs(entry: ExtensionEntry, defaultStopBudgetMs: number): number {
  return outerBoundMs(extensionStopBudgetMs(entry, defaultStopBudgetMs));
}

/**
 * Longest time {@link shutdownExtensions} takes for the extensions as they are
 * now: the windows of every extension that still has something to stop, added
 * up, since they are stopped one after the other. An extension that never
 * started, failed or was skipped holds nothing and adds nothing.
 * @param host - Coordinator state to shut down.
 * @returns The bound, in milliseconds.
 */
export function totalExtensionStopBudgetMs(host: ExtensionShutdownHost): number {
  let total = 0;
  for (const entry of host.entries.values()) {
    const holdsSomething =
      entry.state === 'active' ||
      entry.service !== undefined ||
      entry.pendingService !== undefined ||
      entry.storageCleanup !== undefined;
    if (holdsSomething) total += extensionStopBoundMs(entry, host.defaultStopBudgetMs);
  }
  return total;
}

/**
 * Stop one extension: its contributions, then its service, then its storage
 * handlers.
 * @param host - Coordinator state required to shut down extensions.
 * @param name - Extension name.
 * @param entry - Extension entry to stop.
 * @returns The failures of the stop; empty when it was clean. Never rejects.
 */
async function stopEntry(host: ExtensionShutdownHost, name: string, entry: ExtensionEntry): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (entry.state === 'active') {
    failures.push(
      ...(await runContributionProcessors(host.contributionProcessors, host.contextHost, name, entry, 'stopped')),
    );
  }

  // A service a failed start or enable could not destroy is still owned here
  // as `pendingService`: it is destroyed again, and its failure reported.
  for (const service of new Set([entry.service, entry.pendingService])) {
    if (service === undefined) continue;
    try {
      await service.destroy?.();
    } catch (err) {
      failures.push(err);
    }
  }
  entry.service = undefined;
  entry.pendingService = undefined;

  if (entry.storageCleanup) {
    try {
      entry.storageCleanup();
    } catch (err) {
      failures.push(err);
    } finally {
      entry.storageCleanup = undefined;
    }
  }
  return failures;
}

/**
 * Publish an extension whose stop has settled as stopped.
 * @param call - Call of the shutdown lifecycle step.
 * @param host - Coordinator state required to shut down extensions.
 * @param entry - Extension entry whose stop settled.
 */
function publishStopped(call: CallContext, host: ExtensionShutdownHost, entry: ExtensionEntry): void {
  if (entry.state === 'active') {
    transitionPackageEntry(call, host.contextHost.bus, entry, 'stopped');
  }
}

/**
 * Shut down active extensions in reverse dependency order.
 *
 * Contribution processors are stopped before services and storage handlers are
 * destroyed so extension-owned services remain available while contributions
 * unregister. Services are then destroyed before storage handlers are removed,
 * allowing destroy hooks to flush through registered storage seams.
 *
 * Every extension is stopped within a window of its own: the one its service
 * declares ({@link ExtensionServiceLifecycle.stopBudgetMs}), else the host's
 * default. An extension that does not finish inside its window is logged,
 * recorded as not stopped under its name, and left behind: the next extension
 * is stopped regardless, so one stuck extension cannot consume the time of the
 * others. The stop it was running is not cancelled. Its carrier closes when
 * the window ends, and its namespace claims follow the host release schedule.
 * Such an extension keeps its state (`active`) rather than
 * being published as `stopped`: it becomes `stopped` when its stop does settle.
 *
 * A teardown failure never stops the run: every remaining extension is still
 * shut down. It is also never swallowed. All failures are reported together
 * once the last extension has been handled, so the host that owns process
 * termination learns that the drain was incomplete instead of being told it
 * finished.
 * @param host - Coordinator state required to shut down extensions.
 * @throws An AggregateError when any contribution stop, service destroy, or storage cleanup failed, or an extension did not finish stopping inside its window.
 */
export async function shutdownExtensions(host: ExtensionShutdownHost): Promise<void> {
  const call = host.contextHost.bus.own('stop');
  const reversed = [...host.loadOrder].reverse();
  const failures: unknown[] = [];
  const unclean: string[] = [];

  for (const name of reversed) {
    const entry = host.entries.get(name);
    if (!entry) continue;

    const windowMs = extensionStopBoundMs(entry, host.defaultStopBudgetMs);
    const stopping = stopEntry(host, name, entry);
    const outcome = await boundedWait(stopping, windowMs);
    releaseExtensionCarrierSubscriptions(entry.identity);
    if (!outcome.settled) {
      const message = `Extension "${name}" did not finish stopping within ${windowMs} ms; continuing with the next one`;
      console.error(`[ExtensionCoordinator] ${message}`);
      failures.push(new Error(message));
      unclean.push(`${name} (not stopped within ${windowMs} ms)`);
      // Not stopped yet, so not published as stopped: it keeps its state until its stop settles.
      void stopping.then(() => publishStopped(call, host, entry));
      continue;
    }
    if (outcome.value.length > 0) {
      failures.push(...outcome.value);
      unclean.push(name);
    }
    publishStopped(call, host, entry);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Extensions failed to shut down cleanly: ${unclean.join(', ')}`);
  }
}
