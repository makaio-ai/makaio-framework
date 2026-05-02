import type { z } from 'zod';

/**
 * Resolve config for a package by merging descriptor defaults with stored
 * config and parsing through the package's configSchema.
 *
 * Non-fatal: parse failure logs a warning and falls back to parsing `{}` so
 * the package starts with Zod schema `.default()` values. Returns `undefined`
 * if no schema is provided or if both parse attempts fail.
 * @param name - Package name used in log messages.
 * @param configSchema - Zod schema declared on the package's manifest, or
 *   `undefined` when the package has no config schema. Returns `undefined`
 *   immediately in that case.
 * @param configDefaults - Default config values from descriptor.json. Merged
 *   as the base layer underneath stored values.
 * @param storedConfig - User-persisted config loaded from storage. Takes
 *   precedence over `configDefaults`.
 * @returns Parsed config object, or `undefined` if no schema or both parse
 *   attempts fail.
 */
export function resolveConfig(
  name: string,
  configSchema: z.ZodType | undefined,
  configDefaults: Readonly<Record<string, unknown>> | undefined,
  storedConfig: Record<string, unknown> | undefined,
): unknown {
  if (!configSchema) return undefined;

  const merged = { ...(configDefaults ?? {}), ...(storedConfig ?? {}) };

  try {
    return configSchema.parse(merged);
  } catch (err) {
    console.warn(
      `[ExtensionCoordinator] Config parse failed for "${name}", starting with schema defaults:`,
      err instanceof Error ? err.message : err,
    );
    try {
      return configSchema.parse({});
    } catch {
      console.warn(`[ExtensionCoordinator] Fallback config parse also failed for "${name}" — config will be absent`);
      return undefined;
    }
  }
}
