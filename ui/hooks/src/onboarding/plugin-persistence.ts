/**
 * Extension config persistence helper for onboarding.
 *
 * Provides the `persistPluginEnabled` bus helper and the
 * `PersistedExtensionConfigEntry` cache record type. Separated from
 * `\@makaio/ui-kernel/onboarding/plugin-categories` because it depends on the
 * extension-config storage namespace in `\@makaio/services-core` — kernel must
 * remain bus-free.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ExtensionConfigStorageSubjects } from '@makaio/services-core/settings/storage/extension-configs/namespace';

export interface PersistPluginEnabledResult {
  id: string;
}

/**
 * Persisted extension config entry cached in a ref to preserve config blobs
 * across enabled-state toggles without driving re-renders.
 */
export interface PersistedExtensionConfigEntry {
  /** Stable storage row identifier */
  id: string;
  /** Existing extension config payload that must be preserved across enabled toggles */
  config: Record<string, unknown> | undefined;
}

/**
 * Persist only the enabled state for a plugin config row.
 *
 * This uses the storage layer's atomic `setEnabled` RPC instead of
 * reconstructing a partial `set` payload client-side. Cached config blobs stay
 * available in-memory for future full writes, but enabled toggles no longer
 * need to round-trip or risk clearing them.
 * @param pluginName - Registry name of the plugin
 * @param enabled - Desired enabled state
 * @param cache - Ref map of persisted config entries
 * @param bus - Bus instance used to dispatch the set request
 * @returns Persisted row identifier for the extension config record
 */
export function persistPluginEnabled(
  pluginName: string,
  enabled: boolean,
  cache: Map<string, PersistedExtensionConfigEntry>,
  bus: IMakaioBus,
): Promise<PersistPluginEnabledResult> {
  const existing = cache.get(pluginName);
  const entry: PersistedExtensionConfigEntry = existing ?? {
    id: `onboarding-${pluginName}`,
    config: undefined,
  };
  cache.set(pluginName, entry);

  return bus
    .request(ExtensionConfigStorageSubjects.setEnabled, {
      extensionName: pluginName,
      scope: 'default',
      enabled,
    })
    .then((result) => {
      cache.set(pluginName, { ...entry, id: result.id });
      return result;
    });
}
