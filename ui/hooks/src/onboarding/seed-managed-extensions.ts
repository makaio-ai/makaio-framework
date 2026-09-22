/**
 * Extension-managed filtering and durable-disable seeding for onboarding.
 *
 * Onboarding only ever lists and toggles extension-managed packages: a
 * framework package (`extensionManaged: false`) boots unconditionally
 * enabled and `kernel:extension.setEnabled` refuses to toggle it outright, so
 * showing it here would offer a control onboarding can never persist.
 * @packageDocumentation
 */

import type { ExtensionInfo } from '@makaio/kernel';

/**
 * Extension-managed subset of a raw snapshot, plus the durable-disable seed
 * derived from it.
 */
export interface SeededManagedExtensions {
  /** Extension-managed entries only — a framework package never appears here. */
  managed: ExtensionInfo[];
  /** Seed for `pluginEnabledStates`: durable disables only, keyed by name. */
  initialDisables: Map<string, boolean>;
}

/**
 * Narrow a raw `ExtensionSubjects.list` snapshot to the extension-managed
 * subset and seed the durable-disable map that overrides category defaults
 * on completion.
 *
 * The seed reads only `persistedEnabled` — never `enabled`, this process's
 * runtime state, which `setEnabled` (persist-only) can leave lagging a
 * CLI-disable of a still-active extension. Seeding from `enabled` would treat
 * that extension as untouched and let the category-default write silently
 * re-enable it. Seeding only disables, not enables, keeps the category-default
 * derivation authoritative for every extension with no durable disable, even
 * one defaulting to OFF.
 *
 * `critical` extensions are excluded even when a hand-edited disable is on
 * record: boot already overrides that preference back to enabled for them
 * (the kernel force-starts a critical extension and refuses to persist a
 * disable for it), so seeding it here would show a locked-off toggle that
 * contradicts the running system and, on completion, re-attempt the same
 * disable boot already refused.
 * @param extensions - Raw extension snapshot from `ExtensionSubjects.list`.
 * @returns The extension-managed subset and its seeded durable-disable map.
 */
export function seedManagedExtensions(extensions: ReadonlyArray<ExtensionInfo>): SeededManagedExtensions {
  const managed = extensions.filter((ext) => ext.extensionManaged);
  const initialDisables = new Map<string, boolean>();
  for (const ext of managed) {
    if (ext.persistedEnabled === false && !ext.critical) {
      initialDisables.set(ext.name, false);
    }
  }
  return { managed, initialDisables };
}
