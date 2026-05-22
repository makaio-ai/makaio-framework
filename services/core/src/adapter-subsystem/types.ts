import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';

/**
 * Loaded adapter file set keyed by adapter name.
 */
export interface AdapterFileConfigSet {
  /** Adapter file payloads keyed by canonical adapter name. */
  configs: Map<string, AdapterFile>;
}

/**
 * Loaded provider config file set keyed by provider config ID.
 */
export interface ProviderConfigFileSet {
  /** Provider config file payloads keyed by canonical provider config ID. */
  configs: Map<string, ProviderConfigFile>;
}

/**
 * Repository interface injected into the adapter subsystem service.
 */
export interface IAdapterConfigRepository {
  /**
   * Load all adapter files from the canonical config store.
   */
  loadAdapterConfigs(): Promise<AdapterFileConfigSet>;

  /**
   * Load all provider config files from the canonical config store.
   */
  loadProviderConfigs(): Promise<ProviderConfigFileSet>;

  /**
   * Persist a provider config file at the given canonical ID.
   * @param id - Canonical provider config ID
   * @param config - File payload to persist
   */
  writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void>;

  /**
   * Delete a provider config file by canonical ID.
   * @param id - Canonical provider config ID
   * @returns `true` when a file was removed
   */
  deleteProviderConfig(id: string): Promise<boolean>;

  /**
   * Persist an adapter file at the given canonical name.
   * @param name - Canonical adapter name
   * @param config - File payload to persist
   */
  writeAdapterFile(name: string, config: AdapterFile): Promise<void>;

  /**
   * Delete an adapter file by canonical name.
   * @param name - Canonical adapter name
   * @returns `true` when a file was removed
   */
  deleteAdapterFile(name: string): Promise<boolean>;
}
