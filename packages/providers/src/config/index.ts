import { merge } from 'merge-anything';
import { ConfigSchema, type Config, type RelayConfig } from '@makaio/contracts';
import { ConfigError, type IConfigStorage } from '@makaio/core';
import { normalizeBusSecret } from '@makaio/utils';

/**
 * Summarize a config-like object for diagnostics without leaking values.
 *
 * Validation errors should show shape/presence, not secrets.
 * @param value - Config-like object to summarize.
 * @returns Non-sensitive summary for logs.
 */
function summarizeConfigShape(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify({ present: value != null });
  }

  return JSON.stringify({
    present: true,
    keys: Object.keys(value),
  });
}

/**
 * Check whether a value is a plain object that can be traversed as config.
 * @param value - Value to inspect.
 * @returns True when the value is a non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compare two config leaf values for structural equality.
 * @param left - First value to compare.
 * @param right - Second value to compare.
 * @returns True when the values serialize to the same JSON representation.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Resolve schema defaults for an optional top-level config branch.
 * @param key - Top-level config key.
 * @returns Default branch value, or undefined when the schema does not accept an empty branch.
 */
function getDefaultBranchValue(key: string): unknown {
  const parsed = ConfigSchema.safeParse({ [key]: {} });
  if (!parsed.success) {
    return undefined;
  }

  return (parsed.data as Record<string, unknown>)[key];
}

/**
 * Remove values introduced only by environment overlays from an effective config.
 * @param effective - Effective config object being prepared for persistence.
 * @param env - Environment-derived overlay.
 * @param stored - Stored config object used to preserve intentional persisted values.
 * @param defaults - Schema defaults used to distinguish env-only values from default-only branches.
 * @returns Config object without environment-only values.
 */
function stripEnvironmentOnlyValues<T>(effective: T, env: unknown, stored: unknown, defaults: unknown): T {
  if (!isPlainObject(effective) || !isPlainObject(env)) {
    return effective;
  }

  const result: Record<string, unknown> = { ...effective };
  const storedObject = isPlainObject(stored) ? stored : {};
  const defaultObject = isPlainObject(defaults) ? defaults : {};

  for (const [key, envValue] of Object.entries(env)) {
    const effectiveValue = result[key];
    const storedValue = storedObject[key];
    const defaultValue = defaultObject[key] ?? getDefaultBranchValue(key);

    if (isPlainObject(effectiveValue) && isPlainObject(envValue)) {
      const child = stripEnvironmentOnlyValues(effectiveValue, envValue, storedValue, defaultValue);
      if (
        isPlainObject(child) &&
        storedValue === undefined &&
        (Object.keys(child).length === 0 || valuesEqual(child, defaultValue))
      ) {
        delete result[key];
      } else {
        result[key] = child;
      }
      continue;
    }

    if (valuesEqual(effectiveValue, envValue) && !valuesEqual(storedValue, envValue)) {
      delete result[key];
    }
  }

  return result as T;
}

/**
 * Abstract config provider that handles bootstrap-time config loading.
 *
 * Delegates storage operations to IConfigStorage, adding:
 * - Environment variable overrides
 * - Default config merging
 * - Validation via Zod schema
 *
 * Subclasses implement platform-specific concerns:
 * - getMachineId(): Persistent machine identifier
 * - getEnv(): Environment variable access
 * @example Node.js implementation
 * ```typescript
 * class NodeConfigProvider extends ConfigProvider {
 *   constructor(storage: IConfigStorage<Config>) {
 *     super(storage);
 *   }
 *
 *   async getMachineId(): Promise<string> {
 *     // Load or create machine identity from ~/.makaio/keys
 *   }
 *
 *   protected getEnv(key: string): string | undefined {
 *     return process.env[key];
 *   }
 * }
 * ```
 */
export abstract class ConfigProvider {
  /**
   * Create a ConfigProvider with the given storage backend.
   * @param storage - Storage implementation for persisting config
   */
  public constructor(protected readonly storage: IConfigStorage<Config>) {}

  /**
   * Get or create persistent machine identifier.
   * Platform-specific: derived from machine key files, keychain, registry, etc.
   * @returns Promise resolving to the unique machine identifier
   */
  public abstract getMachineId(): Promise<string>;

