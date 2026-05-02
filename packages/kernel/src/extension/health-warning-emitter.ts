import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionWarningAction } from '@makaio/contracts/extension';
import { getExtensionWarningActionLabel } from '@makaio/contracts/extension';
import { ToastSubjects } from '@makaio/contracts/toast';
import { buildActionMapKey, WARNING_ACTION_ID } from './warning-action-dispatcher.js';
import type { ExtensionEntry } from './types.js';

/**
 * Minimal coordinator surface consumed by the health-warning emitter.
 *
 * Keeps the extraction loosely coupled — the coordinator satisfies this
 * interface without exposing its full internal API.
 */
export interface EmitterHost {
  readonly bus: IMakaioBus;
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  readonly warningActionMap: Map<string, ExtensionWarningAction>;
}

/**
 * Emit console warnings and toast notifications for all active entries that
 * carry degraded warnings.
 *
 * Called once at the end of `startAll` after all health checks have completed.
 * Only `degraded` severity triggers proactive notification; `info` and
 * `recommended` warnings are queryable via `warnings.list` only.
 * @param host - Coordinator surface providing the entries map and bus.
 */
export async function emitWarnings(host: EmitterHost): Promise<void> {
  for (const [name, entry] of host.entries) {
    if (entry.state !== 'active') continue;
    await emitWarningsForEntry(host, name, entry);
  }
}

/**
 * Build serializable toast action descriptors for runtime-routable warning
 * actions. The caller registers the action in
 * {@link EmitterHost.warningActionMap} only after the toast emit succeeds.
 * @param action - Optional warning action to convert. Returns `undefined` when absent.
 * @returns Toast action array for `toast.show`, or `undefined` when there is no action.
 */
function buildToastActions(action: ExtensionWarningAction | undefined): [{ id: string; label: string }] | undefined {
  if (!action) return undefined;
  if (!isRuntimeRoutableWarningAction(action)) return undefined;
  return [{ id: WARNING_ACTION_ID, label: getExtensionWarningActionLabel(action) }];
}

/**
 * Determine whether the runtime toast dispatcher can execute a warning action.
 *
 * Other action kinds are valid contract values for UI surfaces that implement
 * those capabilities, but the runtime warning dispatcher only routes client
 * wiring requests. Unsupported kinds are omitted from emitted toasts so users
 * do not see buttons that only log and no-op.
 * @param action - Warning action declared by an extension.
 * @returns True when the runtime dispatcher can route the action.
 */
function isRuntimeRoutableWarningAction(action: ExtensionWarningAction): boolean {
  return action.kind === 'configure-integration';
}

/**
 * Remove previously registered warning actions for a package before recording
 * the package's current warning set.
 *
 * Warning toast IDs are scoped as `${packageName}:${title}:${index}`. Pruning
 * by the package prefix keeps removed, renamed, or reordered warnings from
 * leaving clickable stale actions behind.
 * @param actionMap - Warning action lookup map owned by the coordinator.
 * @param packageName - Package whose warning actions are being refreshed.
 */
function pruneWarningActionsForEntry(actionMap: Map<string, ExtensionWarningAction>, packageName: string): void {
  const entryPrefix = `${packageName}:`;
  for (const key of actionMap.keys()) {
    if (key.startsWith(entryPrefix)) {
      actionMap.delete(key);
    }
  }
}

/**
 * Emit console warnings and toast notifications for the warnings of a single
 * package entry.
 *
 * Extracted so the enable-package flow can call it for a single newly enabled
 * package without iterating all entries.
 *
 * Only `degraded` severity warnings are emitted. Toast emission failures are
 * swallowed so headless mode (where toast infrastructure is absent) does not
 * crash.
 * @param host - Coordinator surface providing the bus and warning action map.
 * @param name - Package name used for log prefixes and toast IDs.
 * @param entry - Package entry whose warnings should be emitted.
 */
export async function emitWarningsForEntry(host: EmitterHost, name: string, entry: ExtensionEntry): Promise<void> {
  pruneWarningActionsForEntry(host.warningActionMap, name);

  const degraded = entry.warnings.filter((w) => w.severity === 'degraded');
  if (degraded.length === 0) return;

  for (let i = 0; i < degraded.length; i++) {
    const warning = degraded[i]!;
    console.warn(`[${name}] ⚠ ${warning.title}: ${warning.message}`);

    const toastId = `${name}:${warning.title}:${i}`;
    const actions = buildToastActions(warning.action);

    try {
      await host.bus.emit(ToastSubjects.show, {
        level: 'warning',
        title: warning.title,
        message: `${entry.pkg.displayName}: ${warning.message}`,
        toastId,
        durationMs: null,
        ...(actions && { actions }),
      });
      if (warning.action && isRuntimeRoutableWarningAction(warning.action)) {
        host.warningActionMap.set(buildActionMapKey(toastId, WARNING_ACTION_ID), warning.action);
      }
    } catch (err) {
      // Non-fatal: toast infrastructure may not be present in headless mode.
      console.warn(`[${name}] toast emission failed for warning "${warning.title}":`, err);
    }
  }
}
