import { ExtensionSubjects } from '../observability/extension-namespace.js';
import { ServiceSkipError } from '../service-skip-error.js';
import {
  buildExtensionContext,
  type ExtensionContextHost,
  resolveExtensionEntryConfig,
} from './extension-context-builder.js';
import { transitionPackageEntry } from './state-transition.js';
import { runContributionProcessors } from './contribution-processor-runner.js';
import type { ContributionProcessor, ExtensionEntry } from './types.js';

/**
 * Minimal coordinator surface consumed by the toggle helpers.
 *
 * Keeps the extraction loosely coupled — the coordinator satisfies this
 * interface without exposing its full internal API.
 */
export interface ToggleHost extends ExtensionContextHost {
  readonly db: unknown;
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  readonly persistEnabled: ((name: string, enabled: boolean) => Promise<void>) | undefined;
  /**
   * Registered {@link ContributionProcessor} instances.
   *
   * Passed through from the coordinator so the toggle helpers can invoke
   * processors after a successful enable (activated) or before a disable
   * (stopped) without coupling to coordinator internals.
   */
  readonly contributionProcessors: ReadonlyArray<ContributionProcessor>;
  /**
   * Run the health-check hook for the named extension and store the result.
   *
   * Called after an extension transitions to `active` state during `enableExtension`.
   * The coordinator owns the implementation.
   * @param name - Extension name to run the health check for.
   */
  runHealthCheck(name: string): Promise<void>;
  /**
   * Emit console warnings and toast notifications for a single extension entry's
   * active warnings.
   *
   * Called after `runHealthCheck` completes in the enable flow so the newly
   * enabled extension's degraded warnings are surfaced immediately.
   * @param name - Extension name used for log prefixes and toast IDs.
   * @param entry - Extension entry whose warnings should be emitted.
   */
  emitWarningsForEntry(name: string, entry: ExtensionEntry): Promise<void>;
}

/**
 * Handle the `kernel:extension.setEnabled` RPC by enabling or disabling an extension.
 *
 * Delegates to {@link enableExtension} or {@link disableExtension} based on the
 * requested state, then persists the new value and emits the bus event.
 * @param host - Coordinator surface providing shared state.
 * @param name - Name of the extension to toggle.
 * @param enabled - `true` to enable, `false` to disable.
 * @returns `true` on success, `false` when the state machine rejects the transition.
 */
export async function handleSetEnabled(host: ToggleHost, name: string, enabled: boolean): Promise<boolean> {
  const entry = host.entries.get(name);
  if (!entry) return false;

  const success = enabled ? await enableExtension(host, name, entry) : await disableExtension(host, name, entry);
  const stateMatchesRequest = entry.enabled === enabled;
  if (!success && !stateMatchesRequest) return false;

  await host.persistEnabled?.(name, enabled);

  if (!success) return false;

  void host.bus.emit(ExtensionSubjects.enabledChanged, { name, enabled }).catch((err: unknown) => {
    console.error(`[ExtensionCoordinator] enabledChanged emit failed for "${name}":`, err);
  });

  return true;
}

/**
 * Re-initialize an extension from `stopped`, `failed`, or `skipped` state.
 *
 * Verifies dependencies are active, re-registers storage handlers, and runs
 * the `create` + `init` lifecycle.
 * @param host - Coordinator surface providing shared state.
 * @param name - Extension name (used for log messages).
 * @param entry - Mutable runtime entry for the extension.
 * @returns `true` when the extension reaches `active`, `false` otherwise.
 */
