/**
 * Extension enablement persistence helper for onboarding.
 *
 * Provides the `persistPluginEnabled` bus helper and the
 * `PersistPluginEnabledResult` type. Separated from
 * `\@makaio/ui-kernel/onboarding/plugin-categories` because it depends on the
 * kernel extension namespace — kernel must remain bus-free.
 *
 * **Breaking change (2026-09-18):** Enablement writes now go through
 * `ExtensionSubjects.setEnabled` (kernel RPC) instead of the product storage
 * namespace. `PersistPluginEnabledResult` now carries `success` instead of a
 * storage row `id`.
 *
 * `ExtensionSubjects.setEnabled` is persist-only: it durably records the
 * preference in the enablement file via the coordinator's
 * `persistEnabled` callback, but never applies the change to the running
 * process. `PersistPluginEnabledResult` carries `outcome` (the same
 * `TransitionOutcome` the CLI reads from this RPC) so a caller can tell
 * `'applied'` (the process's current runtime state already matches the
 * request) apart from `'restart-required'` (persisted, but only a process
 * restart applies it) or `'rejected'` (nothing was persisted) instead of
 * guessing from `success` alone. This module's own callers currently only
 * branch on `outcome === 'rejected'`, to decide whether to revert an
 * optimistic UI update.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ExtensionSubjects, type TransitionOutcome } from '@makaio/kernel';

export interface PersistPluginEnabledResult {
  /** Whether the kernel accepted the enablement change. */
  success: boolean;
  /** The transition outcome the kernel actually reached. */
  outcome: TransitionOutcome;
}

/**
 * Persist only the enabled state for a plugin via the kernel RPC.
 *
 * Fires `kernel:extension.setEnabled`, which durably writes the preference to
 * the enablement file via the coordinator's `persistEnabled`
 * callback. This never applies the change to the running process — see the
 * module doc for why. Enabled state is the single source of truth in the
 * kernel; no local cache is mutated.
 * @param pluginName - Registry name of the plugin.
 * @param enabled - Desired enabled state.
 * @param bus - Bus instance used to dispatch the set request.
 * @returns Result from the kernel enablement RPC.
 */
export function persistPluginEnabled(
  pluginName: string,
  enabled: boolean,
  bus: IMakaioBus,
): Promise<PersistPluginEnabledResult> {
  return bus.request(ExtensionSubjects.setEnabled, { name: pluginName, enabled });
}
