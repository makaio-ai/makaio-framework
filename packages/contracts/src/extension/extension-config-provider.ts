/**
 * Provider for persisted extension configuration and enablement state.
 *
 * Injected by the host composition root. When absent, all extensions start
 * enabled with default (Zod-schema) configuration only.
 */
export interface ExtensionConfigProvider {
  /**
   * Load persisted configuration for an extension by name.
   *
   * Returns `undefined` when no stored config exists for the extension.
   * Invalid values are ignored by the coordinator during schema parse.
   * @param name - Extension package name.
   * @returns Stored configuration object, or `undefined` when absent.
   */
  loadConfig(name: string): Record<string, unknown> | undefined;

  /**
   * Check whether an extension is enabled in persistent storage.
   *
   * Returns `undefined` to indicate no persisted preference — the coordinator
   * treats `undefined` the same as `true` (start normally).
   * @param name - Extension package name.
   * @returns `false` to skip the package at boot, `true` or `undefined` to start normally.
   */
  loadEnabled(name: string): boolean | undefined;
}