  /**
   * Get config with merge logic and validation.
   *
   * Merge order (later wins):
   * 1. Default config
   * 2. Stored config (from storage)
   * 3. Environment variables
   * 4. Programmatic overrides
   * @param overrides - Optional config overrides to apply
   * @returns Promise resolving to the validated runtime configuration
   */
  public async getConfig(overrides?: Partial<Config>): Promise<Config> {
    let sourceConfig: Config | undefined;
    let failedDuringLoad = false;

    try {
      failedDuringLoad = true;
      sourceConfig = await this.storage.getConfig();
      failedDuringLoad = false;
      const envConfig = this.loadEnvConfig();
      const merged = merge(this.getDefaultConfig(), sourceConfig ?? {}, envConfig, overrides ?? {}) as Config;
      return ConfigSchema.parse(merged);
    } catch (error) {
      console.error(
        '[ConfigProvider] Config resolution failed. Default config snapshot:',
        // Intentionally logs defaults only to avoid leaking env-derived secrets.
        JSON.stringify(this.getDefaultConfig(), null, 2),
      );
      console.error('[ConfigProvider] Source config shape:', summarizeConfigShape(sourceConfig));
      console.error('[ConfigProvider] Override shape:', summarizeConfigShape(overrides));
      throw new ConfigError(
        `${failedDuringLoad ? 'Failed to load config' : 'Config validation failed'}: ${error instanceof Error ? error.message : String(error)}`,
        failedDuringLoad ? 'runtime.config.load' : 'runtime.config.validation',
      );
    }
  }

  /**
   * Get persisted config with defaults applied, excluding environment and programmatic overrides.
   *
   * This represents the writable config surface, not the effective runtime view.
   * @returns Promise resolving to validated stored configuration with defaults.
   */
  public async getStoredConfig(): Promise<Config> {
    try {
      const stored = await this.storage.getConfig();
      return ConfigSchema.parse(merge(this.getDefaultConfig(), stored ?? {}));
    } catch (error) {
      throw new ConfigError(
        `Failed to load stored config: ${error instanceof Error ? error.message : String(error)}`,
        'runtime.config.load',
      );
    }
  }

  /**
   * Get config values derived from environment variables.
   *
   * The returned object is a partial config overlay and must not be persisted
   * directly as user config.
   * @returns Partial config derived from environment variables.
   */
  public getEnvironmentConfig(): Partial<Config> {
    return this.loadEnvConfig();
  }

  /**
   * Remove environment-only values from an effective config snapshot before persistence.
   *
   * Values that already exist in stored config are preserved, even if they match
   * the current environment. Values introduced only by environment overrides are
   * omitted so a settings UI cannot accidentally write secrets or host-specific
   * URLs into `config.json`.
   * @param config - Effective config proposed for persistence.
   * @returns Sanitized config suitable for `saveConfig()`.
   */
  public async prepareConfigForPersistence(config: Config): Promise<Config> {
    const stored = await this.getStoredConfig();
    const envConfig = this.getEnvironmentConfig();
    const parsed = ConfigSchema.parse(config);
    const sanitized = stripEnvironmentOnlyValues(parsed, envConfig, stored, this.getDefaultConfig());
    if (envConfig.bus?.remote?.url !== undefined && stored.bus?.remote?.url === undefined) {
      delete sanitized.bus;
    }
    return ConfigSchema.parse(sanitized);
  }

  /**
   * Save config to storage.
   * @param config - The runtime configuration to save
   * @returns Promise that resolves when config is saved
   */
  public async saveConfig(config: Config): Promise<void> {
    try {
      const validated = ConfigSchema.parse(config);
      await this.storage.saveConfig(validated);
    } catch (error) {
      throw new ConfigError(
        `Failed to save config: ${error instanceof Error ? error.message : String(error)}`,
        'runtime.config.save',
      );
    }
  }

  // --- Shared helpers (can be overridden) ---

  /**
   * Get environment variable value.
   * Default returns undefined (browser/mobile might not have env vars).
   * @param _key - The environment variable name
   * @returns The environment variable value or undefined
   */
  protected getEnv(_key: string): string | undefined {
    // Default: no env (browser/mobile might not have them)
    return undefined;
  }

  /**
   * Load config from environment variables.
   * @returns Partial config from environment
   */
  protected loadEnvConfig(): Partial<Config> {
    const mode = this.getEnv('MAKAIO_MODE') as Config['mode'] | undefined;
    const busUrl = this.getEnv('MAKAIO_BUS_URL');
    const rawBusSecret = this.getEnv('MAKAIO_BUS_SECRET');
    const busSecret = normalizeBusSecret(rawBusSecret);
    if (busSecret !== undefined && !busUrl) {
      throw new Error('MAKAIO_BUS_SECRET requires MAKAIO_BUS_URL');
    }
    const relayUrl = this.getEnv('MAKAIO_RELAY_URL');

    const config: Partial<Config> = {
      ...(mode && { mode }),
      ...(busUrl && {
        bus: {
          remote: {
            url: busUrl,
            ...(busSecret && { secret: busSecret }),
          },
        },
      }),
    };

    if (relayUrl) {
      config.relay = {
        url: relayUrl,
      } as RelayConfig;
    }

    return config;
  }

  /**
   * Get default runtime configuration.
   * @returns Default config values
   */
  protected getDefaultConfig(): Config {
    return {
      $schema: 'makaio/config/v1',
      mode: 'local',
      role: 'main-dev-machine',
    };
  }
}