async function enableExtension(host: ToggleHost, name: string, entry: ExtensionEntry): Promise<boolean> {
  if (entry.state !== 'stopped' && entry.state !== 'failed' && entry.state !== 'skipped') return false;

  const { pkg } = entry;
  let storageCleanup: (() => void) | undefined;
  const inactiveDeps = (pkg.dependencies ?? []).filter((dep) => {
    if (dep.optional) return false;
    const depEntry = host.entries.get(dep.name);
    return !depEntry || depEntry.state !== 'active';
  });
  if (inactiveDeps.length > 0) {
    entry.error = `Required dependencies not active: ${inactiveDeps.map((d) => d.name).join(', ')}`;
    console.error(`[ExtensionCoordinator] Cannot re-enable "${name}":`, entry.error);
    transitionPackageEntry(host.bus, entry, 'failed');
    return false;
  }

  entry.enabled = true;
  entry.error = undefined;
  transitionPackageEntry(host.bus, entry, 'initializing');

  // Config resolution is non-throwing: loadConfig and schema parse
  // failures are logged and represented as absent config, so enable
  // failure state is reserved for storage/create/init errors below.
  const config = resolveExtensionEntryConfig(host, name, entry);

  if (pkg.storage?.registerHandlers && host.db !== undefined) {
    try {
      const pkgCtx = buildExtensionContext(host, entry, config);
      const cleanup = pkg.storage.registerHandlers(host.bus, host.db, pkgCtx);
      if (typeof cleanup === 'function') {
        storageCleanup = cleanup;
        entry.storageCleanup = cleanup;
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      console.error(`[ExtensionCoordinator] Extension "${name}" storage re-registration failed:`, err);
      transitionPackageEntry(host.bus, entry, 'failed');
      return false;
    }
  }

  if (pkg.create) {
    let service: Awaited<ReturnType<NonNullable<typeof pkg.create>>> | undefined;
    try {
      const pkgCtx = buildExtensionContext(host, entry, config);
      service = await pkg.create(pkgCtx);
      await service.init?.();
      entry.service = service;
    } catch (err) {
      await cleanupFailedEnable(name, service, storageCleanup, entry);
      if (err instanceof ServiceSkipError) {
        if (entry.pkg.critical) {
          entry.error = `Critical extension cannot skip startup: ${err.reason}`;
          console.error(`[ExtensionCoordinator] Extension "${name}" failed to re-initialize:`, entry.error);
          transitionPackageEntry(host.bus, entry, 'failed');
          return false;
        }
        entry.error = err.reason;
        transitionPackageEntry(host.bus, entry, 'skipped');
        return false;
      }
      entry.error = err instanceof Error ? err.message : String(err);
      console.error(`[ExtensionCoordinator] Extension "${name}" failed to re-initialize:`, err);
      transitionPackageEntry(host.bus, entry, 'failed');
      return false;
    }
  }

  // Run contribution processors BEFORE transitioning to active so a hard
  // failure never leaves the extension in the `active` state.
  try {
    await runContributionProcessors(host.contributionProcessors, host, name, entry, 'activated');
  } catch (err) {
    // Q2: Contribution activation is part of extension activation.
    // Hard failures transition the extension to `failed`. The runner already
    // rolled back previously-invoked processors before re-throwing.
    await cleanupFailedEnable(name, entry.service, storageCleanup, entry);
    entry.service = undefined;
    entry.error = err instanceof Error ? err.message : String(err);
    console.error(`[ExtensionCoordinator] Extension "${name}" contribution processing failed:`, err);
    transitionPackageEntry(host.bus, entry, 'failed');
    return false;
  }

  transitionPackageEntry(host.bus, entry, 'active');

  await host.runHealthCheck(name);
  await host.emitWarningsForEntry(name, entry);
  return true;
}

/**
 * Tear down an active extension.
 *
 * Stops contribution processors, destroys the service, unregisters storage
 * handlers, and transitions to `stopped`.
 * @param host - Coordinator surface providing shared state.
 * @param name - Extension name (used for log messages).
 * @param entry - Mutable runtime entry for the extension.
 * @returns `true` when the extension reaches `stopped`, `false` otherwise.
 */
async function disableExtension(host: ToggleHost, name: string, entry: ExtensionEntry): Promise<boolean> {
  if (entry.state !== 'active') return false;

  const activeDependents = Array.from(host.entries.entries())
    .filter(([dependentName, dependentEntry]) => {
      if (dependentName === name) return false;
      if (dependentEntry.state !== 'active') return false;
      return dependentEntry.pkg.dependencies?.some((dep) => !dep.optional && dep.name === name) ?? false;
    })
    .map(([dependentName]) => dependentName);

  if (activeDependents.length > 0) {
    entry.error = `Cannot disable "${name}" while active dependents remain: ${activeDependents.join(', ')}`;
    console.error(`[ExtensionCoordinator] ${entry.error}`);
    return false;
  }

  entry.enabled = false;
  entry.error = undefined;

  await runContributionProcessors(host.contributionProcessors, host, name, entry, 'stopped');

  if (entry.service) {
    try {
      await entry.service.destroy?.();
    } catch (err) {
      console.error(`[ExtensionCoordinator] Error during disable destroy of "${name}":`, err);
    } finally {
      entry.service = undefined;
    }
  }

  if (entry.storageCleanup) {
    try {
      entry.storageCleanup();
    } catch (err) {
      console.error(`[ExtensionCoordinator] Storage cleanup error during disable of "${name}":`, err);
    } finally {
      entry.storageCleanup = undefined;
    }
  }

  transitionPackageEntry(host.bus, entry, 'stopped');

  entry.warnings = [];

  // Awaited so a rapid disable→enable cycle cannot reorder this empty
  // snapshot after the re-enable health check's fresh warnings.
  try {
    await host.bus.emit(ExtensionSubjects.warnings.changed, { extensionName: name, warnings: [] });
  } catch (err) {
    console.error(`[ExtensionCoordinator] warnings.changed emit failed for "${name}":`, err);
  }

  return true;
}

/**
 * Destroy a partially created service and clean up storage after a failed enable.
 * @param name - Extension name for log messages.
 * @param service - Service instance returned by `pkg.create`, if any.
 * @param storageCleanup - Storage cleanup callback, if any.
 * @param entry - Extension entry whose storageCleanup field is cleared.
 */
async function cleanupFailedEnable(
  name: string,
  service: { destroy?(): Promise<void> | void } | undefined,
  storageCleanup: (() => void) | undefined,
  entry: ExtensionEntry,
): Promise<void> {
  try {
    await service?.destroy?.();
  } catch (destroyErr) {
    console.error(`[ExtensionCoordinator] Service cleanup error after failed enable of "${name}":`, destroyErr);
  }
  try {
    storageCleanup?.();
  } catch (cleanupErr) {
    console.error(`[ExtensionCoordinator] Storage cleanup error after failed enable of "${name}":`, cleanupErr);
  } finally {
    entry.storageCleanup = undefined;
  }
}
