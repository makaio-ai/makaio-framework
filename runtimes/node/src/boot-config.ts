import type { IMakaioBus } from '@makaio/bus-core';
import { ConfigSchema, ConfigSubjects } from '@makaio/contracts';
import type { ConfigProvider } from '@makaio/providers';

/**
 * Keep only config-default entries for packages that will actually be loaded.
 * @param configDefaults - Combined descriptor defaults keyed by package name.
 * @param loadedPackageNames - Package names passed to `coordinator.load()`.
 * @returns Filtered defaults map aligned with the loaded package set.
 */
export function filterConfigDefaultsForLoadedPackages(
  configDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  loadedPackageNames: ReadonlySet<string>,
): Map<string, Readonly<Record<string, unknown>>> {
  const filtered = new Map<string, Readonly<Record<string, unknown>>>();

  for (const [packageName, defaults] of configDefaults) {
    if (loadedPackageNames.has(packageName)) {
      filtered.set(packageName, defaults);
    }
  }

  return filtered;
}

/**
 * Merge package config default maps while preserving per-package keys.
 *
 * Later maps override earlier values for the same package/key. This lets a
 * config or host layer supply defaults without replacing unrelated descriptor
 * defaults from the extension itself.
 * @param defaultsMaps - Config default maps ordered from lowest to highest precedence.
 * @returns Merged package config defaults.
 */
export function mergePackageConfigDefaults(
  ...defaultsMaps: ReadonlyArray<ReadonlyMap<string, Readonly<Record<string, unknown>>>>
): Map<string, Readonly<Record<string, unknown>>> {
  const merged = new Map<string, Readonly<Record<string, unknown>>>();

  for (const defaultsMap of defaultsMaps) {
    for (const [packageName, defaults] of defaultsMap) {
      merged.set(packageName, { ...(merged.get(packageName) ?? {}), ...defaults });
    }
  }

  return merged;
}

/**
 * Register boot-owned config handlers on the bus.
 * @param bus - Runtime bus.
 * @param configProvider - Runtime config provider that owns effective config resolution.
 * @returns Cleanup function for registered handlers.
 */
export function registerConfigHandlers(bus: IMakaioBus, configProvider: ConfigProvider): () => void {
  const cleanups = [
    bus.on(ConfigSubjects.get, async (ctx) => {
      const config = await configProvider.getConfig();
      ctx.setResult({ config });
    }),
    bus.on(ConfigSubjects.update, async (ctx) => {
      const config = ConfigSchema.parse(ctx.payload.config);
      const persistedConfig = await configProvider.prepareConfigForPersistence(config);
      await configProvider.saveConfig(persistedConfig);
      ctx.setResult({ success: true });
    }),
  ];

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
