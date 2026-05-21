/**
 * Storage interface for config persistence.
 *
 * Generic interface allowing type-safe implementations with different
 * config types. Simple file-based storage for bootstrap configuration.
 * @typeParam TConfig - Type for configuration (defaults to unknown)
 * @example Node.js file-based implementation
 * ```typescript
 * import type { Config } from '@makaio/contracts';
 *
 * class FileConfigStorage implements IConfigStorage<Config> {
 *   async getConfig(): Promise<Config> {
 *     const content = await fs.readFile('~/.makaio/config.json', 'utf-8');
 *     return ConfigSchema.parse(JSON.parse(content));
 *   }
 *
 *   async saveConfig(config: Config): Promise<void> {
 *     await fs.writeFile('~/.makaio/config.json', JSON.stringify(config, null, 2));
 *   }
 * }
 * ```
 * @example In-memory implementation for testing
 * ```typescript
 * class MemoryConfigStorage implements IConfigStorage<Config> {
 *   private config: Config = { mode: 'local', adapters: [] };
 *
 *   async getConfig() { return this.config; }
 *   async saveConfig(config: Config) { this.config = config; }
 * }
 * ```
 */
export interface IConfigStorage<TConfig = unknown> {
  /**
   * Get the current config, or default if missing.
   * @returns The config object
   */
  getConfig(): Promise<TConfig>;

  /**
   * Save the config.
   * @param config - The config object to save
   */
  saveConfig(config: TConfig): Promise<void>;
}
