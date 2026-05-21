import type { z } from 'zod';

/**
 * Parse raw extension config with a Zod schema, applying schema defaults.
 *
 * Handles the common extension initialization pattern where `ctx.config` may be
 * `undefined` (no stored config) or a partial object. The schema is expected
 * to provide defaults for all optional fields so that parsing `{}` always
 * yields a valid config.
 * @param schema - Zod schema with defaults for all optional fields.
 * @param rawConfig - Raw config value from {@link ExtensionContext.config} (may be undefined).
 * @returns Validated and defaulted config object.
 * @example
 * ```typescript
 * create: (ctx) => {
 *   const config = parseExtensionConfig(MyConfigSchema, ctx.config);
 *   return new MyService(ctx.bus, config);
 * },
 * ```
 */
export function parseExtensionConfig<T extends z.ZodType>(schema: T, rawConfig: unknown): z.infer<T> {
  return schema.parse(rawConfig ?? {}) as z.infer<T>;
}
