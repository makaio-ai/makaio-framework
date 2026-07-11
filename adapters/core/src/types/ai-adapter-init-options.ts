import type { LogImportConfig } from '../log-importer/registry-types.js';
import type { AdapterProviderDefinition } from './provider-definition.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';

/**
 * Platform-provided defaults injected by the runtime.
 * These are the lowest priority and will be overridden by request-level values.
 */
export interface PlatformDefaults {
  /** Default working directory for agent execution (e.g., os.tmpdir() on Node.js) */
  cwd?: string;
  /** Default environment variables */
  env?: Record<string, string>;
}

/**
 * Initialization options for `AIAdapter.init()`.
 * @example
 * ```typescript
 * await adapter.init({
 *   defaultModel: "claude-3.5-sonnet",
 *   providerOptions: { baseUrl: "https://api.example.com" }
 * });
 * ```
 * @see {@link AIAdapterPromptOptions} for per-message config
 * @see [Creating Adapters Guide](../../docs/creating-adapters.md)
 */
export interface AIAdapterInitOptions {
  /** Default model when not specified per-message. Provider-specific identifier. */
  defaultModel?: string;

  /** Provider-specific non-secret config (base URLs, defaults, etc.). Type explicitly in adapter implementations. */
  providerOptions?: unknown;

  adapterId?: string;

  /**
   * Platform-provided defaults (cwd, env, etc.).
   * Lowest priority - overridden by request values.
   * Injected by runtime during adapter initialization.
   */
  platformDefaults?: PlatformDefaults;

  /**
   * Log import configuration for external session imports.
   */
  logImport?: LogImportConfig;

  /**
   * Provider definitions from the adapter definition.
   * Contains provider definitions with available models for context window lookup.
   * Injected by runtime during adapter initialization.
   */
  definitionProviders?: AdapterProviderDefinition[];

  /** Client identifier for the application this adapter belongs to (e.g., 'claude-code', 'codex'). Omit for API-only adapters. */
  clientId?: string;
  /** Trusted non-serializable normalized auth preparer injected by the host. */
  prepareAuthRuntime?: AdapterAuthRuntimePreparer;
}
