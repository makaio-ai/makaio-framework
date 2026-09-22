import type { IMakaioBus } from '@makaio/bus-core';
import { ConfigSchema, ConfigSubjects } from '@makaio/contracts';
import type { ConfigProvider } from '@makaio/providers';
import { summarizeDiagnosticText } from '@makaio/utils';

/**
 * Keep only config-default entries for packages that will actually be loaded.
 *
 * Dropped names are reported in one diagnostic rather than discarded silently.
 * These defaults are the weakest layer of the extension configuration chain, so
 * a name that never reaches `coordinator.load()` — because the extension is
 * disabled, ineligible for the running surface, or simply misspelled in a
 * `makaio.config.*` file — means values an operator believes are in effect are
 * not. Boot is unaffected either way; the entry has nothing to apply to.
 * @param configDefaults - Combined descriptor defaults keyed by package name.
 * @param loadedPackageNames - Package names passed to `coordinator.load()`.
 * @returns Filtered defaults map aligned with the loaded package set.
 */
export function filterConfigDefaultsForLoadedPackages(
  configDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  loadedPackageNames: ReadonlySet<string>,
): Map<string, Readonly<Record<string, unknown>>> {
  const filtered = new Map<string, Readonly<Record<string, unknown>>>();
  const dropped: string[] = [];

  for (const [packageName, defaults] of configDefaults) {
    if (loadedPackageNames.has(packageName)) {
      filtered.set(packageName, defaults);
    } else {
      dropped.push(packageName);
    }
  }

  if (dropped.length > 0) {
    // Package names reach here from descriptors and config files, so they are
    // operator-authored text on a log line, not identifiers this runtime minted.
    const names = dropped.map((packageName) => summarizeDiagnosticText(packageName)).join(', ');
    console.warn(`[boot] Package config defaults have no loaded package and were dropped: ${names}`);
  }

  return filtered;
}

/**
 * Merge package config default maps while preserving per-package keys.
 *
 * Later maps override earlier values for the same package/key. This lets a
 * config or host layer supply defaults without replacing unrelated descriptor
 * defaults from the extension itself.
 *
 * This is the single merge rule for this layer. Every composition root — the
 * runtime boot sequence, the CLI's `makaio.config.*` overlay, and the desktop
 * hosts' overlay — routes through it, so the documented precedence chain
 * (descriptor defaults, then host and config-file defaults, then stored
 * records, then the operator layer) holds identically on every path.
 * @param defaultsMaps - Config default maps ordered from lowest to highest
 *   precedence. `undefined` stands for an absent layer and is skipped, so a
 *   caller holding an optional map does not have to substitute an empty one.
 * @returns Merged package config defaults.
 */
export function mergePackageConfigDefaults(
  ...defaultsMaps: ReadonlyArray<ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined>
): Map<string, Readonly<Record<string, unknown>>> {
  const merged = new Map<string, Readonly<Record<string, unknown>>>();

  for (const defaultsMap of defaultsMaps) {
    if (defaultsMap === undefined) continue;
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
